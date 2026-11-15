const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('crypto');
const V=require('../src/lib/passwordVault'),policy=require('../src/lib/accessPolicy');
test('Новые пароли шифруются отдельным ключом с уникальным nonce и привязкой к логину',()=>{
 process.env.USER_PASSWORD_VAULT_KEY=crypto.randomBytes(32).toString('hex');
 const password='Тестовый-пароль-42',a=V.seal(password,'worker'),b=V.seal(password,'worker');
 assert.notEqual(a,b);assert.ok(!a.includes(password));assert.equal(V.open(a,'worker'),password);
 assert.throws(()=>V.open(a,'another'),{status:409});assert.throws(()=>V.open(a.slice(0,-3)+'aaa','worker'),{status:409});
 process.env.USER_PASSWORD_VAULT_KEY=crypto.randomBytes(32).toString('hex');assert.throws(()=>V.open(a,'worker'),{status:409});
 delete process.env.USER_PASSWORD_VAULT_KEY;assert.equal(V.open(null,'worker'),null);assert.equal(V.seal(password,'worker'),null);assert.throws(()=>V.open(a,'worker'),{status:503});
});
test('Список пользователей не возвращает пароль или шифротекст, флаг сохранения доступен только владельцу',()=>{
 const own=policy.userFields({user:{login:'evgeniy',role:'owner'}}),admin=policy.userFields({user:{login:'manager',role:'admin'}});
 assert.match(own,/pass_cipher IS NOT NULL/);assert.ok(!admin.includes('pass_cipher'));assert.ok(!own.includes('pass_hash'));
});
