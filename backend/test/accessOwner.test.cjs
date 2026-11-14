const { test } = require('node:test');
const assert = require('node:assert/strict');
let rows, writes, connections;
const query = async sql => sql.includes('COUNT(*)::int n FROM app_users') ? [{ n: rows.length }] : [];
const client = { async query(sql, args = []) {
  if (sql.includes("SELECT id FROM app_users WHERE login = 'evgeniy'")) return { rows: rows.filter(u => u.login === 'evgeniy') };
  if (sql.includes('SELECT id, pass_hash FROM app_users WHERE login = $1')) return { rows: rows.filter(u => u.login === args[0]) };
  if (sql.startsWith('UPDATE app_users')) {
    writes.push(sql); const target = rows.find(u => u.id === args[0]);
    if (sql.includes("login = 'evgeniy'")) target.login = 'evgeniy';
    target.role = 'owner'; target.disabled = false;
  }
  return { rows: [] };
}, release() {} };
require.cache[require.resolve('../src/db')] = { exports: { query, getPool: () => ({ connect: async () => { connections++; return client; } }) } };
function fresh() { delete require.cache[require.resolve('../src/lib/auth')]; return require('../src/lib/auth'); }
test('Существующий evgeniy становится единственным владельцем без изменения пароля и сессий', async () => {
  const A = fresh(), hash = A.hashPassword('fixture-password');
  rows = [{ id: 1, login: 'evgeniy', role: 'admin', pass_hash: hash }, { id: 2, login: 'manager', role: 'admin' }]; writes = []; connections = 0;
  await Promise.all([A.ensure(), A.ensure()]);
  assert.equal(rows[0].role, 'owner'); assert.equal(rows[0].pass_hash, hash); assert.equal(rows[1].role, 'admin'); assert.equal(connections, 1);
});
test('Первоначальная учётная запись переносится на evgeniy только после проверки её действующего пароля', async () => {
  process.env.ADMIN_LOGIN = 'legacy'; process.env.ADMIN_PASSWORD = 'fixture-password';
  let A = fresh(); const hash = A.hashPassword(process.env.ADMIN_PASSWORD);
  rows = [{ id: 5, login: 'legacy', role: 'admin', pass_hash: hash }]; writes = []; connections = 0;
  await A.ensure(); assert.equal(rows[0].id, 5); assert.equal(rows[0].login, 'evgeniy'); assert.equal(rows[0].pass_hash, hash);
  A = fresh(); rows = [{ id: 6, login: 'legacy', role: 'admin', pass_hash: A.hashPassword('different-password') }]; writes = [];
  await A.ensure(); assert.equal(rows[0].login, 'legacy'); assert.equal(rows[0].role, 'admin'); assert.equal(writes.length, 0);
});
