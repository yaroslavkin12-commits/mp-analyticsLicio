const test=require('node:test'),assert=require('node:assert/strict');
let connected=false,version=1,locked=false,calls=0,guard=null;
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async sql=>sql.includes('legacy-guard')?(guard?[{value:JSON.stringify(guard)}]:[]):[{connected}]}};
const auth=require.resolve('../src/lib/auth');require.cache[auth]={id:auth,filename:auth,loaded:true,exports:{requireAuthentication:async()=>{calls++;locked=true;}}};
const axios=require.resolve('axios');require.cache[axios]={id:axios,filename:axios,loaded:true,exports:{get:async()=>({status:200,data:{categoryAccessVersion:version,auth:locked}})}};
const readiness=require('../src/lib/accessReadiness');
test('Ограниченные профили не включаются без рабочего ключа и обновлённого старого сервера',async()=>{
 await assert.rejects(readiness.ensureReady(),e=>e.status===409);assert.equal(calls,0);
 connected=true;version=0;await assert.rejects(readiness.ensureReady(),e=>e.status===409);assert.equal(calls,0);
 version=1;await readiness.ensureReady();assert.equal(calls,1);assert.equal((await readiness.status()).locked,true);
});

test('Подтверждение старого сервера через общую БД позволяет сохранить доступ без прямого HTTP-соединения',async()=>{
 connected=true;version=0;guard={version:1,auth:true};
 assert.deepEqual(await readiness.status(),{keyConnected:true,legacyReady:true,locked:true});
 await readiness.ensureReady();assert.equal(calls,2);
});
