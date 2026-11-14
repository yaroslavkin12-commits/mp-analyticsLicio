// Выгрузка и точные количества строк из одного снимка PostgreSQL.
const {Client}=require('/opt/mp/app/backend/node_modules/pg');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
(async()=>{
 const [bin,file]=process.argv.slice(2);
 if(!bin||!file||!process.env.NEON_DATABASE_URL)throw Error('Не заданы параметры выгрузки');
 const c=new Client({connectionString:process.env.NEON_DATABASE_URL,ssl:{rejectUnauthorized:false}});
 await c.connect();
 try{
  await c.query('SET idle_in_transaction_session_timeout=0');
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot=(await c.query('SELECT pg_export_snapshot() s')).rows[0].s;
  const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  await new Promise((resolve,reject)=>{
   const p=spawn(bin,['--format=custom','--no-owner','--no-acl','--snapshot='+snapshot,'-d',process.env.NEON_DATABASE_URL,'-f',file],{stdio:['ignore','ignore','inherit']});
   p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error('pg_dump завершился с ошибкой')));
  });
  const manifest=[];
  for(const {tablename:t} of tables){
   if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t))throw Error('Нестандартное имя таблицы');
   const n=(await c.query('SELECT count(*) n FROM public."'+t+'"')).rows[0].n;
   manifest.push(t+'\t'+n);
  }
  fs.writeFileSync(file+'.manifest',manifest.join('\n')+'\n',{mode:0o600});
  await c.query('COMMIT');
 }finally{await c.end();}
})().catch(()=>{console.error('Не удалось создать согласованный снимок базы');process.exitCode=1});
