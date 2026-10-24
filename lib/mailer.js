const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT = '587', SMTP_USER, SMTP_PASS, MAIL_FROM, APP_URL, PORT = 4000 } = process.env;
const SITE_URL = (APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

// Without SMTP settings (local dev before credentials are added) emails are
// printed to the server console instead of sent, so every flow still works.
const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      requireTLS: Number(SMTP_PORT) !== 465,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

const isConfigured = () => !!transport;

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One branded layout for every email. Table-based with inline styles because
// that's what renders consistently across Gmail, Outlook and phone mail apps.
function layout({ preheader, heading, body, cta }) {
  const button = cta
    ? `<tr><td style="padding:8px 32px 8px"><a href="${escapeHtml(cta.url)}" style="display:inline-block;background:#6A2BD6;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:12px">${escapeHtml(cta.label)}</a></td></tr>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F5F0FF">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0FF;padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1F1530">
      <tr><td style="background:linear-gradient(135deg,#9B6BFF,#46169A);background-color:#6A2BD6;padding:22px 32px">
        <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:.12em">MADINE</span>
      </td></tr>
      <tr><td style="padding:28px 32px 6px"><h1 style="margin:0;font-size:22px;line-height:1.3">${heading}</h1></td></tr>
      <tr><td style="padding:10px 32px 14px;font-size:15px;line-height:1.6;color:#4A4060">${body}</td></tr>
      ${button}
      <tr><td style="padding:22px 32px 26px;font-size:12px;line-height:1.5;color:#8C84A0;border-top:1px solid #EEE9F7">
        You're getting this because you have a MADINE account. Jaipur's cafés, menus &amp; people.
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

async function send({ to, subject, text, html }) {
  if (!transport) {
    if (process.env.NODE_ENV === 'production') throw new Error('SMTP is not configured');
    console.log(`[mailer] SMTP not configured — would email ${to}: ${subject}\n${text}`);
    return;
  }
  const info = await transport.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
  console.log(`[mailer] sent "${subject}" to ${to} — ${info.response}`);
}

// Notification emails must never break the request that triggered them.
const sendQuietly = (msg) => send(msg).catch((err) => console.error(`Email to ${msg.to} failed:`, err.message));

function sendOtpEmail(to, code, ttlSeconds) {
  return send({
    to,
    subject: `${code} is your MADINE login code`,
    text: `Your MADINE login code is ${code}.\n\nIt expires in ${ttlSeconds} seconds. If you didn't request it, you can ignore this email.`,
    html: layout({
      preheader: `Your login code is ${code}`,
      heading: 'Your login code',
      body: `<p style="margin:0 0 6px">Enter this code on MADINE to log in:</p>
        <p style="font-size:34px;font-weight:800;letter-spacing:10px;color:#1F1530;margin:14px 0">${escapeHtml(code)}</p>
        <p style="margin:0;color:#8C84A0;font-size:13px">It expires in ${ttlSeconds} seconds. If you didn't request it, you can safely ignore this email.</p>`,
    }),
  });
}

function sendConnectionRequestEmail(to, fromProfile) {
  const name = fromProfile.name;
  const about = [fromProfile.role, (fromProfile.interests || []).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  return sendQuietly({
    to,
    subject: `${name} wants to connect with you on MADINE`,
    text: `${name}${about ? ` (${about})` : ''} sent you a connection request on MADINE.\n\nAccept it to start chatting: ${SITE_URL}/#connections`,
    html: layout({
      preheader: `${name} sent you a connection request`,
      heading: `${escapeHtml(name)} wants to connect`,
      body: `<p style="margin:0 0 10px"><b>${escapeHtml(name)}</b>${about ? ` — ${escapeHtml(about)}` : ''} sent you a connection request.</p>
        ${fromProfile.bio ? `<p style="margin:0 0 10px;padding:12px 14px;background:#F5F0FF;border-radius:12px;color:#4A4060">“${escapeHtml(fromProfile.bio)}”</p>` : ''}
        <p style="margin:0">Once you accept, you'll both be able to chat.</p>`,
      cta: { label: 'View request', url: `${SITE_URL}/#connections` },
    }),
  });
}

function sendConnectionAcceptedEmail(to, byProfile) {
  const name = byProfile.name;
  return sendQuietly({
    to,
    subject: `${name} accepted your connection request`,
    text: `${name} accepted your connection request on MADINE. You can now chat: ${SITE_URL}/#messages`,
    html: layout({
      preheader: `You and ${name} are now connected`,
      heading: `You're now connected with ${escapeHtml(name)}`,
      body: `<p style="margin:0">${escapeHtml(name)} accepted your request. Say hello and maybe suggest a café to meet at ☕</p>`,
      cta: { label: 'Start chatting', url: `${SITE_URL}/#messages` },
    }),
  });
}

module.exports = { sendOtpEmail, sendConnectionRequestEmail, sendConnectionAcceptedEmail, isConfigured };
