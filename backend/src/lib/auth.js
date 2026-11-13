// Вход в сервис по логину и паролю + ключи доступа для расширения и скриптов.
// Включается переменной AUTH_ENABLED=1 (на старом сервере Render — выключено).
// Первый администратор создаётся из ADMIN_LOGIN / ADMIN_PASSWORD, если пользователей ещё нет.
const crypto = require('crypto');
const { query } = require('../db');

const enabled = () => process.env.AUTH_ENABLED === '1';
const COOKIE = 'mp_s';
const SESSION_DAYS = 30;

let ready = null;
function ensure() {
  if (!ready) ready = (async () => {
    await query(`CREATE TABLE IF NOT EXISTS app_users (id SERIAL PRIMARY KEY, login VARCHAR(64) UNIQUE NOT NULL, name VARCHAR(128),
      pass_hash TEXT NOT NULL, role VARCHAR(16) NOT NULL DEFAULT 'user', disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(), last_login TIMESTAMPTZ)`);
    await query(`CREATE TABLE IF NOT EXISTS app_sessions (token_hash CHAR(64) PRIMARY KEY, user_id INT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS app_api_keys (id SERIAL PRIMARY KEY, name VARCHAR(128) NOT NULL, key_hash CHAR(64) UNIQUE NOT NULL,
      prefix VARCHAR(12) NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), last_used TIMESTAMPTZ)`);
    const n = await query(`SELECT COUNT(*)::int n FROM app_users`);
    const login = (process.env.ADMIN_LOGIN || '').trim(), pass = process.env.ADMIN_PASSWORD || '';
    if (!n[0].n && login && pass.length >= 8) {
      await query(`INSERT INTO app_users (login, name, pass_hash, role) VALUES ($1, $1, $2, 'admin')`, [login.toLowerCase(), hashPassword(pass)]);
      console.log(`[Auth] создан администратор ${login}`);
    }
  })().catch(e => { ready = null; throw e; });
  return ready;
}

function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pass), salt, 64);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
function checkPassword(pass, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const got = crypto.scryptSync(String(pass), Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// Сессии и ключи держим в памяти, чтобы не ходить в базу на каждый запрос.
const sessCache = new Map(); // tokenHash → { user, exp, at }
const keyCache = new Map();  // keyHash → { id, name, at }
const CACHE_MS = 60000;

function cookieOf(req) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
async function userOf(req) {
  const t = cookieOf(req);
  if (!t) return null;
  const k = sha(t), c = sessCache.get(k);
  if (c && Date.now() - c.at < CACHE_MS) return c.exp > Date.now() ? c.user : null;
  const r = await query(`SELECT u.id, u.login, u.name, u.role, s.expires_at FROM app_sessions s JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > NOW() AND NOT u.disabled`, [k]);
  if (!r.length) { sessCache.delete(k); return null; }
  const user = { id: r[0].id, login: r[0].login, name: r[0].name, role: r[0].role };
  sessCache.set(k, { user, exp: new Date(r[0].expires_at).getTime(), at: Date.now() });
  return user;
}
async function keyOf(req) {
  const v = req.get('X-Api-Key');
  if (!v) return null;
  const k = sha(v), c = keyCache.get(k);
  if (c && Date.now() - c.at < CACHE_MS) return c;
  const r = await query(`UPDATE app_api_keys SET last_used = NOW() WHERE key_hash = $1 RETURNING id, name`, [k]);
  if (!r.length) { keyCache.delete(k); return null; }
  const out = { id: r[0].id, name: r[0].name, at: Date.now() };
  keyCache.set(k, out);
  return out;
}
function dropCaches() { sessCache.clear(); keyCache.clear(); }

// Вход: защита от подбора — не больше 10 попыток за 15 минут с одного адреса.
const tries = new Map();
function tooMany(ip) {
  const now = Date.now(), l = (tries.get(ip) || []).filter(t => now - t < 15 * 60000);
  tries.set(ip, l);
  return l.length >= 10;
}
async function login(req, res) {
  await ensure();
  const ip = req.ip || 'x';
  if (tooMany(ip)) return res.status(429).json({ success: false, error: 'Слишком много попыток. Подождите 15 минут.' });
  const { login: l, password } = req.body || {};
  const r = await query(`SELECT id, pass_hash, disabled FROM app_users WHERE login = $1`, [String(l || '').trim().toLowerCase()]);
  if (!r.length || r[0].disabled || !checkPassword(password, r[0].pass_hash)) {
    tries.get(ip).push(Date.now());
    return res.status(401).json({ success: false, error: 'Неверный логин или пароль' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO app_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '${SESSION_DAYS} days')`, [sha(token), r[0].id]);
  await query(`UPDATE app_users SET last_login = NOW() WHERE id = $1`, [r[0].id]);
  await query(`DELETE FROM app_sessions WHERE expires_at < NOW()`).catch(() => {});
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ success: true });
}
async function logout(req, res) {
  const t = cookieOf(req);
  if (t) { await query(`DELETE FROM app_sessions WHERE token_hash = $1`, [sha(t)]).catch(() => {}); sessCache.delete(sha(t)); }
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ success: true });
}

// Пути, которые пускаем без входа: проверка жизни, страница входа и
// приём данных со своей подписью (Google-скрипт, мост WB).
const OPEN = [/^\/health$/, /^\/login$/, /^\/api\/auth\/(login|logout)$/, /^\/api\/queries\/ingest$/, /^\/api\/wb\/import$/, /^\/api\/ops\/status$/];

function middleware() {
  return async (req, res, next) => {
    if (!enabled()) return next();
    if (OPEN.some(re => re.test(req.path))) return next();
    try {
      await ensure();
      const user = await userOf(req);
      if (user) { req.user = user; return next(); }
      if (req.path.startsWith('/api/')) {
        const key = await keyOf(req);
        if (key) { req.apiKey = key; return next(); }
        return res.status(401).json({ success: false, error: 'Нужен вход', auth: true });
      }
      return res.redirect(302, '/login');
    } catch (e) { console.error('[Auth]', e.message); res.status(500).send('Ошибка проверки входа'); }
  };
}

const isAdmin = req => !enabled() || req.user?.role === 'admin';

module.exports = { ensure, enabled, middleware, login, logout, hashPassword, checkPassword, sha, dropCaches, isAdmin };
