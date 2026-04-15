// backend/index.js — McLarens Nexus Enterprise v5.0
// Cloudflare Worker API Gateway — Insurer-First Architecture
// Includes: WebSocket, Cron, GPT-4 Vision OCR, Resend Email, Twilio SMS

import { generateToken, verifyToken, hashPassword, verifyPassword, generateSecureToken,
         sendMagicLink, verifyGoogleToken, createSession, destroySession } from './auth.js';
import { hasPermission, canAccessResource, filterByTenant,
         getVisibleModules, getRestrictedModules } from './rbac.js';
import { handleChatRequest, extractTextFromImage,
         detectWarrantyBreaches, crossVerifyDocuments,
         computeSettlementFromRules, generateReportDraft } from './openai-chat.js';
import { sendEmail, sendSMS,
         buildPendingDocReminderEmail, buildPendingDocReminderSMS,
         buildStatusChangeEmail, buildBreachAlertEmail } from './notifications.js';
import { INSURERS, IRDAI_FALLBACK } from './seed-insurers.js';


// ── Helpers ────────────────────────────────────────────────────────────────
function generateUUID() { return crypto.randomUUID(); }
function getClientIP(req) {
  return req.headers.get('CF-Connecting-IP') ||
         req.headers.get('X-Forwarded-For')?.split(',')[0] || 'unknown';
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-ID'
    }
  });
}
function errorResponse(msg, status = 400) { return jsonResponse({ error: msg }, status); }

async function auditLog(env, tenantId, userId, action, resource, resourceId, ip,
                        oldData = null, newData = null) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id,tenant_id,user_id,action,resource,resource_id,
                             old_data,new_data,ip_address,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(generateUUID(), tenantId, userId, action, resource, resourceId,
         oldData ? JSON.stringify(oldData) : null,
         newData ? JSON.stringify(newData) : null,
         ip, Date.now()).run();
}

// ── Durable Object for Real-time WebSocket ────────────────────────────────
export class NexusRealtimeHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const { tenantId, event, data } = await request.json();
      for (const [userId, ws] of this.sessions) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ event, data, timestamp: Date.now() }));
        }
      }
      return new Response('OK', { status: 200 });
    }
    
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const userId = url.searchParams.get('userId');
      const tenantId = url.searchParams.get('tenantId');
      
      this.sessions.set(userId, server);
      
      server.accept();
      server.addEventListener('close', () => {
        this.sessions.delete(userId);
      });
      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ping') {
            server.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } catch (e) {}
      });
      
      server.send(JSON.stringify({ 
        type: 'connected', 
        userId, 
        tenantId, 
        timestamp: Date.now() 
      }));
      
      return new Response(null, { status: 101, webSocket: client });
    }
    
    return new Response('Not found', { status: 404 });
  }
}

// ── Broadcast via Durable Object ─────────────────────────────────────────
async function broadcastUpdate(env, tenantId, event, data) {
  try {
    if (!env.REALTIME_HUB) return;
    const doId = env.REALTIME_HUB.idFromName(tenantId);
    const stub = env.REALTIME_HUB.get(doId);
    await stub.fetch('http://internal/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, event, data })
    });
  } catch (e) { console.warn('[WS] Broadcast failed:', e.message); }
}

// ── IRDAI Documents ──────────────────────────────────────────────
const IRDAI_DOCS = {
  fire:        ['FIR Copy','Fire Brigade Report','Stock Register','Purchase Invoices',
                'Claim Form','Surveyor Report','Photographs (min 10)'],
  burglary:    ['FIR Copy','Final Police Report','Stock Register','Purchase Invoices',
                'Security Guard Statement','Claim Form','Spot Photographs'],
  motor:       ['RC Copy','Driving License','Repair Invoice','Spot Photographs','Claim Form'],
  marine:      ['Bill of Lading','Survey Report','Commercial Invoice','Packing List',
                'Claim Form','Insurance Certificate'],
  engineering: ['Contract Document','Inspection Certificate','Damage Survey Report',
                'Repair Estimate','Claim Form'],
  misc:        ['Claim Form','Supporting Documents','Survey Report']
};

// ── Cron: pending doc auto-reminders ─────────────────────────────────────
async function runPendingDocReminders(env) {
  const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const dueDocs = await env.DB.prepare(
    `SELECT pd.*, c.claim_number, c.insured_name, c.insured_email, c.insured_phone,
            c.surveyor_id, c.tenant_id, ic.name AS insurer_name, ic.claims_dept_email
     FROM pending_documents pd
     JOIN claims c ON pd.claim_id = c.id
     JOIN insurance_companies ic ON pd.insurer_id = ic.id
     WHERE pd.status = 'pending'
     AND (pd.last_reminder_sent IS NULL OR pd.last_reminder_sent < ?)
     ORDER BY pd.claim_id, pd.is_mandatory DESC`
  ).bind(now - TWO_DAYS_MS).all();

  if (!dueDocs.results?.length) return { sent: 0 };

  const byClaim = {};
  for (const doc of dueDocs.results) {
    if (!byClaim[doc.claim_id]) {
      byClaim[doc.claim_id] = {
        claimNumber: doc.claim_number, insuredName: doc.insured_name,
        insuredEmail: doc.insured_email, insuredPhone: doc.insured_phone,
        insurerName: doc.insurer_name, insurerEmail: doc.claims_dept_email,
        surveyorId: doc.surveyor_id, tenantId: doc.tenant_id, docs: []
      };
    }
    byClaim[doc.claim_id].docs.push(doc);
  }

  let totalSent = 0;
  for (const [claimId, info] of Object.entries(byClaim)) {
    const reminderCount = Math.max(...info.docs.map(d => d.reminder_count || 0)) + 1;
    let surveyorName = 'McLarens Survey Team';
    if (info.surveyorId) {
      const s = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(info.surveyorId).first();
      if (s) surveyorName = s.name;
    }

    const emailHtml = buildPendingDocReminderEmail({
      claimNumber: info.claimNumber, insuredName: info.insuredName,
      insurerName: info.insurerName, pendingDocs: info.docs,
      reminderCount, surveyorName
    });
    const smsBody = buildPendingDocReminderSMS({
      claimNumber: info.claimNumber, pendingCount: info.docs.length,
      insurerName: info.insurerName, reminderCount
    });

    if (info.insuredEmail) {
      await sendEmail(env, { to: info.insuredEmail,
        subject: `[Reminder #${reminderCount}] Documents Pending — Claim ${info.claimNumber}`,
        html: emailHtml });
    }
    if (info.insuredPhone) await sendSMS(env, { to: info.insuredPhone, body: smsBody });
    if (info.insurerEmail) {
      await sendEmail(env, { to: info.insurerEmail,
        subject: `[CC] Claim ${info.claimNumber} — ${info.docs.length} docs pending (Reminder #${reminderCount})`,
        html: emailHtml });
    }

    for (const doc of info.docs) {
      await env.DB.prepare(
        'UPDATE pending_documents SET reminder_count=reminder_count+1, last_reminder_sent=?, updated_at=? WHERE id=?'
      ).bind(now, now, doc.id).run();
      if (info.surveyorId && info.tenantId) {
        await env.DB.prepare(
          `INSERT INTO notifications (id,tenant_id,user_id,title,message,type,channel,link,sent_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(generateUUID(), info.tenantId, info.surveyorId,
          `📋 Doc Reminder #${reminderCount}: ${doc.document_name}`,
          `Claim ${info.claimNumber}: "${doc.document_name}" pending. Email+SMS sent.`,
          'warning', 'in_app', `/surveyor-dashboard.html?claim=${claimId}`, now, now).run();
      }
    }
    totalSent++;
  }
  console.log(`[Cron] Reminders sent for ${totalSent} claims`);
  return { sent: totalSent };
}

// ── Main Worker ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const clientIP  = getClientIP(request);
    const userAgent = request.headers.get('User-Agent') || 'unknown';

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant-ID',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const publicRoutes = [
      '/api/auth/login','/api/auth/signup','/api/auth/google',
      '/api/auth/magic-link','/api/auth/verify-magic','/api/health',
      '/api/auth/forgot-password','/api/auth/reset-password'
    ];

    let user = null; let sessionToken = null;
    if (!publicRoutes.includes(path) && !path.startsWith('/api/public/')) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader) return errorResponse('Unauthorized: No token', 401);
      sessionToken = authHeader.split(' ')[1];
      if (!sessionToken) return errorResponse('Unauthorized: Bad token format', 401);
      user = await verifyToken(sessionToken, env.JWT_SECRET);
      if (!user) return errorResponse('Unauthorized: Invalid or expired token', 401);
      // Normalize: JWT stores tenant_id but code uses tenantId — fix both
      user.tenantId = user.tenantId || user.tenant_id;
      user.id       = user.id       || user.userId;
      const session = await env.DB.prepare(
        'SELECT * FROM sessions WHERE id = ? AND expires_at > ?'
      ).bind(sessionToken, Date.now()).first();
      if (!session) return errorResponse('Unauthorized: Session expired', 401);
    }

    try {
      // ────────── HEALTH ──────────────────────────────────────────────────
      if (path === '/api/health' && method === 'GET')
        return jsonResponse({ status: 'healthy', version: '5.0', timestamp: Date.now() });

      // ════════════════════════════════════════════════════════════════════
      // AUTH ROUTES
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/auth/signup' && method === 'POST') {
        const { email, password, name, tenantName, role, phone, department } =
          await request.json();
        if (!email || !password || !name)
          return errorResponse('Email, password and name required');
        
        const existing = await env.DB.prepare('SELECT id FROM users WHERE email=?')
          .bind(email).first();
        if (existing) return errorResponse('User already exists', 409);

        const tenantId = generateUUID();
        await env.DB.prepare(
          'INSERT INTO tenants (id,name,subscription_tier,settings,created_at) VALUES (?,?,?,?,?)'
        ).bind(tenantId, tenantName || `${name}'s Organization`, 'basic',
               JSON.stringify({ theme: 'dark' }), Date.now()).run();

        // FIXED: Using hashPassword from auth.js
        const { hash, salt: saltHex } = await hashPassword(password);

        const userId = generateUUID();
        const userRole = role || 'admin';
        await env.DB.prepare(
          `INSERT INTO users (id,email,name,role,tenant_id,password_hash,password_salt,
                              phone,department,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(userId, email, name, userRole, tenantId, hash, saltHex,
               phone||null, department||null, Date.now()).run();

        const empId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO employees (id,user_id,tenant_id,employee_code,name,email,phone,
                                  department,designation,status,joining_date,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(empId, userId, tenantId, `EMP${Date.now()}`, name, email,
               phone||null, department||'Administration','Administrator',
               'active', Date.now(), Date.now()).run();

        const token = await generateToken({ id:userId, email, role:userRole, tenant_id:tenantId }, env.JWT_SECRET);
        
        await createSession(userId, token, env, clientIP, userAgent);

        await auditLog(env, tenantId, userId, 'user_signup', 'users', userId, clientIP);
        return jsonResponse({ success:true, token, user:{ id:userId, email, name, role:userRole, tenantId }});
      }

      if (path === '/api/auth/login' && method === 'POST') {
  const { email, password } = await request.json();
  if (!email || !password) return errorResponse('Email and password required');
  const rec = await env.DB.prepare('SELECT * FROM users WHERE email=?').bind(email).first();
  if (!rec) return errorResponse('Invalid credentials', 401);
  if (!rec.is_active) return errorResponse('Account disabled', 401);

  // Verify password — dual hash support above
  
  // Verify password — supports both hash formats:
  // 1. base64url (auth.js hashPassword — all new accounts)
  // 2. hex (legacy seed.js format)
  let passwordValid = false;
  if (rec.password_hash && rec.password_salt) {
    try { passwordValid = await verifyPassword(password, rec.password_hash, rec.password_salt); } catch {}
    if (!passwordValid) {
      try {
        const enc2 = new TextEncoder();
        const hBuf = await crypto.subtle.digest('SHA-256', enc2.encode(password + rec.password_salt));
        const hex  = Array.from(new Uint8Array(hBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
        if (hex === rec.password_hash) {
          passwordValid = true;
          // Migrate to base64url on next successful login
          const { hash: nh, salt: ns } = await hashPassword(password);
          await env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').bind(nh,ns,Date.now(),rec.id).run();
        }
      } catch {}
    }
  }
  if (!passwordValid) {
    return errorResponse('Invalid credentials', 401);
  }

  await env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(Date.now(), rec.id).run();
  const token = await generateToken({ id: rec.id, email: rec.email, role: rec.role, tenant_id: rec.tenant_id }, env.JWT_SECRET);
  await createSession(rec.id, token, env, clientIP, userAgent);
  
  const emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id=?').bind(rec.id).first();
  return jsonResponse({ success: true, token,
    user: { id: rec.id, email: rec.email, name: rec.name, role: rec.role, tenantId: rec.tenant_id, employeeId: emp?.id }
  });
}

      if (path === '/api/auth/logout' && method === 'POST') {
        if (sessionToken) await destroySession(sessionToken, env);
        return jsonResponse({ success:true });
      }

      // ── Google OAuth Login / Sign-Up ───────────────────────────────────
      // Receives a Google ID-token from the frontend (Google Identity Services),
      // verifies its signature using Google's public keys, then finds or creates
      // the user account and returns a session JWT.
      if (path === '/api/auth/google' && method === 'POST') {
        const body = await request.json();
        const idToken = body.id_token || body.credential;
        if (!idToken) return errorResponse('id_token is required', 400);

        const clientId = env.GOOGLE_CLIENT_ID;
        if (!clientId) return errorResponse('Google OAuth not configured on server', 503);

        // Verify the Google ID token against Google's public keys
        const googleUser = await verifyGoogleToken(idToken, clientId);
        if (!googleUser) return errorResponse('Invalid Google token — verification failed', 401);

        if (!googleUser.verified) {
          return errorResponse('Google account email is not verified', 401);
        }

        // Check if user already exists (by Google ID or email)
        let rec = await env.DB.prepare(
          'SELECT * FROM users WHERE google_id=? OR email=?'
        ).bind(googleUser.googleId, googleUser.email).first();

        if (rec) {
          // Existing user — update Google ID if not already set
          if (!rec.google_id) {
            await env.DB.prepare(
              'UPDATE users SET google_id=?, avatar_url=?, updated_at=? WHERE id=?'
            ).bind(googleUser.googleId, googleUser.picture||null, Date.now(), rec.id).run();
          }
          await env.DB.prepare(
            'UPDATE users SET last_login=? WHERE id=?'
          ).bind(Date.now(), rec.id).run();

          const token = await generateToken(
            { id: rec.id, email: rec.email, role: rec.role, tenant_id: rec.tenant_id },
            env.JWT_SECRET
          );
          await createSession(rec.id, token, env, clientIP, userAgent);
          await auditLog(env, rec.tenant_id, rec.id, 'google_login', 'users', rec.id, clientIP);

          const emp = await env.DB.prepare(
            'SELECT * FROM employees WHERE user_id=?'
          ).bind(rec.id).first();

          return jsonResponse({
            success: true, token,
            user: {
              id:         rec.id,
              email:      rec.email,
              name:       rec.name,
              role:       rec.role,
              tenantId:   rec.tenant_id,
              employeeId: emp?.id,
              avatar:     googleUser.picture
            }
          });
        }

        // New user — create tenant + user + employee records
        const tenantId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO tenants (id,name,subscription_tier,settings,created_at)
           VALUES (?,?,?,?,?)`
        ).bind(
          tenantId,
          `${googleUser.name}'s Organization`,
          'basic',
          JSON.stringify({ theme: 'dark' }),
          Date.now()
        ).run();

        const userId   = generateUUID();
        const userRole = 'admin';
        await env.DB.prepare(
          `INSERT INTO users
           (id,email,name,role,tenant_id,google_id,avatar_url,email_verified,created_at)
           VALUES (?,?,?,?,?,?,?,1,?)`
        ).bind(
          userId, googleUser.email, googleUser.name,
          userRole, tenantId, googleUser.googleId,
          googleUser.picture || null, Date.now()
        ).run();

        const empId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO employees
           (id,user_id,tenant_id,employee_code,name,email,department,designation,status,joining_date,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          empId, userId, tenantId,
          `EMP${Date.now()}`,
          googleUser.name, googleUser.email,
          'Administration', 'Administrator', 'active',
          Date.now(), Date.now()
        ).run();

        const token = await generateToken(
          { id: userId, email: googleUser.email, role: userRole, tenant_id: tenantId },
          env.JWT_SECRET
        );
        await createSession(userId, token, env, clientIP, userAgent);
        await auditLog(env, tenantId, userId, 'google_signup', 'users', userId, clientIP);

        return jsonResponse({
          success: true, token,
          user: {
            id:         userId,
            email:      googleUser.email,
            name:       googleUser.name,
            role:       userRole,
            tenantId,
            employeeId: empId,
            avatar:     googleUser.picture
          }
        });
      }

      // ── Passwordless Magic Link — Request ─────────────────────────────
      // User supplies their email; we generate a secure token, store it,
      // and send an email with a clickable link that auto-logs them in.
      if (path === '/api/auth/magic-link' && method === 'POST') {
        const body = await request.json();
        const email = (body.email || '').toLowerCase().trim();
        if (!email) return errorResponse('Email is required', 400);

        // Check user exists — we do NOT reveal whether the email exists (security)
        const rec = await env.DB.prepare(
          'SELECT id FROM users WHERE email=?'
        ).bind(email).first();

        // Always return success to prevent email enumeration attacks
        if (!rec) {
          // Still return success — do not reveal that email doesn't exist
          return jsonResponse({
            success: true,
            message: 'If this email is registered, a login link has been sent.'
          });
        }

        // Generate a cryptographically secure token
        const token = generateSecureToken(32);

        // Store token + 15-minute expiry, then send email
        const link = await sendMagicLink(email, token, env);

        await auditLog(env, '', rec.id, 'magic_link_requested', 'users', rec.id, clientIP);

        return jsonResponse({
          success: true,
          message: 'If this email is registered, a login link has been sent.',
          // In development/test mode without Resend configured, return the link for testing
          ...((!env.RESEND_API_KEY) ? { dev_link: link } : {})
        });
      }

      // ── Passwordless Magic Link — Verify ──────────────────────────────
      // User clicks the link in their email; the token + email are submitted here.
      // If valid and not expired, we return a JWT session token.
      if (path === '/api/auth/verify-magic' && method === 'POST') {
        const body  = await request.json();
        const token = (body.token || '').trim();
        const email = (body.email || '').toLowerCase().trim();

        if (!token || !email) {
          return errorResponse('token and email are required', 400);
        }

        // Find user with matching magic link token and email
        const rec = await env.DB.prepare(
          `SELECT * FROM users
           WHERE email=?
           AND magic_link_token=?
           AND magic_link_expires > ?
           AND is_active=1`
        ).bind(email, token, Date.now()).first();

        if (!rec) {
          return errorResponse(
            'Magic link is invalid or has expired. Please request a new one.',
            401
          );
        }

        // Invalidate the token immediately (single-use)
        await env.DB.prepare(
          `UPDATE users
           SET magic_link_token=NULL, magic_link_expires=NULL,
               email_verified=1, last_login=?, updated_at=?
           WHERE id=?`
        ).bind(Date.now(), Date.now(), rec.id).run();

        const jwtToken = await generateToken(
          { id: rec.id, email: rec.email, role: rec.role, tenant_id: rec.tenant_id },
          env.JWT_SECRET
        );
        await createSession(rec.id, jwtToken, env, clientIP, userAgent);

        const emp = await env.DB.prepare(
          'SELECT * FROM employees WHERE user_id=?'
        ).bind(rec.id).first();

        await auditLog(env, rec.tenant_id, rec.id, 'magic_link_login', 'users', rec.id, clientIP);

        return jsonResponse({
          success: true,
          token:   jwtToken,
          user: {
            id:         rec.id,
            email:      rec.email,
            name:       rec.name,
            role:       rec.role,
            tenantId:   rec.tenant_id,
            employeeId: emp?.id
          }
        });
      }

      // ── Forgot Password (email-based reset) ───────────────────────────
      if (path === '/api/auth/forgot-password' && method === 'POST') {
        const body = await request.json();
        const email = (body.email || '').toLowerCase().trim();
        if (!email) return errorResponse('Email is required', 400);

        const rec = await env.DB.prepare(
          'SELECT id FROM users WHERE email=? AND is_active=1'
        ).bind(email).first();

        // Always return success regardless of whether email exists
        if (rec) {
          const resetToken = generateSecureToken(32);
          const expires    = Date.now() + 60 * 60 * 1000; // 1 hour

          await env.DB.prepare(
            'UPDATE users SET magic_link_token=?, magic_link_expires=? WHERE id=?'
          ).bind(resetToken, expires, rec.id).run();

          // Reuse magic link email infrastructure for password reset
          const frontendBase = env.FRONTEND_URL || 'https://ab-nexus-enterprise.pages.dev';
          const resetLink = `${frontendBase}/index.html?reset=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(email)}`;

          if (env.RESEND_API_KEY) {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from:    env.RESEND_FROM || 'AB Nexus <noreply@abenterprise.online>',
                to:      [email],
                subject: 'Reset your AB Nexus password',
                html: `<p>Click below to reset your password (expires in 1 hour):</p>
                       <p><a href="${resetLink}" style="background:#e8a020;color:#000;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Reset Password</a></p>
                       <p style="color:#888;font-size:12px;">If you did not request this, ignore this email.</p>`
              })
            }).catch(() => {});
          }
        }

        return jsonResponse({
          success: true,
          message: 'If that email is registered, a password reset link has been sent.'
        });
      }

      // ── Reset Password ─────────────────────────────────────────────────
      if (path === '/api/auth/reset-password' && method === 'POST') {
        const body = await request.json();
        const { token, email, new_password } = body;
        if (!token || !email || !new_password) {
          return errorResponse('token, email, and new_password are required', 400);
        }
        if (new_password.length < 8) {
          return errorResponse('Password must be at least 8 characters', 400);
        }

        const rec = await env.DB.prepare(
          'SELECT * FROM users WHERE email=? AND magic_link_token=? AND magic_link_expires > ?'
        ).bind(email.toLowerCase().trim(), token, Date.now()).first();

        if (!rec) {
          return errorResponse('Reset link is invalid or has expired', 401);
        }

        const { hash, salt } = await hashPassword(new_password);
        await env.DB.prepare(
          `UPDATE users
           SET password_hash=?, password_salt=?,
               magic_link_token=NULL, magic_link_expires=NULL,
               updated_at=?
           WHERE id=?`
        ).bind(hash, salt, Date.now(), rec.id).run();

        await auditLog(env, rec.tenant_id, rec.id, 'password_reset', 'users', rec.id, clientIP);
        return jsonResponse({ success: true, message: 'Password updated. You can now sign in.' });
      }

      if (path === '/api/auth/me' && method === 'GET') {
        if (!user || !user.id) {
          return errorResponse('Unauthorized: User not found', 401);
        }

        const rec = await env.DB.prepare(
          'SELECT id, email, name, role, tenant_id, created_at FROM users WHERE id = ?'
        ).bind(user.id).first();

        if (!rec) {
          return errorResponse('User record not found', 404);
        }

        let emp = null;
        try {
          emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id = ?').bind(user.id).first();
        } catch (e) {
          console.warn('Employee fetch failed:', e.message);
        }

        let tenant = null;
        try {
          tenant = await env.DB.prepare('SELECT * FROM tenants WHERE id = ?').bind(rec.tenant_id).first();
        } catch (e) {
          console.warn('Tenant fetch failed:', e.message);
        }

        return jsonResponse({
          user: rec,
          employee: emp,
          tenant: tenant,
          visibleModules: getVisibleModules(rec.role),
          restrictedModules: getRestrictedModules(rec.role)
        });
      }

      // ════════════════════════════════════════════════════════════════════
      // INSURANCE COMPANIES
      // ════════════════════════════════════════════════════════════════════

      if (path === '/api/insurers' && method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT * FROM insurance_companies WHERE tenant_id=? AND is_active=1 ORDER BY name'
        ).bind(user.tenantId).all();
        return jsonResponse({ insurers: rows.results });
      }

      if (path === '/api/insurers' && method === 'POST') {
        if (!hasPermission(user.role, 'admin'))
          return errorResponse('Admin access required', 403);
        const d = await request.json();
        if (!d.name || !d.code) return errorResponse('Name and code required');
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO insurance_companies
           (id,tenant_id,name,code,irdai_license,has_custom_guidelines,guideline_version,
            claims_dept_email,claims_dept_phone,portal_url,is_active,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`
        ).bind(id, user.tenantId, d.name, d.code.toUpperCase(), d.irdai_license||null,
               d.has_custom_guidelines??1, d.guideline_version||'1.0',
               d.claims_dept_email||null, d.claims_dept_phone||null,
               d.portal_url||null, Date.now()).run();
        await auditLog(env, user.tenantId, user.id, 'insurer_created', 'insurance_companies', id, clientIP);
        return jsonResponse({ success:true, id });
      }

      if (path.match(/^\/api\/insurers\/[^\/]+$/) && method === 'GET') {
        const insId = path.split('/').pop();
        const ins = await env.DB.prepare(
          'SELECT * FROM insurance_companies WHERE id=? AND tenant_id=?'
        ).bind(insId, user.tenantId).first();
        if (!ins) return errorResponse('Insurer not found', 404);
        const rules = await env.DB.prepare(
          'SELECT * FROM insurer_department_rules WHERE insurer_id=?'
        ).bind(insId).all();
        return jsonResponse({ insurer:ins, rules:rules.results });
      }

      if (path.match(/^\/api\/insurers\/[^\/]+$/) && method === 'PUT') {
        if (!hasPermission(user.role, 'admin')) return errorResponse('Admin required', 403);
        const insId = path.split('/').pop();
        const d = await request.json();
        const fields = []; const vals = [];
        const allowed = ['name','code','irdai_license','has_custom_guidelines','guideline_version',
                         'claims_dept_email','claims_dept_phone','portal_url','is_active'];
        for (const k of allowed) {
          if (d[k] !== undefined) { fields.push(`${k}=?`); vals.push(d[k]); }
        }
        if (!fields.length) return errorResponse('No valid fields to update');
        fields.push('updated_at=?'); vals.push(Date.now()); vals.push(insId); vals.push(user.tenantId);
        await env.DB.prepare(`UPDATE insurance_companies SET ${fields.join(',')} WHERE id=? AND tenant_id=?`)
          .bind(...vals).run();
        return jsonResponse({ success:true });
      }

      // ── Insurer Rules ──────────────────────────────────────────────────

      if (path.match(/^\/api\/insurers\/[^\/]+\/rules\/[^\/]+$/) && method === 'GET') {
        const parts = path.split('/');
        const insId  = parts[3];
        const deptCode = parts[5];

        const ins = await env.DB.prepare(
          'SELECT * FROM insurance_companies WHERE id=? AND tenant_id=?'
        ).bind(insId, user.tenantId).first();
        if (!ins) return errorResponse('Insurer not found', 404);

        let rules = await env.DB.prepare(
          'SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
        ).bind(insId, deptCode).first();

        let source = 'insurer_custom';
        if (!rules) {
          const irdai = IRDAI_FALLBACK[deptCode];
          if (irdai) {
            source = 'irdai_fallback';
            rules = {
              insurer_id: insId,
              department_code: deptCode,
              depreciation_table: JSON.stringify(irdai.depreciation_table),
              deductible_rules:   JSON.stringify(irdai.deductible_rules),
              penalty_rules:      JSON.stringify(irdai.penalty_rules),
              document_checklist: JSON.stringify((IRDAI_DOCS[deptCode]||[]).map(n=>({name:n,mandatory:true,party:'insured'}))),
              warranties:         '[]',
              exclusions:         '[]',
              policy_clauses:     '[]',
              assessment_formula: '{}',
              sla_days:           irdai.sla_days || 30,
              fallback_used:      1
            };
          } else {
            source = 'industry_standard';
            rules = {
              insurer_id: insId, department_code: deptCode,
              depreciation_table:'[]', deductible_rules:'{}', penalty_rules:'{}',
              document_checklist: JSON.stringify((IRDAI_DOCS[deptCode]||[]).map(n=>({name:n,mandatory:true,party:'insured'}))),
              warranties:'[]', exclusions:'[]', policy_clauses:'[]',
              assessment_formula:'{}', sla_days:30, fallback_used:1
            };
          }
          await auditLog(env, user.tenantId, user.id,
            `rules_fallback_${source}`, 'insurer_department_rules', `${insId}_${deptCode}`, clientIP);
        }

        const parse = (v) => { try { return JSON.parse(v||'[]'); } catch { return []; } };
        return jsonResponse({
          rules: {
            ...rules,
            depreciation_table: parse(rules.depreciation_table),
            deductible_rules:   parse(rules.deductible_rules),
            penalty_rules:      parse(rules.penalty_rules),
            document_checklist: parse(rules.document_checklist),
            warranties:         parse(rules.warranties),
            exclusions:         parse(rules.exclusions),
            policy_clauses:     parse(rules.policy_clauses),
            assessment_formula: parse(rules.assessment_formula)
          },
          source,
          insurer: { id:ins.id, name:ins.name, code:ins.code }
        });
      }

      if (path.match(/^\/api\/insurers\/[^\/]+\/rules\/[^\/]+$/) && method === 'POST') {
        if (!hasPermission(user.role, 'admin')) return errorResponse('Admin required', 403);
        const parts   = path.split('/');
        const insId   = parts[3];
        const deptCode = parts[5];
        const d = await request.json();

        const existing = await env.DB.prepare(
          'SELECT id FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
        ).bind(insId, deptCode).first();

        const stringify = (v) => typeof v === 'string' ? v : JSON.stringify(v||[]);

        if (existing) {
          await env.DB.prepare(
            `UPDATE insurer_department_rules SET
             depreciation_table=?,deductible_rules=?,penalty_rules=?,
             document_checklist=?,warranties=?,exclusions=?,policy_clauses=?,
             assessment_formula=?,sla_days=?,rules_version=?,updated_at=?
             WHERE insurer_id=? AND department_code=?`
          ).bind(stringify(d.depreciation_table), stringify(d.deductible_rules),
                 stringify(d.penalty_rules), stringify(d.document_checklist),
                 stringify(d.warranties), stringify(d.exclusions),
                 stringify(d.policy_clauses), stringify(d.assessment_formula),
                 d.sla_days||30, d.rules_version||'1.0', Date.now(),
                 insId, deptCode).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO insurer_department_rules
             (id,insurer_id,department_code,depreciation_table,deductible_rules,
              penalty_rules,document_checklist,warranties,exclusions,policy_clauses,
              assessment_formula,sla_days,rules_version,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(generateUUID(), insId, deptCode,
                 stringify(d.depreciation_table), stringify(d.deductible_rules),
                 stringify(d.penalty_rules), stringify(d.document_checklist),
                 stringify(d.warranties), stringify(d.exclusions),
                 stringify(d.policy_clauses), stringify(d.assessment_formula),
                 d.sla_days||30, d.rules_version||'1.0', Date.now()).run();
        }
        await auditLog(env, user.tenantId, user.id, 'rules_updated',
                       'insurer_department_rules', `${insId}_${deptCode}`, clientIP);
        return jsonResponse({ success:true }); 
      }

      if (path === '/api/insurers/seed' && method === 'POST') {
        if (user.role !== 'super_admin' && user.role !== 'admin')
          return errorResponse('Admin required', 403);
        let created = 0;
        for (const ins of INSURERS) {
          const exists = await env.DB.prepare(
            'SELECT id FROM insurance_companies WHERE code=? AND tenant_id=?'
          ).bind(ins.code, user.tenantId).first();
          if (!exists) {
            await env.DB.prepare(
              `INSERT INTO insurance_companies
               (id,tenant_id,name,code,irdai_license,has_custom_guidelines,guideline_version,
                claims_dept_email,claims_dept_phone,portal_url,is_active,created_at)
               VALUES (?,?,?,?,?,1,?,?,?,?,1,?)`
            ).bind(ins.id+'_'+user.tenantId, user.tenantId, ins.name, ins.code,
                   ins.irdai_license||null, '1.0', ins.claims_dept_email||null,
                   ins.claims_dept_phone||null, ins.portal_url||null, Date.now()).run();
            for (const [dept, r] of Object.entries(ins.rules||{})) {
              await env.DB.prepare(
                `INSERT OR IGNORE INTO insurer_department_rules
                 (id,insurer_id,department_code,depreciation_table,deductible_rules,
                  penalty_rules,document_checklist,warranties,exclusions,policy_clauses,
                  assessment_formula,sla_days,created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
              ).bind(generateUUID(), ins.id+'_'+user.tenantId, dept,
                     JSON.stringify(r.depreciation_table||[]),
                     JSON.stringify(r.deductible_rules||{}),
                     JSON.stringify(r.penalty_rules||{}),
                     JSON.stringify(r.document_checklist||[]),
                     JSON.stringify(r.warranties||[]),
                     JSON.stringify(r.exclusions||[]),
                     JSON.stringify(r.policy_clauses||[]),
                     JSON.stringify(r.assessment_formula||{}),
                     r.sla_days||30, Date.now()).run();
            }
            created++;
          }
        }
        return jsonResponse({ success:true, created });
      }

      // ════════════════════════════════════════════════════════════════════
      // CLAIMS ROUTES
      // ════════════════════════════════════════════════════════════════════

      if (path === '/api/claims' && method === 'GET') {
        let q = 'SELECT c.*, ic.name AS insurer_name FROM claims c LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id WHERE 1=1';
        const p = [];
        if (user.role !== 'super_admin') { q += ' AND c.tenant_id=?'; p.push(user.tenantId); }
        if (user.role === 'surveyor')    { q += ' AND c.surveyor_id=?'; p.push(user.id); }
        const search = url.searchParams.get('search');
        if (search) { q += ' AND (c.claim_number LIKE ? OR c.insured_name LIKE ? OR c.policy_number LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
        const status = url.searchParams.get('status');
        if (status) { q += ' AND c.claim_status=?'; p.push(status); }
        const dept = url.searchParams.get('department');
        if (dept) { q += ' AND c.department=?'; p.push(dept); }
        const insId = url.searchParams.get('insurer_id');
        if (insId) { q += ' AND c.insurer_id=?'; p.push(insId); }
        q += ' ORDER BY c.created_at DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        for (const c of rows.results) {
          if (c.surveyor_id) {
            const s = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(c.surveyor_id).first();
            c.surveyor_name = s?.name;
          }
          const pds = await env.DB.prepare(
            'SELECT COUNT(*) AS total, SUM(CASE WHEN status="pending" THEN 1 ELSE 0 END) AS pending FROM pending_documents WHERE claim_id=?'
          ).bind(c.id).first();
          c.docs_total   = pds?.total || 0;
          c.docs_pending = pds?.pending || 0;
        }
        return jsonResponse({ claims: rows.results });
      }

      if (path.match(/^\/api\/claims\/[^\/]+$/) && method === 'GET') {
        const claimId = path.split('/').pop();
        const claim = await env.DB.prepare(
          `SELECT c.*, ic.name AS insurer_name, ic.code AS insurer_code,
                  ic.claims_dept_email, ic.portal_url
           FROM claims c
           LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id
           WHERE c.id=?`
        ).bind(claimId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        if (!canAccessResource(user, claim.tenant_id) && user.role !== 'surveyor')
          return errorResponse('Access denied', 403);

        const docs  = await env.DB.prepare('SELECT * FROM claim_documents WHERE claim_id=?').bind(claimId).all();
        const pdocs = await env.DB.prepare('SELECT * FROM pending_documents WHERE claim_id=? ORDER BY is_mandatory DESC, document_name').bind(claimId).all();
        const rpt   = await env.DB.prepare('SELECT * FROM survey_reports WHERE claim_id=?').bind(claimId).first();
        const aiLog = await env.DB.prepare('SELECT * FROM ai_audit_logs WHERE claim_id=? ORDER BY created_at DESC LIMIT 20').bind(claimId).all();

        claim.documents         = docs.results;
        claim.pending_documents = pdocs.results;
        claim.report            = rpt;
        claim.ai_audit          = aiLog.results;
        if (claim.warranty_breaches)  claim.warranty_breaches = JSON.parse(claim.warranty_breaches||'[]');
        if (claim.ai_suggestions)     claim.ai_suggestions    = JSON.parse(claim.ai_suggestions||'[]');
        if (claim.assessment_data)    claim.assessment_data   = JSON.parse(claim.assessment_data||'{}');

        return jsonResponse({ claim });
      }

      if (path === '/api/claims' && method === 'POST') {
        const d = await request.json();
        if (!d.insurer_id) return errorResponse('insurer_id is required (insurer-first architecture)');
        if (!d.department)  return errorResponse('department is required');

        const ins = await env.DB.prepare(
          'SELECT * FROM insurance_companies WHERE id=? AND tenant_id=?'
        ).bind(d.insurer_id, user.tenantId).first();
        if (!ins) return errorResponse('Invalid insurer', 400);

        const rulesRow = await env.DB.prepare(
          'SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
        ).bind(d.insurer_id, d.department).first();
        const rulesSnapshot = rulesRow ? JSON.stringify(rulesRow) : JSON.stringify({ fallback: true });

        const claimId = generateUUID();
        const claimNum = `CLM-${new Date().getFullYear()}-${Math.floor(1000 + Math.random()*9000)}`;

        await env.DB.prepare(
          `INSERT INTO claims
           (id,claim_number,tenant_id,insurer_id,policy_number,insured_name,department,
            sum_insured,loss_amount,claim_status,priority,incident_date,intimation_date,
            circumstances,rules_snapshot,fallback_rules_used,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(claimId, claimNum, user.tenantId, d.insurer_id, d.policy_number||null,
               d.insured_name, d.department, d.sum_insured||null, d.loss_amount||null,
               'intimated', d.priority||'medium', d.incident_date||null, Date.now(),
               d.circumstances||null, rulesSnapshot, rulesRow ? 0 : 1, user.id, Date.now()).run();

        const checklist = rulesRow
          ? JSON.parse(rulesRow.document_checklist || '[]')
          : (IRDAI_DOCS[d.department]||[]).map(n => ({ name:n, mandatory:true, party:'insured' }));

        for (const doc of checklist) {
          await env.DB.prepare(
            `INSERT INTO pending_documents
             (id,claim_id,tenant_id,insurer_id,document_name,document_type,
              is_mandatory,required_by,status,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(generateUUID(), claimId, user.tenantId, d.insurer_id,
                 doc.name, doc.document_type||doc.name,
                 doc.mandatory?1:0, doc.party||'insured', 'pending', Date.now()).run();
        }

        await auditLog(env, user.tenantId, user.id, 'claim_created', 'claims', claimId, clientIP, null, d);
        return jsonResponse({ success:true, claimId, claimNumber:claimNum,
                              docsCreated: checklist.length });
      }

      if (path.match(/^\/api\/claims\/[^\/]+$/) && method === 'PUT') {
        const claimId = path.split('/').pop();
        const d = await request.json();
        const existing = await env.DB.prepare('SELECT * FROM claims WHERE id=?').bind(claimId).first();
        if (!existing) return errorResponse('Claim not found', 404);
        if (!canAccessResource(user, existing.tenant_id)) return errorResponse('Access denied', 403);

        const allowed = ['policy_number','insured_name','department','sum_insured','loss_amount',
                         'claim_status','priority','surveyor_id','incident_date','survey_date',
                         'fir_number','police_station','legal_section','circumstances',
                         'security_measures','assessment_data','warranty_breaches',
                         'settlement_amount','settlement_percentage',
                         'current_stage','claim_number','insured_address',
                         'fsr_ready','insured_phone','insured_email'];
        const fields = []; const vals = [];
        for (const k of allowed) {
          if (d[k] !== undefined) {
            fields.push(`${k}=?`);
            vals.push(typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]);
          }
        }
        if (!fields.length) return errorResponse('No valid fields');
        fields.push('updated_at=?'); vals.push(Date.now()); vals.push(claimId);
        await env.DB.prepare(`UPDATE claims SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        await auditLog(env, user.tenantId, user.id, 'claim_updated', 'claims', claimId, clientIP, existing, d);
        return jsonResponse({ success:true });
      }

      // ════════════════════════════════════════════════════════════════════
      // PENDING DOCUMENTS TRACKER
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/pending-docs$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const rows = await env.DB.prepare(
          'SELECT * FROM pending_documents WHERE claim_id=? ORDER BY is_mandatory DESC, document_name'
        ).bind(claimId).all();
        return jsonResponse({ documents: rows.results });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/pending-docs$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const d = await request.json();
        const claim = await env.DB.prepare('SELECT * FROM claims WHERE id=?').bind(claimId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO pending_documents
           (id,claim_id,tenant_id,insurer_id,document_name,document_type,
            is_mandatory,required_by,due_date,status,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, claimId, user.tenantId, claim.insurer_id, d.document_name,
               d.document_type||null, d.is_mandatory?1:0, d.required_by||'insured',
               d.due_date||null, 'pending', d.notes||null, Date.now()).run();
        return jsonResponse({ success:true, id });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/pending-docs\/[^\/]+$/) && method === 'PUT') {
        const parts  = path.split('/');
        const claimId = parts[3];
        const docId   = parts[5];
        const d = await request.json();
        const allowed = ['status','submitted_doc_id','notes','due_date'];
        const fields = []; const vals = [];
        for (const k of allowed) if (d[k] !== undefined) { fields.push(`${k}=?`); vals.push(d[k]); }
        if (!fields.length) return errorResponse('No fields to update');
        fields.push('updated_at=?'); vals.push(Date.now()); vals.push(docId); vals.push(claimId);
        await env.DB.prepare(`UPDATE pending_documents SET ${fields.join(',')} WHERE id=? AND claim_id=?`)
          .bind(...vals).run();
        return jsonResponse({ success:true });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/pending-docs\/remind$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const now = Date.now();
        const twoDaysMs = 2 * 24 * 60 * 60 * 1000;

        const pendingDocs = await env.DB.prepare(
          `SELECT * FROM pending_documents
           WHERE claim_id=? AND status='pending'
           AND (last_reminder_sent IS NULL OR last_reminder_sent < ?)`
        ).bind(claimId, now - twoDaysMs).all();

        let reminders = 0;
        for (const doc of pendingDocs.results) {
          await env.DB.prepare(
            `UPDATE pending_documents
             SET reminder_count=reminder_count+1, last_reminder_sent=?, updated_at=?
             WHERE id=?`
          ).bind(now, now, doc.id).run();

          const claim = await env.DB.prepare('SELECT * FROM claims WHERE id=?').bind(claimId).first();
          await env.DB.prepare(
            `INSERT INTO notifications
             (id,tenant_id,user_id,title,message,type,channel,link,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`
          ).bind(generateUUID(), user.tenantId, user.id,
                 `📋 Doc Pending: ${doc.document_name}`,
                 `Claim ${claim?.claim_number||claimId}: "${doc.document_name}" is still pending. Reminder #${doc.reminder_count+1}.`,
                 'warning', 'in_app', `/claims/${claimId}`, now).run();

          reminders++;
        }

        await auditLog(env, user.tenantId, user.id, 'reminders_sent', 'pending_documents', claimId, clientIP, null, { count: reminders });
        return jsonResponse({ success:true, reminders_sent: reminders });
      }

      // ════════════════════════════════════════════════════════════════════
      // AI ACTIONS
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/ai-action$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const { action, context } = await request.json();

        const claim = await env.DB.prepare(
          `SELECT c.*, ic.name AS insurer_name, ic.code AS insurer_code
           FROM claims c LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id
           WHERE c.id=?`
        ).bind(claimId).first();
        if (!claim) return errorResponse('Claim not found', 404);

        const rules = await env.DB.prepare(
          'SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
        ).bind(claim.insurer_id, claim.department).first();
        const source = rules ? 'insurer_rules' : 'irdai_fallback';

        const prompt = `You are a claims assessment AI for McLarens.
Insurer: ${claim.insurer_name} (${claim.insurer_code})
Department: ${claim.department}
Claim: ${claim.claim_number}
Loss Amount: ₹${claim.loss_amount?.toLocaleString('en-IN') || 'N/A'}
Rules Source: ${source}
${rules ? `Penalty Rules: ${rules.penalty_rules}` : '(Using IRDAI fallback)'}

Action Requested: ${action}
Context: ${JSON.stringify(context||{})}

Provide a JSON response with:
{
  "reasoning": "...",
  "proposed_changes": {...},
  "confidence": 0-100,
  "source_used": "${source}",
  "warnings": [...]
}`;

        let proposal;
        try {
          const aiResp = await handleChatRequest(prompt, 'surveyor_ai', user, env);
          proposal = JSON.parse(aiResp.replace(/```json|```/g,'').trim());
        } catch {
          proposal = { reasoning: 'AI analysis completed', proposed_changes: context, confidence: 70, source_used: source, warnings: [] };
        }

        const logId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO ai_audit_logs
           (id,tenant_id,claim_id,action,ai_reasoning,proposed_changes,
            source_used,user_confirmed,ip_address,created_at)
           VALUES (?,?,?,?,?,?,?,0,?,?)`
        ).bind(logId, user.tenantId, claimId, action,
               proposal.reasoning, JSON.stringify(proposal.proposed_changes),
               proposal.source_used, clientIP, Date.now()).run();

        return jsonResponse({ proposal, log_id: logId, requires_confirmation: true });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/ai-confirm$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const { log_id, confirmed } = await request.json();

        const logEntry = await env.DB.prepare(
          'SELECT * FROM ai_audit_logs WHERE id=? AND claim_id=?'
        ).bind(log_id, claimId).first();
        if (!logEntry) return errorResponse('AI action log not found', 404);
        if (logEntry.user_confirmed) return errorResponse('Action already processed');

        if (!confirmed) {
          await env.DB.prepare(
            'UPDATE ai_audit_logs SET rejected_by=?, rejected_at=? WHERE id=?'
          ).bind(user.id, Date.now(), log_id).run();
          return jsonResponse({ success:true, status:'rejected' });
        }

        const changes = JSON.parse(logEntry.proposed_changes || '{}');
        const allowed = ['loss_amount','settlement_amount','settlement_percentage',
                         'warranty_breaches','ai_suggestions','claim_status'];
        const fields = []; const vals = [];
        for (const k of allowed) {
          if (changes[k] !== undefined) {
            fields.push(`${k}=?`);
            vals.push(typeof changes[k] === 'object' ? JSON.stringify(changes[k]) : changes[k]);
          }
        }
        if (fields.length) {
          fields.push('updated_at=?'); vals.push(Date.now()); vals.push(claimId);
          await env.DB.prepare(`UPDATE claims SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        }

        await env.DB.prepare(
          'UPDATE ai_audit_logs SET user_confirmed=1, confirmed_by=?, confirmed_at=? WHERE id=?'
        ).bind(user.id, Date.now(), log_id).run();

        await auditLog(env, user.tenantId, user.id, 'ai_action_confirmed', 'claims', claimId, clientIP, null, changes);
        return jsonResponse({ success:true, status:'applied', changes_applied: fields.length });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/ai-verify$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const claim = await env.DB.prepare(
          `SELECT c.*, ic.name AS insurer_name FROM claims c
           LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id WHERE c.id=?`
        ).bind(claimId).first();
        if (!claim) return errorResponse('Claim not found', 404);

        const docs = await env.DB.prepare(
          'SELECT * FROM claim_documents WHERE claim_id=?'
        ).bind(claimId).all();
        const pendingDocs = await env.DB.prepare(
          "SELECT * FROM pending_documents WHERE claim_id=? AND status='pending'"
        ).bind(claimId).all();
        const rules = await env.DB.prepare(
          'SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
        ).bind(claim.insurer_id, claim.department).first();

        const warranties = JSON.parse(rules?.warranties || '[]');
        const docsUploaded = docs.results.map(d => d.document_type || d.filename);

        const prompt = `You are an insurance claims AI. Analyse for breaches and discrepancies.
Insurer: ${claim.insurer_name}
Department: ${claim.department}
Claim Number: ${claim.claim_number}
Loss Amount: ₹${claim.loss_amount || 0}
Uploaded Documents: ${JSON.stringify(docsUploaded)}
Missing Documents: ${JSON.stringify(pendingDocs.results.map(p => p.document_name))}
Warranties: ${JSON.stringify(warranties)}
OCR Data: ${docs.results.map(d => d.ocr_extracted_data ? JSON.parse(d.ocr_extracted_data) : null).filter(Boolean).join('\n')}

Return JSON:
{
  "breaches_found": [{"type":"warranty|document|amount","description":"...","penalty_pct":0,"evidence":"..."}],
  "discrepancies": [{"field":"...","uploaded_value":"...","claimed_value":"..."}],
  "missing_critical_docs": ["..."],
  "recommended_settlement_pct": 0-100,
  "confidence": 0-100,
  "summary": "..."
}`;

        let analysis;
        try {
          const aiResp = await handleChatRequest(prompt, 'surveyor_ai', user, env);
          analysis = JSON.parse(aiResp.replace(/```json|```/g,'').trim());
        } catch {
          analysis = { breaches_found:[], discrepancies:[], missing_critical_docs:[], recommended_settlement_pct:100, confidence:0, summary:'AI analysis failed — manual review required.' };
        }

        const logId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO ai_audit_logs
           (id,tenant_id,claim_id,action,ai_reasoning,proposed_changes,source_used,ip_address,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).bind(logId, user.tenantId, claimId, 'cross_document_verification',
               analysis.summary, JSON.stringify(analysis),
               rules ? 'insurer_rules' : 'irdai_fallback', clientIP, Date.now()).run();

        return jsonResponse({ analysis, log_id: logId, requires_confirmation: analysis.breaches_found?.length > 0 });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/ai-audit$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const logs = await env.DB.prepare(
          'SELECT * FROM ai_audit_logs WHERE claim_id=? ORDER BY created_at DESC'
        ).bind(claimId).all();
        return jsonResponse({ logs: logs.results });
      }

      // ════════════════════════════════════════════════════════════════════
      // DOCUMENT UPLOAD
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        const claimId     = formData.get('claimId') || formData.get('entityId');
        const docType     = formData.get('documentType') || formData.get('document_type');
        const geoLat      = formData.get('geo_lat');
        const geoLng      = formData.get('geo_lng');
        const caption     = formData.get('caption');
        const isHandwritten = formData.get('is_handwritten') === 'true';

        if (!file) return errorResponse('No file uploaded', 400);

        const key = `${user.tenantId}/${claimId||'general'}/${Date.now()}-${file.name}`;
        await env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

        const docId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO claim_documents
           (id,claim_id,tenant_id,filename,document_type,r2_key,file_size,mime_type,
            uploaded_by,geo_lat,geo_lng,geo_timestamp,caption,is_handwritten_upload,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(docId, claimId||null, user.tenantId, file.name, docType||null, key,
               file.size, file.type, user.id,
               geoLat ? parseFloat(geoLat) : null,
               geoLng ? parseFloat(geoLng) : null,
               geoLat ? Date.now() : null,
               caption||null, isHandwritten?1:0, Date.now()).run();

        if (claimId && docType) {
          await env.DB.prepare(
            `UPDATE pending_documents
             SET status='submitted', submitted_doc_id=?, updated_at=?
             WHERE claim_id=? AND document_type=? AND status='pending'
             LIMIT 1`
          ).bind(docId, Date.now(), claimId, docType).run();
        }

        return jsonResponse({ success:true, documentId:docId, key,
                              geo_tagged: !!(geoLat && geoLng) });
      }

      if (path.match(/^\/api\/download\/[^\/]+$/) && method === 'GET') {
        const docId = path.split('/').pop();
        const doc = await env.DB.prepare('SELECT * FROM claim_documents WHERE id=?').bind(docId).first();
        if (!doc) return errorResponse('Document not found', 404);
        if (!canAccessResource(user, doc.tenant_id)) return errorResponse('Access denied', 403);
        const obj = await env.DOCS.get(doc.r2_key);
        if (!obj) return errorResponse('File not found in storage', 404);
        const headers = new Headers();
        headers.set('Content-Type', doc.mime_type || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename="${doc.filename}"`);
        return new Response(obj.body, { headers });
      }

      // ════════════════════════════════════════════════════════════════════
      // HRMS ROUTES
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/employees' && method === 'GET') {
        let q = 'SELECT * FROM employees WHERE 1=1'; const p = [];
        if (user.role !== 'super_admin') { q += ' AND tenant_id=?'; p.push(user.tenantId); }
        const search = url.searchParams.get('search');
        if (search) { q += ' AND (name LIKE ? OR employee_code LIKE ? OR email LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
        const dept = url.searchParams.get('department');
        if (dept) { q += ' AND department=?'; p.push(dept); }
        q += ' ORDER BY name';
        const rows = await env.DB.prepare(q).bind(...p).all();
        return jsonResponse({ employees: rows.results });
      }

      if (path.match(/^\/api\/employees\/[^\/]+$/) && method === 'GET') {
        const empId = path.split('/').pop();
        const emp = await env.DB.prepare('SELECT * FROM employees WHERE id=?').bind(empId).first();
        if (!emp) return errorResponse('Employee not found', 404);
        const claims = await env.DB.prepare(
          'SELECT id,claim_number,claim_status,department,created_at,settlement_amount FROM claims WHERE surveyor_id IN (SELECT id FROM users WHERE id=?)'
        ).bind(emp.user_id||'').all();
        return jsonResponse({ employee:emp, claims_handled:claims.results });
      }

      if (path === '/api/employees' && method === 'POST') {
        const d = await request.json();
        const id = generateUUID();
        const code = `EMP${Date.now()}`;
        await env.DB.prepare(
          `INSERT INTO employees
           (id,tenant_id,employee_code,name,email,phone,department,designation,
            reporting_manager,location,employment_type,status,joining_date,ctc,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, user.tenantId, code, d.name, d.email, d.phone||null, d.department,
               d.designation, d.reporting_manager||null, d.location||null,
               d.employment_type||'full_time', 'active', d.joining_date||Date.now(),
               d.ctc||null, Date.now()).run();
        return jsonResponse({ success:true, id, employee_code:code });
      }

      if (path === '/api/attendance/checkin' && method === 'POST') {
        const { claim_id, geo_lat, geo_lng, geo_accuracy } = await request.json();
        const emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id=?').bind(user.id).first();
        if (!emp) return errorResponse('Employee record not found', 404);

        const today = new Date(); today.setHours(0,0,0,0);
        const dateKey = today.getTime();

        let geoVerified = 0;
        if (emp.geo_fence_lat && emp.geo_fence_lng && geo_lat && geo_lng) {
          const R = 6371000;
          const dLat = (geo_lat - emp.geo_fence_lat) * Math.PI/180;
          const dLng = (geo_lng - emp.geo_fence_lng) * Math.PI/180;
          const a = Math.sin(dLat/2)**2 + Math.cos(emp.geo_fence_lat*Math.PI/180) *
                    Math.cos(geo_lat*Math.PI/180) * Math.sin(dLng/2)**2;
          const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
          geoVerified = dist <= (emp.geo_fence_radius || 200) ? 1 : 0;
        }

        const existing = await env.DB.prepare(
          'SELECT * FROM attendance WHERE employee_id=? AND date=?'
        ).bind(emp.id, dateKey).first();

        const timeStr = new Date().toTimeString().slice(0,5);
        if (existing) {
          await env.DB.prepare(
            'UPDATE attendance SET check_out=?, total_hours=?, updated_at=? WHERE employee_id=? AND date=?'
          ).bind(timeStr, ((Date.now() - dateKey) / 3600000).toFixed(2), Date.now(), emp.id, dateKey).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO attendance
             (id,tenant_id,employee_id,claim_id,date,check_in,geo_location,geo_verified,status,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          ).bind(generateUUID(), user.tenantId, emp.id, claim_id||null, dateKey, timeStr,
                 JSON.stringify({ lat:geo_lat, lng:geo_lng, accuracy:geo_accuracy }),
                 geoVerified, 'present', Date.now()).run();
        }
        return jsonResponse({ success:true, geo_verified:!!geoVerified, check_in:timeStr });
      }

      if (path === '/api/leave' && method === 'GET') {
        let q = 'SELECT * FROM leave_requests WHERE 1=1'; const p = [];
        if (user.role !== 'super_admin') { q += ' AND tenant_id=?'; p.push(user.tenantId); }
        q += ' ORDER BY created_at DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        return jsonResponse({ leaves: rows.results });
      }

      if (path === '/api/leave' && method === 'POST') {
        const d = await request.json();
        const emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id=?').bind(user.id).first();
        if (!emp) return errorResponse('Employee not found', 404);
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO leave_requests
           (id,tenant_id,employee_id,leave_type,from_date,to_date,days,reason,status,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, user.tenantId, emp.id, d.leave_type, d.from_date, d.to_date,
               d.days, d.reason||null, 'pending', Date.now()).run();
        return jsonResponse({ success:true, id });
      }

      if (path.match(/^\/api\/leave\/[^\/]+\/approve$/) && method === 'POST') {
        const leaveId = path.split('/')[3];
        const { approved } = await request.json();
        const emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id=?').bind(user.id).first();
        await env.DB.prepare(
          'UPDATE leave_requests SET status=?, approved_by=?, approved_at=? WHERE id=?'
        ).bind(approved ? 'approved':'rejected', emp?.id||user.id, Date.now(), leaveId).run();
        return jsonResponse({ success:true });
      }

      if (path === '/api/expenses' && method === 'GET') {
        let q = 'SELECT * FROM expenses WHERE 1=1'; const p = [];
        if (user.role !== 'super_admin') { q += ' AND tenant_id=?'; p.push(user.tenantId); }
        const claimId = url.searchParams.get('claim_id');
        if (claimId) { q += ' AND claim_id=?'; p.push(claimId); }
        q += ' ORDER BY created_at DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        return jsonResponse({ expenses: rows.results });
      }

      if (path === '/api/expenses' && method === 'POST') {
        const d = await request.json();
        const emp = await env.DB.prepare('SELECT * FROM employees WHERE user_id=?').bind(user.id).first();
        if (!emp) return errorResponse('Employee not found', 404);
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO expenses
           (id,tenant_id,employee_id,claim_id,category,amount,expense_date,description,status,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, user.tenantId, emp.id, d.claim_id||null, d.category, d.amount,
               d.expense_date||Date.now(), d.description||null, 'pending', Date.now()).run();
        return jsonResponse({ success:true, id });
      }

      if (path === '/api/payroll' && method === 'GET') {
        let q = 'SELECT * FROM payroll WHERE 1=1'; const p = [];
        if (user.role !== 'super_admin') { q += ' AND tenant_id=?'; p.push(user.tenantId); }
        const month = url.searchParams.get('month');
        if (month) { q += ' AND month=?'; p.push(month); }
        const year  = url.searchParams.get('year');
        if (year)  { q += ' AND year=?'; p.push(parseInt(year)); }
        q += ' ORDER BY created_at DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        for (const r of rows.results) {
          const e = await env.DB.prepare('SELECT name FROM employees WHERE id=?').bind(r.employee_id).first();
          r.employee_name = e?.name;
        }
        return jsonResponse({ payroll: rows.results });
      }

      if (path === '/api/payroll/process' && method === 'POST') {
        const { month, year } = await request.json();
        const emps = await env.DB.prepare(
          "SELECT * FROM employees WHERE tenant_id=? AND status='active'"
        ).bind(user.tenantId).all();
        for (const e of emps.results) {
          const monthly = Math.round((e.ctc||0) / 12);
          const basic = Math.round(monthly * 0.4);
          const hra   = Math.round(monthly * 0.2);
          const ta    = Math.round(monthly * 0.05);
          const gross = basic + hra + ta;
          const pf    = Math.round(basic * 0.12);
          const tds   = Math.round(gross * 0.1);
          const net   = gross - pf - tds;
          await env.DB.prepare(
            `INSERT OR IGNORE INTO payroll
             (id,tenant_id,employee_id,month,year,basic,hra,ta,gross_salary,
              pf_deduction,tds,net_salary,status,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(generateUUID(), user.tenantId, e.id, month, year, basic, hra, ta,
                 gross, pf, tds, net, 'processing', Date.now()).run();
        }
        return jsonResponse({ success:true, processed:emps.results.length });
      }

      if (path === '/api/performance' && method === 'GET') {
        const empId = url.searchParams.get('employee_id');
        let q = `
          SELECT e.id, e.name, e.department,
                 COUNT(c.id)                                          AS claims_handled,
                 AVG(CAST(c.updated_at - c.created_at AS REAL)/86400) AS avg_turnaround_days,
                 SUM(c.settlement_amount)                             AS total_settlement_value,
                 SUM(c.loss_amount - c.settlement_amount)             AS cost_savings,
                 AVG(c.settlement_percentage)                         AS avg_settlement_pct
          FROM employees e
          LEFT JOIN users u ON e.user_id = u.id
          LEFT JOIN claims c ON c.surveyor_id = u.id
                            AND c.tenant_id = e.tenant_id
          WHERE e.tenant_id=?
        `;
        const p = [user.tenantId];
        if (empId) { q += ' AND e.id=?'; p.push(empId); }
        q += ' GROUP BY e.id ORDER BY claims_handled DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        return jsonResponse({ performance: rows.results });
      }

      if (path === '/api/grievances' && method === 'GET') {
        let q = 'SELECT * FROM grievances WHERE tenant_id=?'; const p = [user.tenantId];
        const claimId = url.searchParams.get('claim_id');
        if (claimId) { q += ' AND claim_id=?'; p.push(claimId); }
        q += ' ORDER BY created_at DESC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        return jsonResponse({ grievances: rows.results });
      }

      if (path === '/api/grievances' && method === 'POST') {
        const d = await request.json();
        const id = generateUUID();
        const emp = await env.DB.prepare('SELECT id FROM employees WHERE user_id=?').bind(user.id).first();
        await env.DB.prepare(
          `INSERT INTO grievances
           (id,tenant_id,employee_id,claim_id,category,subject,description,priority,
            is_anonymous,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, user.tenantId, d.is_anonymous?null:emp?.id, d.claim_id||null,
               d.category, d.subject, d.description, d.priority||'medium',
               d.is_anonymous?1:0, Date.now()).run();
        return jsonResponse({ success:true, id });
      }

      // ════════════════════════════════════════════════════════════════════
      // AI CHATBOT
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/chat' && method === 'POST') {
        const { message, platform, sessionId, claimId } = await request.json();

        let contextMsg = message;
        if (claimId) {
          const claim = await env.DB.prepare(
            `SELECT c.*, ic.name AS insurer_name FROM claims c
             LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id WHERE c.id=?`
          ).bind(claimId).first();
          if (claim) {
            const rules = await env.DB.prepare(
              'SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?'
            ).bind(claim.insurer_id, claim.department).first();
            contextMsg = `[Context: Claim ${claim.claim_number}, Insurer: ${claim.insurer_name}, Dept: ${claim.department}, Rules: ${rules ? 'custom' : 'IRDAI_fallback'}]\n\n${message}`;
          }
        }

        const response = await handleChatRequest(contextMsg, platform, user, env);

        await env.DB.prepare(
          `INSERT INTO chat_history (id,tenant_id,user_id,session_id,platform,role,content,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(generateUUID(), user.tenantId, user.id, sessionId, platform, 'user', message, Date.now()).run();
        await env.DB.prepare(
          `INSERT INTO chat_history (id,tenant_id,user_id,session_id,platform,role,content,created_at)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(generateUUID(), user.tenantId, user.id, sessionId, platform, 'assistant', response, Date.now()).run();

        return jsonResponse({ response, sessionId });
      }

      if (path === '/api/chat/history' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        const platform  = url.searchParams.get('platform');
        const history = await env.DB.prepare(
          'SELECT * FROM chat_history WHERE user_id=? AND session_id=? AND platform=? ORDER BY created_at ASC'
        ).bind(user.id, sessionId, platform).all();
        return jsonResponse({ history: history.results });
      }

      // ════════════════════════════════════════════════════════════════════
      // NOTIFICATIONS
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/notifications' && method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50'
        ).bind(user.id).all();
        return jsonResponse({ notifications: rows.results });
      }

      if (path.match(/^\/api\/notifications\/[^\/]+\/read$/) && method === 'POST') {
        const notifId = path.split('/')[3];
        await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?')
          .bind(notifId, user.id).run();
        return jsonResponse({ success:true });
      }

      // ════════════════════════════════════════════════════════════════════
      // DASHBOARD STATS
      // ════════════════════════════════════════════════════════════════════
      if (path === '/api/dashboard/stats' && method === 'GET') {
        const platform = url.searchParams.get('platform');
        let stats = {};
        if (platform === 'surveyor') {
          const baseQ = user.role === 'surveyor'
            ? 'SELECT COUNT(*) AS total FROM claims WHERE surveyor_id=? AND tenant_id=?'
            : 'SELECT COUNT(*) AS total FROM claims WHERE tenant_id=?';
          const bp = user.role === 'surveyor' ? [user.id, user.tenantId] : [user.tenantId];
          const total   = await env.DB.prepare(baseQ).bind(...bp).first();
          const pending = await env.DB.prepare(baseQ.replace('COUNT(*) AS total','COUNT(*) AS total') + " AND claim_status IN ('intimated','in_progress')").bind(...bp).first();
          const settled = await env.DB.prepare(baseQ + " AND claim_status='settled'").bind(...bp).first();
          const critical = await env.DB.prepare(
            "SELECT COUNT(*) AS total FROM pending_documents WHERE tenant_id=? AND status='pending' AND is_mandatory=1"
          ).bind(user.tenantId).first();
          stats = {
            totalClaims:     total?.total || 0,
            pendingClaims:   pending?.total || 0,
            settledClaims:   settled?.total || 0,
            criticalDocsPending: critical?.total || 0
          };
        } else {
          const emp    = await env.DB.prepare("SELECT COUNT(*) AS total FROM employees WHERE tenant_id=?").bind(user.tenantId).first();
          const leaves = await env.DB.prepare("SELECT COUNT(*) AS total FROM leave_requests WHERE tenant_id=? AND status='pending'").bind(user.tenantId).first();
          const payroll= await env.DB.prepare("SELECT COUNT(*) AS total FROM payroll WHERE tenant_id=? AND status='processing'").bind(user.tenantId).first();
          stats = {
            totalEmployees:  emp?.total || 0,
            pendingLeaves:   leaves?.total || 0,
            processingPayroll: payroll?.total || 0
          };
        }
        return jsonResponse({ stats });
      }

      // ════════════════════════════════════════════════════════════════════
      // ADMIN ROUTES
      // ════════════════════════════════════════════════════════════════════
      if (path.startsWith('/api/admin/')) {
        if (user.role !== 'super_admin') return errorResponse('Super admin required', 403);

        if (path === '/api/admin/tenants' && method === 'GET') {
          const tenants = await env.DB.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
          return jsonResponse({ tenants: tenants.results });
        }
        if (path === '/api/admin/stats' && method === 'GET') {
          const [users_, tenants_, claims_, emps_] = await Promise.all([
            env.DB.prepare('SELECT COUNT(*) AS total FROM users').first(),
            env.DB.prepare('SELECT COUNT(*) AS total FROM tenants').first(),
            env.DB.prepare('SELECT COUNT(*) AS total FROM claims').first(),
            env.DB.prepare('SELECT COUNT(*) AS total FROM employees').first()
          ]);
          return jsonResponse({ totalUsers:users_?.total, totalTenants:tenants_?.total,
                                totalClaims:claims_?.total, totalEmployees:emps_?.total });
        }
        if (path === '/api/admin/audit' && method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') || '100');
          const logs  = await env.DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').bind(limit).all();
          return jsonResponse({ logs: logs.results });
        }
      }

      // ════ WEBSOCKET UPGRADE ═══════════════════════════════════════════
      if (path === '/api/realtime' && request.headers.get('Upgrade') === 'websocket') {
        if (!user) return errorResponse('Unauthorized', 401);
        if (!env.REALTIME_HUB) return errorResponse('Real-time not configured', 503);
        const doId = env.REALTIME_HUB.idFromName(user.tenantId);
        const stub = env.REALTIME_HUB.get(doId);
        const wsUrl = new URL(request.url);
        wsUrl.searchParams.set('userId', user.id);
        wsUrl.searchParams.set('tenantId', user.tenantId);
        wsUrl.searchParams.set('role', user.role);
        return stub.fetch(new Request(wsUrl.toString(), request));
      }

      // ════ GPT-4 VISION OCR ════════════════════════════════════════════
      if (path === '/api/ocr' && method === 'POST') {
        let imageBase64, mimeType, context;
        const ct = request.headers.get('Content-Type') || '';
        if (ct.includes('multipart/form-data')) {
          const form = await request.formData();
          const file = form.get('file');
          if (!file) return errorResponse('No file provided');
          mimeType = file.type || 'image/jpeg';
          context  = form.get('context') || 'document';
          const bytes = await file.arrayBuffer();
          const uint8 = new Uint8Array(bytes);
          let binary = '';
          for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
          imageBase64 = btoa(binary);
        } else {
          const body = await request.json();
          imageBase64 = body.imageBase64;
          mimeType    = body.mimeType || 'image/jpeg';
          context     = body.context  || 'document';
        }
        if (!imageBase64) return errorResponse('No image data provided');
        const result  = await extractTextFromImage(env, { imageBase64, mimeType, context });
        const claimId = url.searchParams.get('claimId');
        if (claimId && result.raw_text) {
          const docId = generateUUID();
          const r2Key = `${user.tenantId}/ocr/${claimId}/${Date.now()}-ocr.json`;
          await env.DOCS.put(r2Key, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
          await env.DB.prepare(
            `INSERT INTO claim_documents (id,claim_id,tenant_id,filename,document_type,r2_key,ocr_extracted_data,verification_score,uploaded_by,is_handwritten_upload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(docId, claimId, user.tenantId, `ocr-${Date.now()}.json`,
            context === 'handwritten_report' ? 'handwritten_report' : 'ocr_document',
            r2Key, JSON.stringify(result), result.confidence || 80, user.id,
            context === 'handwritten_report' ? 1 : 0, Date.now()).run();
          await broadcastUpdate(env, user.tenantId, 'ocr_complete', { claimId, docId, confidence: result.confidence });
          return jsonResponse({ ...result, docId, saved: true });
        }
        return jsonResponse(result);
      }

      // ════ UPLOAD with OCR + geo + broadcast ══════════════════════════
      if (path === '/api/upload' && method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        const claimId = formData.get('claimId') || formData.get('entityId');
        const docType = formData.get('documentType') || formData.get('document_type');
        const geoLat  = formData.get('geo_lat');
        const geoLng  = formData.get('geo_lng');
        const caption = formData.get('caption');
        const isHandwritten = formData.get('is_handwritten') === 'true';
        const runOCR  = formData.get('run_ocr') === 'true';
        if (!file) return errorResponse('No file uploaded', 400);
        const key = `${user.tenantId}/${claimId || 'general'}/${Date.now()}-${file.name}`;
        await env.DOCS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
        const docId = generateUUID();
        let ocrData = null;
        if ((runOCR || isHandwritten) && file.type.startsWith('image/')) {
          try {
            const bytes = await file.arrayBuffer();
            const uint8 = new Uint8Array(bytes);
            let binary = '';
            for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
            ocrData = await extractTextFromImage(env, { imageBase64: btoa(binary), mimeType: file.type, context: isHandwritten ? 'handwritten_report' : 'document' });
          } catch (e) { console.warn('[Upload OCR]', e.message); }
        }
        await env.DB.prepare(
          `INSERT INTO claim_documents (id,claim_id,tenant_id,filename,document_type,r2_key,file_size,mime_type,uploaded_by,ocr_extracted_data,verification_score,geo_lat,geo_lng,geo_timestamp,caption,is_handwritten_upload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(docId, claimId||null, user.tenantId, file.name, docType||null, key, file.size, file.type, user.id,
          ocrData ? JSON.stringify(ocrData) : null, ocrData?.confidence||null,
          geoLat ? parseFloat(geoLat) : null, geoLng ? parseFloat(geoLng) : null,
          (geoLat && geoLng) ? Date.now() : null, caption||null, isHandwritten?1:0, Date.now()).run();
        if (claimId && docType) {
          await env.DB.prepare(
            `UPDATE pending_documents SET status='submitted',submitted_doc_id=?,updated_at=? WHERE claim_id=? AND (document_type=? OR document_name LIKE ?) AND status='pending' LIMIT 1`
          ).bind(docId, Date.now(), claimId, docType, `%${docType}%`).run();
        }
        if (claimId) await broadcastUpdate(env, user.tenantId, 'document_uploaded', { claimId, docId, documentType: docType, filename: file.name, hasOCR: !!ocrData, geoTagged: !!(geoLat && geoLng) });
        return jsonResponse({ success: true, documentId: docId, key, ocr_data: ocrData, geo_tagged: !!(geoLat && geoLng) });
      }

      // ════ CLAIM STATUS UPDATE with email ══════════════════════════════
      if (path.match(/^\/api\/claims\/[^\/]+\/status$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const { status } = await request.json();
        const existing = await env.DB.prepare('SELECT * FROM claims WHERE id=?').bind(claimId).first();
        if (!existing) return errorResponse('Claim not found', 404);
        await env.DB.prepare('UPDATE claims SET claim_status=?,updated_at=? WHERE id=?').bind(status, Date.now(), claimId).run();
        let surveyorName = 'McLarens Survey Team';
        if (existing.surveyor_id) {
          const s = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(existing.surveyor_id).first();
          if (s) surveyorName = s.name;
        }
        if (existing.insured_email) {
          await sendEmail(env, { to: existing.insured_email,
            subject: `Claim ${existing.claim_number} — Status: ${status.replace('_',' ').toUpperCase()}`,
            html: buildStatusChangeEmail({ claimNumber: existing.claim_number, insuredName: existing.insured_name, oldStatus: existing.claim_status, newStatus: status, surveyorName }) });
        }
        await broadcastUpdate(env, user.tenantId, 'claim_status_changed', { claimId, oldStatus: existing.claim_status, newStatus: status });
        await auditLog(env, user.tenantId, user.id, 'claim_status_updated', 'claims', claimId, clientIP, { status: existing.claim_status }, { status });
        return jsonResponse({ success: true });
      }

      // ════ MANUAL REMINDER TRIGGER ═════════════════════════════════════
      if (path.match(/^\/api\/claims\/[^\/]+\/pending-docs\/remind$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const now = Date.now();
        const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
        const pdocs = await env.DB.prepare(
          `SELECT pd.*,ic.name AS insurer_name,ic.claims_dept_email FROM pending_documents pd JOIN insurance_companies ic ON pd.insurer_id=ic.id WHERE pd.claim_id=? AND pd.status='pending' AND (pd.last_reminder_sent IS NULL OR pd.last_reminder_sent < ?)`
        ).bind(claimId, now - TWO_DAYS).all();
        if (!pdocs.results.length) return jsonResponse({ success: true, reminders_sent: 0, message: 'No reminders due within 2-day window' });
        const claim = await env.DB.prepare('SELECT * FROM claims WHERE id=?').bind(claimId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const reminderCount = Math.max(...pdocs.results.map(d => d.reminder_count||0)) + 1;
        let surveyorName = 'McLarens Survey Team';
        if (claim.surveyor_id) { const s = await env.DB.prepare('SELECT name FROM users WHERE id=?').bind(claim.surveyor_id).first(); if (s) surveyorName = s.name; }
        const ins = pdocs.results[0];
        const emailHtml = buildPendingDocReminderEmail({ claimNumber: claim.claim_number, insuredName: claim.insured_name, insurerName: ins.insurer_name, pendingDocs: pdocs.results, reminderCount, surveyorName });
        const smsText   = buildPendingDocReminderSMS({ claimNumber: claim.claim_number, pendingCount: pdocs.results.length, insurerName: ins.insurer_name, reminderCount });
        const channels = {};
        if (claim.insured_email) channels.email_insured = await sendEmail(env, { to: claim.insured_email, subject: `[Reminder #${reminderCount}] Docs Pending — Claim ${claim.claim_number}`, html: emailHtml });
        if (claim.insured_phone) channels.sms_insured  = await sendSMS(env, { to: claim.insured_phone, body: smsText });
        if (ins.claims_dept_email) channels.email_insurer = await sendEmail(env, { to: ins.claims_dept_email, subject: `[CC] Claim ${claim.claim_number} — ${pdocs.results.length} docs pending`, html: emailHtml });
        for (const doc of pdocs.results) {
          await env.DB.prepare('UPDATE pending_documents SET reminder_count=reminder_count+1,last_reminder_sent=?,updated_at=? WHERE id=?').bind(now,now,doc.id).run();
        }
        if (claim.surveyor_id) {
          await env.DB.prepare(`INSERT INTO notifications (id,tenant_id,user_id,title,message,type,channel,link,sent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(generateUUID(), claim.tenant_id, claim.surveyor_id, `📋 Reminders Sent — ${pdocs.results.length} docs`, `Claim ${claim.claim_number}: Reminder #${reminderCount} via Email+SMS.`, 'info','in_app',`/surveyor-dashboard.html?claim=${claimId}`,now,now).run();
        }
        await auditLog(env, user.tenantId, user.id, 'reminders_sent', 'pending_documents', claimId, clientIP, null, { count: pdocs.results.length, reminderCount });
        return jsonResponse({ success: true, reminders_sent: pdocs.results.length, reminder_number: reminderCount, channels });
      }

      // ════════════════════════════════════════════════════════════════════
      // SURVEYOR COMPANY MANAGEMENT
      // Audit-only assignment model — no enforcement, no restrictions.
      // ════════════════════════════════════════════════════════════════════

      if (path === '/api/surveyor-companies' && method === 'POST') {
        if (!hasPermission(user.role, 'admin')) return errorResponse('Admin access required', 403);
        const d = await request.json();
        if (!d.name) return errorResponse('Company name is required', 400);
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO surveyor_companies
           (id,tenant_id,name,irda_license,contact_email,contact_phone,
            address,city,state,pincode,website,specializations,is_active,notes,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`
        ).bind(id, user.tenantId, d.name, d.irda_license||null, d.contact_email||null,
               d.contact_phone||null, d.address||null, d.city||null, d.state||null,
               d.pincode||null, d.website||null,
               d.specializations ? JSON.stringify(d.specializations) : null,
               d.notes||null, user.id, Date.now()).run();
        await auditLog(env, user.tenantId, user.id, 'surveyor_company_created', 'surveyor_companies', id, clientIP, null, d);
        return jsonResponse({ success:true, id });
      }

      if (path === '/api/surveyor-companies' && method === 'GET') {
        const isActive = url.searchParams.get('is_active');
        let q = 'SELECT * FROM surveyor_companies WHERE tenant_id=?';
        const p = [user.tenantId];
        if (isActive !== null && isActive !== '') { q += ' AND is_active=?'; p.push(parseInt(isActive)); }
        const search = url.searchParams.get('search');
        if (search) { q += ' AND (name LIKE ? OR irda_license LIKE ? OR city LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
        q += ' ORDER BY name ASC';
        const rows = await env.DB.prepare(q).bind(...p).all();
        const companies = await Promise.all((rows.results||[]).map(async c => {
          const cnt = await env.DB.prepare('SELECT COUNT(*) AS total FROM surveyors WHERE company_id=? AND is_active=1').bind(c.id).first();
          return { ...c, surveyor_count: cnt?.total||0, specializations: c.specializations ? JSON.parse(c.specializations) : [] };
        }));
        return jsonResponse({ companies });
      }

      if (path.match(/^\/api\/surveyor-companies\/[^\/]+\/surveyors$/) && method === 'POST') {
        if (!hasPermission(user.role, 'admin')) return errorResponse('Admin access required', 403);
        const companyId = path.split('/')[3];
        const d = await request.json();
        const company = await env.DB.prepare('SELECT id FROM surveyor_companies WHERE id=? AND tenant_id=?').bind(companyId, user.tenantId).first();
        if (!company) return errorResponse('Surveyor company not found', 404);
        const id = generateUUID();
        await env.DB.prepare(
          `INSERT INTO surveyors
           (id,user_id,company_id,tenant_id,license_number,license_expiry,expertise,location,city,state,is_active,joining_date,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)`
        ).bind(id, d.user_id||null, companyId, user.tenantId, d.license_number||null, d.license_expiry||null,
               d.expertise ? JSON.stringify(d.expertise) : null, d.location||null, d.city||null, d.state||null,
               d.joining_date||Date.now(), d.notes||null, Date.now()).run();
        await auditLog(env, user.tenantId, user.id, 'surveyor_added_to_company', 'surveyors', id, clientIP, null, { companyId, ...d });
        return jsonResponse({ success:true, id });
      }

      if (path.match(/^\/api\/surveyor-companies\/[^\/]+\/surveyors$/) && method === 'GET') {
        const companyId = path.split('/')[3];
        const company = await env.DB.prepare('SELECT id,name FROM surveyor_companies WHERE id=? AND tenant_id=?').bind(companyId, user.tenantId).first();
        if (!company) return errorResponse('Surveyor company not found', 404);
        const rows = await env.DB.prepare(
          `SELECT s.*,u.name AS user_name,u.email AS user_email FROM surveyors s
           LEFT JOIN users u ON s.user_id=u.id
           WHERE s.company_id=? AND s.tenant_id=? ORDER BY s.created_at DESC`
        ).bind(companyId, user.tenantId).all();
        const surveyors = (rows.results||[]).map(s => ({ ...s, expertise: s.expertise ? JSON.parse(s.expertise) : [] }));
        return jsonResponse({ company, surveyors });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/assign-internally$/) && method === 'PUT') {
        const claimId = path.split('/')[3];
        const d = await request.json();
        const claim = await env.DB.prepare('SELECT id,claim_number FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        if (!d.company_id) return errorResponse('company_id is required', 400);
        const assignId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO company_assignments
           (id,tenant_id,claim_id,company_id,assigned_by,assigned_at,notes,priority,expected_survey_date,internal_ref,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(assignId, user.tenantId, claimId, d.company_id, user.id, Date.now(),
               d.notes||null, d.priority||'medium', d.expected_survey_date||null, d.internal_ref||null, Date.now()).run();
        await auditLog(env, user.tenantId, user.id, 'claim_assigned_to_company', 'company_assignments', assignId, clientIP, null, { claimId, companyId: d.company_id });
        return jsonResponse({ success:true, assignment_id:assignId, message:'Assignment logged. Surveyor company handles internally.' });
      }

      if (path.match(/^\/api\/claims\/company\/[^\/]+$/) && method === 'GET') {
        const companyId = path.split('/').pop();
        const company = await env.DB.prepare('SELECT id,name FROM surveyor_companies WHERE id=? AND tenant_id=?').bind(companyId, user.tenantId).first();
        if (!company) return errorResponse('Surveyor company not found', 404);
        const assignments = await env.DB.prepare(
          `SELECT ca.*,c.claim_number,c.insured_name,c.department,c.claim_status,c.loss_amount,
                  c.priority AS claim_priority,c.incident_date,ic.name AS insurer_name,u.name AS assigned_by_name
           FROM company_assignments ca
           LEFT JOIN claims c ON ca.claim_id=c.id
           LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id
           LEFT JOIN users u ON ca.assigned_by=u.id
           WHERE ca.company_id=? AND ca.tenant_id=? ORDER BY ca.assigned_at DESC`
        ).bind(companyId, user.tenantId).all();
        return jsonResponse({ company, assignments: assignments.results||[] });
      }

      // ════════════════════════════════════════════════════════════════════
      // REPORT PIPELINE — JIR → SPOT → LOR → PSR → INTERIM → FSR
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/reports$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const claim   = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const rows = await env.DB.prepare(
          `SELECT id,claim_id,report_type,report_number,status,report_data,
                  ai_applied,submitted_at,accepted_at,version,created_at,updated_at
           FROM survey_reports_pipeline WHERE claim_id=? AND tenant_id=?
           ORDER BY CASE report_type WHEN 'jir' THEN 1 WHEN 'spot' THEN 2 WHEN 'lor' THEN 3
             WHEN 'psr' THEN 4 WHEN 'interim' THEN 5 WHEN 'fsr' THEN 6 ELSE 7 END`
        ).bind(claimId, user.tenantId).all();
        return jsonResponse({ reports: rows.results||[] });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/reports\/[^\/]+$/) && method === 'POST') {
        const parts = path.split('/');
        const claimId    = parts[3];
        const reportType = parts[5];
        const VALID = ['jir','spot','lor','psr','interim','fsr'];
        if (!VALID.includes(reportType)) return errorResponse(`Invalid report type. Must be: ${VALID.join(', ')}`, 400);
        const claim = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const body = await request.json();
        const { report_data, status, report_number, ai_suggestions, ai_applied, submitted_to } = body;
        const existing = await env.DB.prepare('SELECT id,version,status FROM survey_reports_pipeline WHERE claim_id=? AND report_type=?').bind(claimId, reportType).first();
        let reportId;
        if (existing) {
          reportId = existing.id;
          await env.DB.prepare(
            `UPDATE survey_reports_pipeline
             SET report_data=?,status=?,report_number=?,ai_suggestions=?,ai_applied=?,
                 submitted_to=?,version=version+1,
                 submitted_at=CASE WHEN ?='submitted' THEN ? ELSE submitted_at END,
                 accepted_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_at END,
                 updated_at=?
             WHERE id=?`
          ).bind(report_data||null, status||'saved', report_number||null,
                 ai_suggestions||null, ai_applied?1:0, submitted_to||null,
                 status, Date.now(), status, Date.now(), Date.now(), reportId).run();
        } else {
          reportId = generateUUID();
          await env.DB.prepare(
            `INSERT INTO survey_reports_pipeline
             (id,claim_id,tenant_id,report_type,report_number,report_data,status,
              ai_suggestions,ai_applied,submitted_to,submitted_at,created_by,created_at,version)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
          ).bind(reportId, claimId, user.tenantId, reportType, report_number||null,
                 report_data||null, status||'saved', ai_suggestions||null,
                 ai_applied?1:0, submitted_to||null,
                 status==='submitted'?Date.now():null, user.id, Date.now()).run();
        }
        // Audit trail
        await env.DB.prepare(
          `INSERT INTO report_audit
           (id,report_id,claim_id,tenant_id,report_type,action,old_status,new_status,changed_by,ip_address,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(generateUUID(), reportId, claimId, user.tenantId, reportType,
               status==='submitted'?'submitted':'saved',
               existing?.status||'draft', status||'saved',
               user.id, clientIP, Date.now()).run();
        // Update claim settlement if FSR submitted
        if (reportType==='fsr' && status==='submitted' && report_data) {
          try {
            const fsrData = JSON.parse(report_data);
            const net = fsrData.netSettlement || fsrData.net_settlement;
            if (net && !isNaN(parseFloat(net))) {
              await env.DB.prepare('UPDATE claims SET settlement_amount=?,updated_at=? WHERE id=?').bind(parseFloat(net), Date.now(), claimId).run();
            }
          } catch {}
        }
        // Broadcast spot submission
        if (reportType==='spot' && status==='submitted') {
          await broadcastUpdate(env, user.tenantId, 'spot_report_submitted', { claimId, reportId, submittedBy: user.name||user.id });
        }
        return jsonResponse({ success:true, id:reportId, existing:!!existing });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/reports\/[a-z]+$/) && method === 'GET') {
        const parts = path.split('/');
        const claimId    = parts[3];
        const reportType = parts[5];
        const report = await env.DB.prepare('SELECT * FROM survey_reports_pipeline WHERE claim_id=? AND report_type=?').bind(claimId, reportType).first();
        if (!report) return jsonResponse({ report:null, status:'not_found' });
        return jsonResponse({ report });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/reports\/fsr-ai$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const claimRec = await env.DB.prepare(
          `SELECT c.*,ic.name AS insurer_name,ic.code AS insurer_code
           FROM claims c LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id WHERE c.id=?`
        ).bind(claimId).first();
        if (!claimRec) return errorResponse('Claim not found', 404);
        const rules = await env.DB.prepare('SELECT * FROM insurer_department_rules WHERE insurer_id=? AND department_code=?').bind(claimRec.insurer_id, claimRec.department).first();
        const docs  = await env.DB.prepare('SELECT document_type,filename,ocr_extracted_data FROM claim_documents WHERE claim_id=?').bind(claimId).all();
        const jirReport = await env.DB.prepare("SELECT report_data FROM survey_reports_pipeline WHERE claim_id=? AND report_type='jir'").bind(claimId).first();
        const jirData   = jirReport?.report_data ? JSON.parse(jirReport.report_data) : {};
        const parse = (v) => { try { return JSON.parse(v||'{}'); } catch { return {}; } };
        const depTable = rules ? JSON.parse(rules.depreciation_table||'[]') : [];
        const dedRules = rules ? parse(rules.deductible_rules) : {};
        const penRules = rules ? parse(rules.penalty_rules) : {};
        const ocrSummary = (docs.results||[]).filter(d=>d.ocr_extracted_data).map(d => {
          const ocr = parse(d.ocr_extracted_data);
          return `${d.document_type}: ${JSON.stringify(ocr).slice(0,300)}`;
        }).join('\n');
        const prompt = `You are a senior insurance claim surveyor AI for McLarens India.
CLAIM: ${claimRec.claim_number} | Insurer: ${claimRec.insurer_name} | Dept: ${claimRec.department}
Sum Insured: ₹${(claimRec.sum_insured||0).toLocaleString('en-IN')} | Claimed: ₹${(claimRec.loss_amount||0).toLocaleString('en-IN')}
INSURER RULES: Depreciation Table: ${JSON.stringify(depTable)} | Deductible: ${JSON.stringify(dedRules)} | Penalties: ${JSON.stringify(penRules)}
JIR: Preliminary Loss: ₹${jirData.prelimLoss||'N/A'} | Security: ${jirData.security||'N/A'} | Narration: ${(jirData.narration||'N/A').slice(0,150)}
OCR DOCS: ${ocrSummary||'None available'}
Return ONLY valid JSON (no markdown):
{"openingStock":null,"purchases":null,"sales":null,"gpRate":null,"undamagedStock":null,"replacementVal":null,"assetAge":null,"depnPct":null,"grossAssessed":${claimRec.loss_amount||0},"deductible":${dedRules.fixed||Math.round((claimRec.loss_amount||0)*(dedRules.pct||5)/100)},"salvage":0,"frPenPct":${penRules.fr_pending_pct||0},"wbPct":${penRules.warranty_breach_pct||0},"si":${claimRec.sum_insured||0},"totalValue":null,"avgClause":"No","summary":"<2-3 sentences>","recommendation":"<surveyor recommendation>"}`;
        let suggestions = {};
        let reasoning   = 'AI analysis based on claim data and insurer rules.';
        try {
          const aiResp = await handleChatRequest(prompt, 'surveyor_ai', user, env);
          const parsed = JSON.parse(aiResp.replace(/```json|```/g,'').trim());
          suggestions  = parsed;
          reasoning    = parsed.summary || reasoning;
        } catch {
          suggestions = {
            grossAssessed: claimRec.loss_amount||0,
            deductible:    dedRules.fixed||Math.max((claimRec.loss_amount||0)*(dedRules.pct||5)/100, dedRules.minimum||10000),
            salvage: 0, frPenPct: penRules.fr_pending_pct||0, wbPct: penRules.warranty_breach_pct||0,
            si: claimRec.sum_insured||0, avgClause: (claimRec.sum_insured||0)<(claimRec.loss_amount||0)?'Yes':'No',
            summary: 'AI unavailable — fallback values from claim data. Review all values manually.'
          };
          reasoning = suggestions.summary;
        }
        const existingFsr = await env.DB.prepare("SELECT id FROM survey_reports_pipeline WHERE claim_id=? AND report_type='fsr'").bind(claimId).first();
        if (existingFsr) {
          await env.DB.prepare("UPDATE survey_reports_pipeline SET ai_suggestions=?,updated_at=? WHERE id=?").bind(JSON.stringify(suggestions), Date.now(), existingFsr.id).run();
        }
        await auditLog(env, user.tenantId, user.id, 'fsr_ai_calculated', 'survey_reports_pipeline', claimId, clientIP);
        return jsonResponse({ suggestions, reasoning });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/reports\/pipeline-summary$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const rows = await env.DB.prepare('SELECT report_type,status,version,updated_at FROM survey_reports_pipeline WHERE claim_id=?').bind(claimId).all();
        const summary = { jir:'draft', spot:'draft', lor:'draft', psr:'draft', interim:'draft', fsr:'draft' };
        (rows.results||[]).forEach(r => { summary[r.report_type] = r.status; });
        return jsonResponse({ pipeline: summary });
      }


      // ════════════════════════════════════════════════════════════════════
      // v5.1 — DOCUMENT CHECKLIST ROUTES
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/checklist$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const claim = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const items = await env.DB.prepare('SELECT * FROM document_checklist WHERE claim_id=? ORDER BY sort_order').bind(claimId).all();
        const summary = await env.DB.prepare('SELECT * FROM v_checklist_status WHERE claim_id=?').bind(claimId).first();
        return jsonResponse({ checklist: items.results || [], summary });
      }

      if (path.match(/^\/api\/checklist\/[^\/]+\/waive$/) && method === 'POST') {
        const itemId = path.split('/')[3];
        const { reason } = await request.json();
        if (!reason) return errorResponse('Waiver reason is required');
        await env.DB.prepare("UPDATE document_checklist SET status='waived',waiver_reason=?,waived_by=?,waived_at=?,updated_at=? WHERE id=?")
          .bind(reason, user.id, Date.now(), Date.now(), itemId).run();
        await auditLog(env, user.tenantId, user.id, 'checklist_waived', 'document_checklist', itemId, clientIP);
        return jsonResponse({ success: true });
      }

      // ════════════════════════════════════════════════════════════════════
      // v5.1 — AI AUTO-DRAFT ROUTE (OpenAI GPT-4o)
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/reports\/auto-draft$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const { report_type } = await request.json();
        const VALID = ['jir','spot','lor','psr','interim','fsr'];
        if (!VALID.includes(report_type)) return errorResponse('Invalid report type');
        const claim = await env.DB.prepare(
          `SELECT c.*,ic.name AS insurer_name FROM claims c
           LEFT JOIN insurance_companies ic ON c.insurer_id=ic.id
           WHERE c.id=? AND c.tenant_id=?`
        ).bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const docs = await env.DB.prepare(
          "SELECT document_type, filename, ocr_extracted_data FROM claim_documents WHERE claim_id=?"
        ).bind(claimId).all();
        const calc = await env.DB.prepare('SELECT * FROM fsr_calculations WHERE claim_id=?').bind(claimId).first();
        const draft = await generateReportDraft(env, report_type, claim, docs.results || [], calc);
        await auditLog(env, user.tenantId, user.id, 'report_auto_drafted', 'survey_reports_pipeline', claimId, clientIP);
        return jsonResponse({ success: true, draft, report_type });
      }

      // ════════════════════════════════════════════════════════════════════
      // v5.1 — FSR CALCULATION SAVE/GET
      // ════════════════════════════════════════════════════════════════════

      if (path.match(/^\/api\/claims\/[^\/]+\/calculation$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const calc = await env.DB.prepare('SELECT * FROM fsr_calculations WHERE claim_id=?').bind(claimId).first();
        return jsonResponse({ success: true, calculation: calc || null });
      }

      if (path.match(/^\/api\/claims\/[^\/]+\/calculation$/) && method === 'POST') {
        const claimId = path.split('/')[3];
        const body = await request.json();
        const existing = await env.DB.prepare('SELECT id FROM fsr_calculations WHERE claim_id=?').bind(claimId).first();
        const id = existing?.id || generateUUID();
        const stmt = existing
          ? `UPDATE fsr_calculations SET
               gross_assessed=?,deductible=?,salvage=?,fr_penalty_pct=?,fr_penalty_amt=?,
               warranty_pct=?,warranty_amt=?,avg_clause_applied=?,avg_ratio=?,sum_insured=?,
               total_value=?,net_settlement=?,settlement_pct=?,
               depreciation_pct=?,depreciation_amt=?,asset_age_months=?,
               ai_calculated=?,ai_confidence=?,ai_reasoning=?,rules_source=?,
               is_overridden=?,override_reason=?,overridden_by=?,updated_at=?
             WHERE claim_id=?`
          : `INSERT INTO fsr_calculations
               (id,claim_id,tenant_id,gross_assessed,deductible,salvage,fr_penalty_pct,
                fr_penalty_amt,warranty_pct,warranty_amt,avg_clause_applied,avg_ratio,
                sum_insured,total_value,net_settlement,settlement_pct,
                depreciation_pct,depreciation_amt,asset_age_months,
                ai_calculated,ai_confidence,ai_reasoning,rules_source,
                is_overridden,override_reason,overridden_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

        const vals = existing
          ? [
              body.gross_assessed||0, body.deductible||0, body.salvage||0,
              body.fr_penalty_pct||0, body.fr_penalty_amt||0,
              body.warranty_pct||0, body.warranty_amt||0,
              body.avg_clause_applied?1:0, body.avg_ratio||1.0,
              body.sum_insured||0, body.total_value||0,
              body.net_settlement||0, body.settlement_pct||0,
              body.depreciation_pct||0, body.depreciation_amt||0, body.asset_age_months||0,
              body.ai_calculated?1:0, body.ai_confidence||null, body.ai_reasoning||null,
              body.rules_source||'insurer_custom',
              body.is_overridden?1:0, body.override_reason||null,
              body.is_overridden?user.id:null, Date.now(), claimId
            ]
          : [
              id, claimId, user.tenantId,
              body.gross_assessed||0, body.deductible||0, body.salvage||0,
              body.fr_penalty_pct||0, body.fr_penalty_amt||0,
              body.warranty_pct||0, body.warranty_amt||0,
              body.avg_clause_applied?1:0, body.avg_ratio||1.0,
              body.sum_insured||0, body.total_value||0,
              body.net_settlement||0, body.settlement_pct||0,
              body.depreciation_pct||0, body.depreciation_amt||0, body.asset_age_months||0,
              body.ai_calculated?1:0, body.ai_confidence||null, body.ai_reasoning||null,
              body.rules_source||'insurer_custom',
              body.is_overridden?1:0, body.override_reason||null,
              body.is_overridden?user.id:null, Date.now(), Date.now()
            ];

        await env.DB.prepare(stmt).bind(...vals).run();
        if (body.net_settlement) {
          await env.DB.prepare('UPDATE claims SET settlement_amount=?,settlement_percentage=?,updated_at=? WHERE id=?')
            .bind(body.net_settlement, body.settlement_pct||0, Date.now(), claimId).run();
        }
        await auditLog(env, user.tenantId, user.id, 'calculation_saved', 'fsr_calculations', id, clientIP);
        const saved = await env.DB.prepare('SELECT * FROM fsr_calculations WHERE claim_id=?').bind(claimId).first();
        return jsonResponse({ success: true, calculation: saved });
      }

      // ════════════════════════════════════════════════════════════════════
      // v5.1 — VAULT ROUTES
      // ════════════════════════════════════════════════════════════════════

      if (path === '/api/vault' && method === 'GET') {
        const q           = url.searchParams.get('q');
        const reportType  = url.searchParams.get('report_type');
        const status      = url.searchParams.get('status');
        const page        = parseInt(url.searchParams.get('page') || '1');
        const limit       = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);
        const offset      = (page - 1) * limit;

        let sql = 'SELECT * FROM vault_entries WHERE tenant_id=?';
        const params = [user.tenantId];
        if (q)           { sql += ' AND (claim_number LIKE ? OR insured_name LIKE ? OR insurer_name LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
        if (reportType)  { sql += ' AND report_type=?'; params.push(reportType); }
        if (status)      { sql += ' AND status=?'; params.push(status); }
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows  = await env.DB.prepare(sql).bind(...params).all();
        const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM vault_entries WHERE tenant_id=?').bind(user.tenantId).first();
        return jsonResponse({ entries: rows.results || [], total: total?.c || 0, page, limit });
      }

      if (path.match(/^\/api\/vault\/[^\/]+$/) && method === 'GET') {
        const entryId = path.split('/')[3];
        const entry   = await env.DB.prepare('SELECT * FROM vault_entries WHERE id=? AND tenant_id=?').bind(entryId, user.tenantId).first();
        if (!entry) return errorResponse('Vault entry not found', 404);
        await env.DB.prepare('UPDATE vault_entries SET last_accessed_by=?,last_accessed_at=?,access_count=access_count+1 WHERE id=?')
          .bind(user.id, Date.now(), entryId).run();
        return jsonResponse({ entry });
      }

      // ════════════════════════════════════════════════════════════════════
      // STAGE DEADLINES — get, extend, override
      // ════════════════════════════════════════════════════════════════════

      // GET /api/claims/:id/deadlines — fetch all stage deadlines for a claim
      if (path.match(/^\/api\/claims\/[^\/]+\/deadlines$/) && method === 'GET') {
        const claimId = path.split('/')[3];
        const rows = await env.DB.prepare(
          'SELECT * FROM stage_deadlines WHERE claim_id=? AND tenant_id=? ORDER BY created_at ASC'
        ).bind(claimId, user.tenantId).all();
        return jsonResponse({ deadlines: rows.results || [] });
      }

      // POST /api/claims/:id/deadlines/:stage — upsert a stage deadline
      if (path.match(/^\/api\/claims\/[^\/]+\/deadlines\/[^\/]+$/) && method === 'POST') {
        const parts = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const VALID_STAGES = ['jir','spot','lor','psr','interim','fsr'];
        if (!VALID_STAGES.includes(stage)) return errorResponse('Invalid stage', 400);
        const claim = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const body = await request.json();
        const {
          deadline_type, original_deadline, current_deadline,
          extended_deadline, extension_reason, override_reason, status
        } = body;
        const existing = await env.DB.prepare(
          'SELECT id FROM stage_deadlines WHERE claim_id=? AND stage=? AND tenant_id=?'
        ).bind(claimId, stage, user.tenantId).first();
        if (existing) {
          await env.DB.prepare(
            `UPDATE stage_deadlines SET deadline_type=?,current_deadline=?,extended_deadline=?,
             extension_reason=?,override_reason=?,override_approved_by=?,status=?,updated_at=?
             WHERE id=?`
          ).bind(
            deadline_type||'fixed', current_deadline||null, extended_deadline||null,
            extension_reason||null, override_reason||null,
            (deadline_type==='overridden'?user.id:null), status||'active',
            Date.now(), existing.id
          ).run();
        } else {
          const dlId = generateUUID();
          await env.DB.prepare(
            `INSERT INTO stage_deadlines
             (id,claim_id,tenant_id,stage,deadline_type,original_deadline,current_deadline,
              extended_deadline,extension_reason,override_reason,override_approved_by,
              status,created_by,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            dlId, claimId, user.tenantId, stage,
            deadline_type||'fixed', original_deadline||null, current_deadline||null,
            extended_deadline||null, extension_reason||null, override_reason||null,
            (deadline_type==='overridden'?user.id:null),
            status||'active', user.id, Date.now(), Date.now()
          ).run();
        }
        await auditLog(env, user.tenantId, user.id,
          `deadline_${deadline_type||'set'}`, 'stage_deadlines', claimId, clientIP,
          null, { stage, deadline_type, extension_reason, override_reason });
        return jsonResponse({ success: true });
      }

      // ════════════════════════════════════════════════════════════════════
      // STAGE SNAPSHOTS — versioned save per stage
      // ════════════════════════════════════════════════════════════════════

      // GET /api/claims/:id/snapshots/:stage — list all snapshots for a stage
      if (path.match(/^\/api\/claims\/[^\/]+\/snapshots\/[^\/]+$/) && method === 'GET') {
        const parts = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const rows = await env.DB.prepare(
          'SELECT id,version,status,saved_by,note,created_at FROM stage_snapshots WHERE claim_id=? AND stage=? AND tenant_id=? ORDER BY version DESC'
        ).bind(claimId, stage, user.tenantId).all();
        return jsonResponse({ snapshots: rows.results || [] });
      }

      // POST /api/claims/:id/snapshots/:stage — create versioned snapshot
      if (path.match(/^\/api\/claims\/[^\/]+\/snapshots\/[^\/]+$/) && method === 'POST') {
        const parts = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const VALID_STAGES = ['jir','spot','lor','psr','interim','fsr'];
        if (!VALID_STAGES.includes(stage)) return errorResponse('Invalid stage', 400);
        const claim = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const body = await request.json();
        const { snapshot_data, status, note } = body;
        // Get next version number
        const vRow = await env.DB.prepare(
          'SELECT MAX(version) AS max_v FROM stage_snapshots WHERE claim_id=? AND stage=? AND tenant_id=?'
        ).bind(claimId, stage, user.tenantId).first();
        const nextVersion = (vRow?.max_v || 0) + 1;
        const snapId = generateUUID();
        await env.DB.prepare(
          `INSERT INTO stage_snapshots (id,claim_id,tenant_id,stage,version,snapshot_data,status,saved_by,note,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).bind(snapId, claimId, user.tenantId, stage, nextVersion,
               snapshot_data||null, status||'saved', user.id, note||null, Date.now()).run();
        // Update current_stage on claim
        await env.DB.prepare('UPDATE claims SET current_stage=?,updated_at=? WHERE id=?')
          .bind(stage, Date.now(), claimId).run();
        return jsonResponse({ success: true, snapshot_id: snapId, version: nextVersion });
      }

      // GET /api/claims/:id/snapshots/:stage/latest — restore latest snapshot data
      if (path.match(/^\/api\/claims\/[^\/]+\/snapshots\/[^\/]+\/latest$/) && method === 'GET') {
        const parts = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const snap = await env.DB.prepare(
          'SELECT * FROM stage_snapshots WHERE claim_id=? AND stage=? AND tenant_id=? ORDER BY version DESC LIMIT 1'
        ).bind(claimId, stage, user.tenantId).first();
        return jsonResponse({ snapshot: snap || null });
      }

      // GET /api/claims/:id/snapshots/:stage/:version — fetch one specific version
      if (path.match(/^\/api\/claims\/[^\/]+\/snapshots\/[^\/]+\/\d+$/) && method === 'GET') {
        const parts   = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const version = parseInt(parts[6]);
        if (isNaN(version)) return errorResponse('Invalid version', 400);
        const snap = await env.DB.prepare(
          'SELECT * FROM stage_snapshots WHERE claim_id=? AND stage=? AND version=? AND tenant_id=?'
        ).bind(claimId, stage, version, user.tenantId).first();
        if (!snap) return errorResponse('Snapshot not found', 404);
        return jsonResponse({ snapshot: snap });
      }

      // POST /api/claims/:id/snapshots/:stage/restore — restore a specific version
      if (path.match(/^\/api\/claims\/[^\/]+\/snapshots\/[^\/]+\/restore$/) && method === 'POST') {
        const parts   = path.split('/');
        const claimId = parts[3];
        const stage   = parts[5];
        const claim = await env.DB.prepare('SELECT id FROM claims WHERE id=? AND tenant_id=?').bind(claimId, user.tenantId).first();
        if (!claim) return errorResponse('Claim not found', 404);
        const body    = await request.json();
        const version = body.version ? parseInt(body.version) : null;
        // If version specified, restore that version; otherwise restore latest
        const snap = version
          ? await env.DB.prepare(
              'SELECT * FROM stage_snapshots WHERE claim_id=? AND stage=? AND version=? AND tenant_id=?'
            ).bind(claimId, stage, version, user.tenantId).first()
          : await env.DB.prepare(
              'SELECT * FROM stage_snapshots WHERE claim_id=? AND stage=? AND tenant_id=? ORDER BY version DESC LIMIT 1'
            ).bind(claimId, stage, user.tenantId).first();
        if (!snap) return errorResponse('No snapshot found to restore', 404);
        // Update current_stage on claim
        await env.DB.prepare('UPDATE claims SET current_stage=?,updated_at=? WHERE id=?')
          .bind(stage, Date.now(), claimId).run();
        // Also upsert back into survey_reports_pipeline so pipeline resume reflects restored state
        const existing = await env.DB.prepare(
          'SELECT id FROM survey_reports_pipeline WHERE claim_id=? AND report_type=?'
        ).bind(claimId, stage).first();
        if (existing) {
          await env.DB.prepare(
            'UPDATE survey_reports_pipeline SET report_data=?,status=?,version=version+1,updated_at=? WHERE id=?'
          ).bind(snap.snapshot_data||null, snap.status||'saved', Date.now(), existing.id).run();
        } else {
          await env.DB.prepare(
            `INSERT INTO survey_reports_pipeline (id,claim_id,tenant_id,report_type,report_data,status,created_by,created_at,version)
             VALUES (?,?,?,?,?,?,?,?,1)`
          ).bind(generateUUID(), claimId, user.tenantId, stage,
                 snap.snapshot_data||null, snap.status||'saved', user.id, Date.now()).run();
        }
        await auditLog(env, user.tenantId, user.id, 'snapshot_restored', 'stage_snapshots',
          claimId, clientIP, null, { stage, version: snap.version });
        return jsonResponse({
          success:       true,
          snapshot_id:   snap.id,
          version:       snap.version,
          stage:         stage,
          status:        snap.status,
          snapshot_data: snap.snapshot_data
        });
      }

      // ════ DEFAULT 404 ══════════════════════════════════════════════════
      return errorResponse('API endpoint not found', 404);

    } catch (error) {
      console.error('API Error:', error);
      return errorResponse('Internal server error: ' + error.message, 500);
    }
  },

  // ── Cron scheduled handler ─────────────────────────────────────────────
  async scheduled(event, env, ctx) {
    console.log(`[Cron] ${event.cron} at ${new Date().toISOString()}`);
    ctx.waitUntil(runPendingDocReminders(env));
  }
};
