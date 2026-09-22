/*
 * Sessies via een ondertekende cookie (HMAC-SHA256).
 * Werkt zonder server-side opslag en dus ook op Vercel (serverless).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'duos_auth';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let secret = process.env.SESSION_SECRET || '';
if (!secret && !process.env.VERCEL) {
  const secretFile = path.join(__dirname, '..', 'data', 'session-secret.txt');
  try { secret = fs.readFileSync(secretFile, 'utf-8').trim(); } catch (e) {}
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, secret);
  }
}
if (!secret) {
  // Op Vercel hoort SESSION_SECRET als environment variable ingesteld te zijn
  console.warn('SESSION_SECRET ontbreekt — er wordt een tijdelijke sleutel gebruikt (logins vervallen bij een nieuwe instance).');
  secret = crypto.randomBytes(32).toString('hex');
}

function sign(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + mac;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (e) { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function middleware(req, res, next) {
  const cookies = parseCookies(req);
  req.auth = verify(cookies[COOKIE]);
  next();
}

function login(res, user) {
  const token = sign({
    userId: user.id,
    displayName: user.display_name || user.username,
    exp: Date.now() + MAX_AGE_MS,
  });
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
  ];
  if (process.env.VERCEL) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function logout(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { middleware, login, logout };
