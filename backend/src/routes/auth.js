// Управление пользователями и личный журнал главного администратора.
const express = require('express');
const crypto = require('crypto');
const { query, getPool } = require('../db');
const A = require('../lib/auth');
const policy = require('../lib/accessPolicy');
const activity = require('../lib/accessActivity');
const router = express.Router();
const wrap = fn => async (req, res) => { try { await A.ensure(); await fn(req, res); } catch (e) { console.error('[Auth]', e.message); res.status(e.status || 500).json({ success: false, error: e.message }); } };
const admin = (req, res) => { if (A.isAdmin(req)) return true; res.status(403).json({ success: false, error: 'Только для администратора' }); return false; };
const owner = (req, res) => { if (A.isOwner(req)) return true; res.status(403).json({ success: false, error: 'Доступно только главному администратору' }); return false; };
const LOGIN_RE = /^[a-z0-9._-]{3,64}$/;
router.post('/login', wrap(A.login));
router.post('/logout', wrap(A.logout));
router.get('/me', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: A.enabled() ? (req.user ? { ...req.user, auth: true } : null) : { login: '', role: 'user', auth: false } });
}));
router.post('/password', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Нужен вход' });
  const { current, next } = req.body || {};
  if (String(next || '').length < 8) return res.status(400).json({ success: false, error: 'Новый пароль — не короче 8 символов' });
  const r = await query('SELECT pass_hash FROM app_users WHERE id=$1', [req.user.id]);
  if (!r.length || !A.checkPassword(current, r[0].pass_hash)) return res.status(400).json({ success: false, error: 'Текущий пароль неверный' });
  await query('UPDATE app_users SET pass_hash=$1 WHERE id=$2', [A.hashPassword(next), req.user.id]);
  res.json({ success: true });
}));
router.get('/users', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  res.set('Cache-Control', 'no-store');
  const where = A.isOwner(req) ? '' : " WHERE role='user' AND login<>'evgeniy'";
  res.json({ success: true, data: await query(`SELECT ${policy.userFields(req)} FROM app_users${where} ORDER BY id`) });
}));
router.post('/users', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  const { id, login, name, role, password, disabled } = req.body || {};
  if (password && String(password).length < 8) return res.status(400).json({ success: false, error: 'Пароль — не короче 8 символов' });
  if (id) {
    if (!owner(req, res)) return;
    if (!Number.isInteger(Number(id)) || Number(id) < 1) return res.status(400).json({ success: false, error: 'Неверный пользователь' });
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT id, login, role, disabled FROM app_users WHERE id=$1 FOR UPDATE', [id]);
      const target = rows[0];
      if (!target) throw Object.assign(Error('Пользователь не найден'), { status: 404 });
      if (policy.isProtected(target) && (disabled || (role && role !== 'owner'))) throw Object.assign(Error('Нельзя отключить главного администратора или изменить его роль'), { status: 400 });
      if (!policy.isProtected(target) && role && !['admin', 'user'].includes(role)) throw Object.assign(Error('Неизвестная роль'), { status: 400 });
      await client.query('UPDATE app_users SET name=COALESCE($2,name), role=$3, disabled=$4 WHERE id=$1', [id, typeof name === 'string' ? name.slice(0, 128) : null, policy.isProtected(target) ? 'owner' : (role || target.role), disabled === undefined ? target.disabled : !!disabled]);
      if (password) await client.query('UPDATE app_users SET pass_hash=$2 WHERE id=$1', [id, A.hashPassword(password)]);
      if (password || disabled) await client.query('DELETE FROM app_sessions WHERE user_id=$1', [id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    A.dropCaches();
    return res.json({ success: true });
  }
  if ((!A.isOwner(req) && role && role !== 'user') || role === 'owner') return res.status(403).json({ success: false, error: 'Нельзя назначить эту роль' });
  const l = String(login || '').trim().toLowerCase();
  if (!LOGIN_RE.test(l)) return res.status(400).json({ success: false, error: 'Логин: 3–64 символа, латиница, цифры, точка, дефис' });
  if (l === policy.OWNER_LOGIN) return res.status(403).json({ success: false, error: 'Этот логин принадлежит главному администратору' });
  if (String(password || '').length < 8) return res.status(400).json({ success: false, error: 'Пароль — не короче 8 символов' });
  if ((await query('SELECT 1 FROM app_users WHERE login=$1', [l])).length) return res.status(400).json({ success: false, error: 'Такой логин уже есть' });
  await query('INSERT INTO app_users (login,name,pass_hash,role) VALUES ($1,$2,$3,$4)', [l, String(name || l).slice(0, 128), A.hashPassword(password), A.isOwner(req) && role === 'admin' ? 'admin' : 'user']);
  res.json({ success: true });
}));
router.delete('/users/:id', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ success: false, error: 'Неверный пользователь' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id,login,role FROM app_users WHERE id=$1 FOR UPDATE', [id]);
    const target = rows[0];
    if (!target) throw Object.assign(Error('Пользователь не найден'), { status: 404 });
    if (policy.isProtected(target) || id === req.user.id || (!A.isOwner(req) && target.role !== 'user')) throw Object.assign(Error('Нельзя удалить этого пользователя'), { status: 403 });
    await client.query('DELETE FROM app_users WHERE id=$1', [id]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  A.dropCaches();
  res.json({ success: true });
}));
router.get('/keys', wrap(async (req, res) => {
  if (!owner(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await query('SELECT id,name,prefix,created_at,last_used FROM app_api_keys ORDER BY id') });
}));
router.post('/keys', wrap(async (req, res) => {
  if (!owner(req, res)) return;
  const name = String(req.body?.name || '').trim().slice(0, 128) || 'Ключ';
  const key = 'dfk_' + crypto.randomBytes(24).toString('base64url');
  await query('INSERT INTO app_api_keys (name,key_hash,prefix) VALUES ($1,$2,$3)', [name, A.sha(key), key.slice(0, 10)]);
  res.json({ success: true, data: { key } });
}));
router.delete('/keys/:id', wrap(async (req, res) => {
  if (!owner(req, res)) return;
  await query('DELETE FROM app_api_keys WHERE id=$1', [req.params.id]);
  A.dropCaches(); res.json({ success: true });
}));
router.post('/activity', wrap(async (req, res) => {
  const hash = A.sessionHash(req);
  if (!req.user || !hash) return res.status(401).json({ success: false, error: 'Нужен вход', auth: true });
  const input = activity.cleanInput(req.body);
  if (!input) return res.status(400).json({ success: false, error: 'Неверные данные посещения' });
  await activity.heartbeat(req.user, hash, input, ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.ip));
  res.set('Cache-Control', 'no-store'); res.json({ success: true });
}));
router.get('/activity/report', wrap(async (req, res) => {
  if (!owner(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, data: await activity.report(req.query) });
}));
module.exports = router;
