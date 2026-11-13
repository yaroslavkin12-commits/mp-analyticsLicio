// /api/auth — вход, выход, пользователи и ключи доступа (управляет администратор).
const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const A = require('../lib/auth');
const router = express.Router();

const wrap = fn => async (req, res) => { try { await A.ensure(); await fn(req, res); } catch (e) { console.error('[Auth]', e.message); res.status(500).json({ success: false, error: e.message }); } };
const admin = (req, res) => { if (A.isAdmin(req)) return true; res.status(403).json({ success: false, error: 'Только для администратора' }); return false; };
const LOGIN_RE = /^[a-z0-9._-]{3,64}$/;

router.post('/login', wrap(A.login));
router.post('/logout', wrap(A.logout));

// Кто вошёл. Без включённого входа — «все права», чтобы старый сервер работал как раньше.
router.get('/me', wrap(async (req, res) => {
  res.json({ success: true, data: A.enabled() ? (req.user ? { ...req.user, auth: true } : null) : { login: '', role: 'admin', auth: false } });
}));

// Смена своего пароля.
router.post('/password', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Нужен вход' });
  const { current, next } = req.body || {};
  if (String(next || '').length < 8) return res.status(400).json({ success: false, error: 'Новый пароль — не короче 8 символов' });
  const r = await query(`SELECT pass_hash FROM app_users WHERE id = $1`, [req.user.id]);
  if (!r.length || !A.checkPassword(current, r[0].pass_hash)) return res.status(400).json({ success: false, error: 'Текущий пароль неверный' });
  await query(`UPDATE app_users SET pass_hash = $1 WHERE id = $2`, [A.hashPassword(next), req.user.id]);
  res.json({ success: true });
}));

// Пользователи.
router.get('/users', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  res.json({ success: true, data: await query(`SELECT id, login, name, role, disabled, created_at, last_login FROM app_users ORDER BY id`) });
}));
router.post('/users', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  const { id, login, name, role, password, disabled } = req.body || {};
  const r = role === 'admin' ? 'admin' : 'user';
  if (id) {
    if (req.user && Number(id) === req.user.id && (r !== 'admin' || disabled)) return res.status(400).json({ success: false, error: 'Нельзя снять права или отключить самого себя' });
    await query(`UPDATE app_users SET name = COALESCE($2, name), role = $3, disabled = $4 WHERE id = $1`, [id, name ?? null, r, !!disabled]);
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ success: false, error: 'Пароль — не короче 8 символов' });
      await query(`UPDATE app_users SET pass_hash = $2 WHERE id = $1`, [id, A.hashPassword(password)]);
      await query(`DELETE FROM app_sessions WHERE user_id = $1`, [id]);
    }
    if (disabled) await query(`DELETE FROM app_sessions WHERE user_id = $1`, [id]);
    A.dropCaches();
    return res.json({ success: true });
  }
  const l = String(login || '').trim().toLowerCase();
  if (!LOGIN_RE.test(l)) return res.status(400).json({ success: false, error: 'Логин: 3–64 символа, латиница, цифры, точка, дефис' });
  if (String(password || '').length < 8) return res.status(400).json({ success: false, error: 'Пароль — не короче 8 символов' });
  const ex = await query(`SELECT 1 FROM app_users WHERE login = $1`, [l]);
  if (ex.length) return res.status(400).json({ success: false, error: 'Такой логин уже есть' });
  await query(`INSERT INTO app_users (login, name, pass_hash, role) VALUES ($1, $2, $3, $4)`, [l, String(name || l).slice(0, 128), A.hashPassword(password), r]);
  res.json({ success: true });
}));
router.delete('/users/:id', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  if (req.user && Number(req.params.id) === req.user.id) return res.status(400).json({ success: false, error: 'Нельзя удалить самого себя' });
  await query(`DELETE FROM app_users WHERE id = $1`, [req.params.id]);
  A.dropCaches();
  res.json({ success: true });
}));

// Ключи доступа (расширение «Соинвест» и другие программы). Сам ключ показываем один раз.
router.get('/keys', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  res.json({ success: true, data: await query(`SELECT id, name, prefix, created_at, last_used FROM app_api_keys ORDER BY id`) });
}));
router.post('/keys', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  const name = String(req.body?.name || '').trim().slice(0, 128) || 'Ключ';
  const key = 'dfk_' + crypto.randomBytes(24).toString('base64url');
  await query(`INSERT INTO app_api_keys (name, key_hash, prefix) VALUES ($1, $2, $3)`, [name, A.sha(key), key.slice(0, 10)]);
  res.json({ success: true, data: { key } });
}));
router.delete('/keys/:id', wrap(async (req, res) => {
  if (!admin(req, res)) return;
  await query(`DELETE FROM app_api_keys WHERE id = $1`, [req.params.id]);
  A.dropCaches();
  res.json({ success: true });
}));

module.exports = router;
