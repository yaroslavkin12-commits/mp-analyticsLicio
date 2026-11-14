// Закрывает старые открытые отчёты после подтверждения работающего расширения.
// Секрет подключения остаётся на сервере; содержимое ключей не читается.
const fs=require('fs');
const env=require('/opt/mp/app/backend/node_modules/dotenv').parse(fs.readFileSync('/etc/mp/app.env'));
const {Client}=require('/opt/mp/app/backend/node_modules/pg');
const client=new Client({connectionString:env.DATABASE_URL,ssl:/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)?false:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:10000});
(async()=>{
 const status={checkedAt:new Date().toISOString()};
 try{
  await client.connect();
  status.keyConnected=(await client.query("SELECT EXISTS(SELECT 1 FROM app_api_keys WHERE last_used>NOW()-INTERVAL '24 hours') AS ready")).rows[0]?.ready===true;
  const guardRows=(await client.query("SELECT value FROM app_settings WHERE key='auth:legacy-guard:v1' AND updated_at>NOW()-INTERVAL '90 seconds'")).rows;
  let guard;try{guard=JSON.parse(guardRows[0]?.value||'null')}catch{}
  status.legacyReady=guard?.version===1;
  status.required=(await client.query("SELECT value FROM app_settings WHERE key='auth:required:v1'")).rows[0]?.value==='1';
  if(!status.required && status.keyConnected && status.legacyReady){
   await client.query("INSERT INTO app_settings(key,value,updated_at) VALUES('auth:required:v1','1',NOW()) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=NOW()");
   status.required=true;
  }
  status.locked=status.required && status.legacyReady && guard.auth===true;
 }catch{status.error='Не удалось подтвердить защиту старого адреса';}
 finally{await client.end().catch(()=>{});}
 let current={};try{current=JSON.parse(fs.readFileSync('/var/lib/mp/status.json'))}catch{}
 current.legacyProtection=status;fs.writeFileSync('/var/lib/mp/status.json',JSON.stringify(current));
})();
