const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../deploy/yandex/activate-access.cjs'),'utf8');
async function run(key,guard,required=false){let writes=0,result;
 class Client{async connect(){}async end(){}async query(sql){if(sql.startsWith('INSERT')){writes++;return {rows:[]}}if(sql.includes('app_api_keys'))return {rows:[{ready:key}]};if(sql.includes('legacy-guard'))return {rows:guard?[{value:JSON.stringify(guard)}]:[]};return {rows:required?[{value:'1'}]:[]}}}
 const ctx=vm.createContext({Date,JSON,require:name=>name==='fs'?{readFileSync:()=>'',writeFileSync:(p,s)=>{result=JSON.parse(s)}}:name.endsWith('/dotenv')?{parse:()=>({DATABASE_URL:'postgres://localhost/fixture'})}:{Client}});
 await vm.runInContext(source,ctx);return {writes,result:result.legacyProtection};
}
test('Закрытие старого адреса ждёт рабочего ключа и актуальной регистрации защиты; подтверждение не выдаётся до включения защиты на старом сервере',async()=>{
 assert.equal((await run(false,{version:1,auth:false})).writes,0);assert.equal((await run(true,null)).writes,0);
 const pending=await run(true,{version:1,auth:false});assert.equal(pending.writes,1);assert.equal(pending.result.required,true);assert.equal(pending.result.locked,false);
 const done=await run(true,{version:1,auth:true},true);assert.equal(done.writes,0);assert.equal(done.result.locked,true);
});
