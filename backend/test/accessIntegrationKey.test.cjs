const test=require('node:test'),assert=require('node:assert/strict');
process.env.AUTH_ENABLED='1';let updates=0,sessionReads=0,A;
const query=async(sql,args)=>{
 if(sql.includes('COUNT(*)::int n FROM app_users'))return [{n:1}];
 if(sql.startsWith('UPDATE app_api_keys')){updates++;return args[0]===A.sha('test-valid-key')?[{id:4,name:'Расширение'}]:[];}
 if(sql.includes('JOIN app_users')){sessionReads++;return [{id:1,login:'evgeniy',role:'owner'}];}
 return [];
};
require.cache[require.resolve('../src/db')]={exports:{query,getPool:()=>({connect:async()=>({query:async()=>({rows:[]}),release(){}})})}};
A=require('../src/lib/auth');
async function call(key){const req={path:'/api/discounts/targets',headers:{cookie:'mp_s=owner-session'},get:()=>key};const res={code:200,status(c){this.code=c;return this},json(b){this.body=b;return this},send(){},redirect(){}};let passed=false;await A.middleware()(req,res,()=>{passed=true});return {req,res,passed};}
test('Переданный ключ проверяется независимо от сессии владельца; неверный ключ нельзя скрыть за cookie',async()=>{
 const valid=await call('test-valid-key');assert.equal(valid.passed,true);assert.equal(valid.req.apiKey.id,4);assert.equal(valid.req.user,undefined);assert.equal(updates,1);assert.equal(sessionReads,0);
 const invalid=await call('test-invalid-key');assert.equal(invalid.passed,false);assert.equal(invalid.res.code,401);assert.equal(sessionReads,0);
 const browser=await call(undefined);assert.equal(browser.passed,true);assert.equal(browser.req.user.role,'owner');assert.equal(sessionReads,1);
});
