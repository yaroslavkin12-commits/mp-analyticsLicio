const test=require('node:test'),assert=require('node:assert/strict');
let connected=false,version=1,locked=false,calls=0;
const db=require.resolve('../src/db');require.cache[db]={id:db,filename:db,loaded:true,exports:{query:async()=>[{connected}]}};
const auth=require.resolve('../src/lib/auth');require.cache[auth]={id:auth,filename:auth,loaded:true,exports:{requireAuthentication:async()=>{calls++;locked=true;}}};
const axios=require.resolve('axios');require.cache[axios]={id:axios,filename:axios,loaded:true,exports:{get:async()=>({status:200,data:{categoryAccessVersion:version,auth:locked}})}};
const readiness=require('../src/lib/accessReadiness');
test('Ограниченные профили не включаются без рабочего ключа и обновлённого старого сервера',async()=>{
 await assert.rejects(readiness.ensureReady(),e=>e.status===409);assert.equal(calls,0);
 connected=true;version=0;await assert.rejects(readiness.ensureReady(),e=>e.status===409);assert.equal(calls,0);
 version=1;await readiness.ensureReady();assert.equal(calls,1);assert.equal((await readiness.status()).locked,true);
});
