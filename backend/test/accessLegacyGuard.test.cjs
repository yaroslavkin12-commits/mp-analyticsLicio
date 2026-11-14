const test=require('node:test'),assert=require('node:assert/strict');
process.env.RENDER_SERVICE_ID='fixture-render';let guard;
require.cache[require.resolve('../src/db')]={exports:{getPool:()=>({}),query:async(sql,args)=>{if(sql.includes("key='auth:required:v1'"))return [{value:'1'}];if(sql.includes("VALUES('auth:legacy-guard:v1'"))guard=JSON.parse(args[0]);return [];}}};
const A=require('../src/lib/auth');
test('Старый сервер подтверждает включённую защиту через общую БД, без браузерной сессии и ключа',async()=>{
 const watcher=A.startRequirementWatch();try{await watcher.ready;assert.deepEqual(guard,{version:1,auth:true});assert.equal(A.enabled(),true);}finally{watcher.stop();delete process.env.RENDER_SERVICE_ID;}
 assert.equal(A.startRequirementWatch(),null);
});
