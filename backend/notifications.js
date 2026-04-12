// backend/notifications.js
// McLarens Nexus Enterprise v5.0
// Real Email (Resend) + Real SMS (Twilio) notification system

// ── Email via Resend ──────────────────────────────────────────────────────
export async function sendEmail(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY) {
    console.warn('[Notifications] RESEND_API_KEY not set — email skipped');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from:     env.RESEND_FROM || 'McLarens Nexus <noreply@mclarens.in>',
      to:       Array.isArray(to) ? to : [to],
      subject,
      html,
      reply_to: replyTo || undefined
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Resend] Email failed:', err);
    return { success: false, error: err };
  }

  const data = await res.json();
  return { success: true, id: data.id };
}

// ── SMS via Twilio ────────────────────────────────────────────────────────
export async function sendSMS(env, { to, body }) {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    console.warn('[Notifications] Twilio credentials not set — SMS skipped');
    return { skipped: true };
  }

  // Ensure Indian number format: +91XXXXXXXXXX
  const formatted = to.startsWith('+') ? to : `+91${to.replace(/\D/g, '').slice(-10)}`;

  const credentials = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      From: env.TWILIO_PHONE_NUMBER || '+1234567890',
      To:   formatted,
      Body: body
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Twilio] SMS failed:', err);
    return { success: false, error: err };
  }

  const data = await res.json();
  return { success: true, sid: data.sid };
}

// ── Reminder email template ───────────────────────────────────────────────
export function buildPendingDocReminderEmail({
  claimNumber, insuredName, insurerName, pendingDocs, reminderCount, surveyorName
}) {
  const docList = pendingDocs
    .map(d => `<li style="padding:6px 0;border-bottom:1px solid #eee;">
      <strong>${d.document_name}</strong>
      ${d.is_mandatory ? '<span style="color:#e85555;font-size:12px;"> (MANDATORY)</span>' : ''}
      — Required by: ${d.required_by}
    </li>`)
    .join('');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px;">
  <div style="background:#0a0c0f;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#e8a020;font-size:18px;margin:0;">McLarens Nexus Enterprise</h1>
    <p style="color:#8892aa;font-size:12px;margin:4px 0 0;">Document Pending Reminder · ${new Date().toLocaleDateString('en-IN')}</p>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0;border-top:none;">
    <p style="color:#333;font-size:14px;">Dear <strong>${insuredName}</strong>,</p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      This is reminder <strong>#${reminderCount}</strong> regarding your insurance claim 
      <strong style="color:#e8a020;">${claimNumber}</strong> with <strong>${insurerName}</strong>.
    </p>
    <p style="color:#555;font-size:14px;">The following documents are still pending:</p>
    <ul style="padding-left:20px;color:#333;">${docList}</ul>
    <div style="background:#fff8e6;border:1px solid #f0c040;border-radius:6px;padding:14px;margin-top:16px;">
      <p style="margin:0;font-size:13px;color:#8a6000;">
        ⚠ <strong>Please submit these documents at the earliest</strong> to avoid delays in your claim settlement.
        Reminders are sent every <strong>2 days</strong> until all documents are received.
      </p>
    </div>
    <p style="color:#555;font-size:13px;margin-top:16px;">Surveyor: <strong>${surveyorName || 'McLarens Survey Team'}</strong></p>
    <p style="color:#888;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      This is an automated reminder from McLarens Nexus Enterprise. For queries, contact your assigned surveyor directly.
    </p>
  </div>
</body>
</html>`;
}

// ── Reminder SMS template ─────────────────────────────────────────────────
export function buildPendingDocReminderSMS({
  claimNumber, pendingCount, insurerName, reminderCount
}) {
  return `McLarens Claim ${claimNumber} (${insurerName}): ${pendingCount} document(s) pending. Reminder #${reminderCount}. Please submit at earliest to avoid settlement delay. -McLarens Nexus`;
}

// ── Claim status change notification ─────────────────────────────────────
export function buildStatusChangeEmail({ claimNumber, insuredName, oldStatus, newStatus, surveyorName }) {
  const statusColors = {
    intimated: '#5b9cf6', in_progress: '#e8a020',
    submitted: '#22c4a0', settled: '#5ec67a', rejected: '#e85555'
  };
  const color = statusColors[newStatus] || '#666';

  return `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px;">
  <div style="background:#0a0c0f;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#e8a020;font-size:18px;margin:0;">McLarens Nexus Enterprise</h1>
    <p style="color:#8892aa;font-size:12px;margin:4px 0 0;">Claim Status Update</p>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0;border-top:none;">
    <p style="color:#333;font-size:14px;">Dear <strong>${insuredName}</strong>,</p>
    <p style="color:#555;font-size:14px;line-height:1.6;">
      Your claim <strong style="color:#e8a020;">${claimNumber}</strong> status has been updated:
    </p>
    <div style="display:flex;align-items:center;gap:12px;margin:16px 0;">
      <span style="background:#eee;padding:6px 14px;border-radius:4px;font-size:13px;">${oldStatus.replace('_',' ').toUpperCase()}</span>
      <span style="font-size:18px;">→</span>
      <span style="background:${color}22;border:1px solid ${color}44;color:${color};padding:6px 14px;border-radius:4px;font-size:13px;font-weight:bold;">${newStatus.replace('_',' ').toUpperCase()}</span>
    </div>
    <p style="color:#555;font-size:13px;">Surveyor: <strong>${surveyorName || 'McLarens Survey Team'}</strong></p>
    <p style="color:#888;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      Automated notification from McLarens Nexus Enterprise.
    </p>
  </div>
</body></html>`;
}

// ── AI breach detection alert ─────────────────────────────────────────────
export function buildBreachAlertEmail({ claimNumber, insurerName, breaches, surveyorName }) {
  const breachList = breaches.map(b =>
    `<li style="padding:8px 0;border-bottom:1px solid #fdd;">
      <strong style="color:#c00;">${b.type}</strong>: ${b.description}
      ${b.penalty_pct ? `<br><span style="color:#e85555;font-size:12px;">Penalty: ${b.penalty_pct}%</span>` : ''}
      ${b.evidence ? `<br><em style="color:#888;font-size:12px;">Evidence: ${b.evidence}</em>` : ''}
    </li>`
  ).join('');

  return `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f5f5f5;padding:20px;">
  <div style="background:#c00;padding:20px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;font-size:18px;margin:0;">⚠ Warranty Breach Alert</h1>
    <p style="color:#ffaaaa;font-size:12px;margin:4px 0 0;">McLarens Nexus AI Detection · Claim ${claimNumber}</p>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e0e0e0;border-top:none;">
    <p style="color:#333;font-size:14px;">Insurer: <strong>${insurerName}</strong></p>
    <p style="color:#c00;font-size:14px;font-weight:bold;">${breaches.length} breach(es) detected by AI:</p>
    <ul style="padding-left:20px;color:#333;">${breachList}</ul>
    <p style="color:#555;font-size:13px;margin-top:12px;">Surveyor: <strong>${surveyorName}</strong></p>
    <p style="color:#888;font-size:11px;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">
      Requires human review and confirmation before applying to settlement.
    </p>
  </div>
</body></html>`;
}
