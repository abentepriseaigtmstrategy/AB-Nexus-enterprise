// backend/auth.js — McLarens Nexus Enterprise v5.0
// Cloudflare Worker auth helpers — Web Crypto API only (no Node.js)

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromB64url(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

export async function generateToken(payload, secret) {
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(enc.encode(JSON.stringify({ ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 86400*7 })));
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(sig)}`;
}

export async function verifyToken(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    if (!header || !body || !sig) return null;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name:'HMAC', hash:'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, fromB64url(sig), enc.encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body)));
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}

export async function hashPassword(password) {
  const enc = new TextEncoder();
  const saltBuf = crypto.getRandomValues(new Uint8Array(16));
  const salt = b64url(saltBuf);
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hashBuf = await crypto.subtle.deriveBits({ name:'PBKDF2', salt:saltBuf, iterations:100000, hash:'SHA-256' }, keyMat, 256);
  return { hash: b64url(hashBuf), salt };
}

export async function verifyPassword(password, storedHash, storedSalt) {
  try {
    const enc = new TextEncoder();
    const saltBuf = fromB64url(storedSalt);
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const hashBuf = await crypto.subtle.deriveBits({ name:'PBKDF2', salt:saltBuf, iterations:100000, hash:'SHA-256' }, keyMat, 256);
    return b64url(hashBuf) === storedHash;
  } catch { return false; }
}

export function generateSecureToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sendMagicLink(email, token, env) {
  const base = env.FRONTEND_URL || 'https://ab-nexus-enterprise.pages.dev';
  const link = `${base}/index.html?magic=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  await env.DB.prepare('UPDATE users SET magic_link_token=?, magic_link_expires=? WHERE email=?')
    .bind(token, Date.now() + 15*60*1000, email).run();
  if (env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.RESEND_FROM || 'AB Nexus <noreply@mclarens.in>', to: [email], subject: 'Your AB Nexus sign-in link', html: `<p>Click to sign in (expires 15 min): <a href="${link}">Sign In</a></p>` })
    }).catch(() => {});
  }
  return link;
}

export async function verifyGoogleToken(idToken, clientId) {
  try {
    const certsRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    const certs = await certsRes.json();
    const [headerB64, payloadB64] = idToken.split('.');
    const header = JSON.parse(new TextDecoder().decode(fromB64url(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(payloadB64)));
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com','https://accounts.google.com'].includes(payload.iss)) return null;
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    const jwk = certs.keys.find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
    const enc = new TextEncoder();
    const [hdr, bdy, sig] = idToken.split('.');
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(sig), enc.encode(`${hdr}.${bdy}`));
    if (!valid) return null;
    return { googleId: payload.sub, email: payload.email, name: payload.name, picture: payload.picture, verified: payload.email_verified === true || payload.email_verified === 'true' };
  } catch { return null; }
}

export async function createSession(userId, token, env, ip, userAgent) {
  const expires = Date.now() + 7*24*60*60*1000;
  await env.DB.prepare('INSERT OR REPLACE INTO sessions (id, user_id, expires_at, ip_address, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(token, userId, expires, ip||null, userAgent||null, Date.now()).run();
}

export async function destroySession(token, env) {
  await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(token).run();
}
