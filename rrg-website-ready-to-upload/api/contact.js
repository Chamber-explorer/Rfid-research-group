/**
 * Contact form handler (Vercel serverless function, POST /api/contact).
 *
 * Sends the enquiry by email through the Resend REST API. Settings come from environment variables
 * set in the Vercel project (never in the page or the repository):
 *   RESEND_API_KEY   required. Resend API key.
 *   CONTACT_FROM     required. A sender on a domain verified in Resend,
 *                    for example "RRG Website <website@rfidresearchgroup.com>".
 *   CONTACT_TO       optional. Receiving mailbox. Default: marketing@rfidresearchgroup.com.
 *
 * The recipient is fixed here and is never read from the request, so this cannot be used to mail
 * other people. Spam protection: same-site check, hidden honeypot field, minimum fill time, field
 * length limits, header-injection clean-up and a per-address rate limit. The rate limit is kept in
 * memory per function instance, so it is a basic brake and not a guarantee.
 */
const DEFAULT_TO = 'marketing@rfidresearchgroup.com';
const MIN_FILL_MS = 3000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LIMITS = { name: 100, email: 254, phone: 30, message: 5000 };
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{6,24}$/;

const hits = new Map();

const oneLine = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const multiLine = (value) =>
  String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

function tooMany(ip, now) {
  const recent = (hits.get(ip) || []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return false;
}

async function handler(req, res) {
  const reply = (status, body) => res.status(status).json(body);

  // Self-check: open /api/contact in a browser. It says whether the function is deployed and whether the
  // two required settings exist. It never shows any value, only the names of settings that are missing.
  if (req.method === 'GET') {
    const missing = [!process.env.RESEND_API_KEY && 'RESEND_API_KEY', !process.env.CONTACT_FROM && 'CONTACT_FROM'].filter(Boolean);
    return reply(200, { ok: true, deployed: true, configured: missing.length === 0, missing });
  }

  if (req.method !== 'POST') {
    if (res.setHeader) res.setHeader('Allow', 'GET, POST');
    return reply(405, { ok: false, error: 'method' });
  }

  // Same-site only: browsers always send Origin on a cross-origin or fetch POST.
  const origin = String(req.headers?.origin || '');
  let originHost = '';
  try { originHost = new URL(origin).host; } catch { /* leave empty */ }
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '');
  if (!originHost || originHost !== host) return reply(403, { ok: false, error: 'origin' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') return reply(400, { ok: false, error: 'invalid' });

  // Honeypot: real visitors never see this field. Answer as if it worked, send nothing.
  if (String(body.website ?? '').trim()) return reply(200, { ok: true });

  const now = Date.now();
  const startedAt = Number(body.startedAt);
  if (!Number.isFinite(startedAt) || now - startedAt < MIN_FILL_MS || now - startedAt > MAX_AGE_MS) {
    return reply(400, { ok: false, error: 'timing' });
  }

  const name = oneLine(body.name);
  const email = oneLine(body.email);
  const phone = oneLine(body.phone);
  const message = multiLine(body.message);
  if (
    !name || name.length > LIMITS.name ||
    !email || email.length > LIMITS.email || !EMAIL.test(email) ||
    !phone || phone.length > LIMITS.phone || !PHONE.test(phone) ||
    !message || message.length > LIMITS.message
  ) {
    return reply(400, { ok: false, error: 'invalid' });
  }

  const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip, now)) return reply(429, { ok: false, error: 'rate' });

  const key = process.env.RESEND_API_KEY;
  const from = process.env.CONTACT_FROM;
  const to = (process.env.CONTACT_TO || DEFAULT_TO).trim();
  if (!key || !from) {
    console.error('contact: RESEND_API_KEY or CONTACT_FROM is not set');
    return reply(503, { ok: false, error: 'not-configured' });
  }

  const text = [
    'New enquiry from the RRG website contact form.',
    '',
    `Name:  ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    '',
    'Message:',
    message,
  ].join('\n');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `Website enquiry from ${name}`.slice(0, 150),
        text,
      }),
    });
    if (!response.ok) {
      // The reason goes to the Vercel function log (never to the visitor). It holds no secret:
      // Resend answers with a name and a message, for example "validation_error: The domain is not verified".
      let detail = '';
      try {
        const answer = await response.json();
        detail = [answer.name, answer.message].filter(Boolean).join(': ').slice(0, 300);
      } catch { /* no readable body */ }
      console.error(`contact: email service answered ${response.status}${detail ? ` (${detail})` : ''}`);
      return reply(502, { ok: false, error: 'send' });
    }
  } catch (error) {
    console.error(`contact: email service not reachable (${String((error && error.message) || error).slice(0, 200)})`);
    return reply(502, { ok: false, error: 'send' });
  }
  return reply(200, { ok: true });
}

module.exports = handler;
module.exports.hits = hits;
