// Одноразовое восстановление из источника/сохранённых резервных копий.
// Существующие значения из копий не перезаписываем: только отсутствующие ключи.
const fs=require('fs'),path=require('path'),{spawn}=require('child_process'),readline=require('readline');
const APP=path.resolve(__dirname,'../..'),env=require(path.join(APP,'backend/node_modules/dotenv')).parse(fs.readFileSync('/etc/mp/app.env'));
Object.assign(process.env,env);
const file='/var/lib/mp/status.json',runId=new Date().toISOString().replace(/[:.]/g,'-'),from='2026-11-02',to='2026-11-08';
const report={version:4,recoveryScope:'available-finance-history',startedAt:new Date().toISOString(),state:'running',period:{from,to},source:{},backups:[],restored:{}};
function publish(){
 const crypto=require('crypto'),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(report)),cipher.final()]);
 const sealed={key:crypto.publicEncrypt({key:fs.readFileSync(path.join(__dirname,'history-audit-public.pem')),oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')};
 fs.writeFileSync('/var/lib/mp/history-recovery-report.json',JSON.stringify(report),{mode:0o600});
 let old={};try{old=JSON.parse(fs.readFileSync(file));}catch{};
 old.historyRecovery={version:report.version,state:report.state,startedAt:report.startedAt,finishedAt:report.finishedAt,sealed};
 fs.writeFileSync(file,JSON.stringify(old));
}
function safe(e){let s=String(e.message||e);for(const v of Object.values(env))if(typeof v==='string'&&v.length>12)s=s.split(v).join('[скрыто]');return s.replace(/https?:\/\/\S+/g,'[адрес источника]').slice(0,450);}
const db=require(path.join(APP,'backend/src/db')),columns=['cabinet','date','sku','name','amount','qty'],key=r=>JSON.stringify([r.cabinet,r.date,r.sku,r.name]);
const candidateCabinets=['defly','nabauto','alex','fullgas','accent'];
async function inventory(){return db.query('SELECT cabinet,MIN(date)::text AS first_day,MAX(date)::text AS last_day,COUNT(*)::int AS rows FROM finance_daily WHERE cabinet=ANY($1::text[]) GROUP BY cabinet ORDER BY cabinet',[candidateCabinets]);}
async function week(){
 const data=await require(path.join(APP,'backend/src/routes/finance')).loadPnl({cabinet:'defly',dateFrom:from,dateTo:to});
 const per=Object.fromEntries(data.dates.map(d=>[d,{sale:0,returns:0,net:0}]));
 for(const [ai,di,bi,,q]of data.rows){if(!data.articles[ai].cat.startsWith('Чехлы / Чехлы на сиденья'))continue;const b=data.buckets[bi],d=per[data.dates[di]];if(b==='sale')d.sale+=Math.abs(q);if(b==='return')d.returns+=Math.abs(q);d.net=d.sale-d.returns;}
 return {days:per,net:Object.values(per).reduce((n,d)=>n+d.net,0),sale:Object.values(per).reduce((n,d)=>n+d.sale,0),returns:Object.values(per).reduce((n,d)=>n+d.returns,0)};
}
function pgUnescape(s){if(s==='\\N')return null;return s.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g,(_,a)=>/^[0-7]+$/.test(a)?String.fromCharCode(parseInt(a,8)):/^x/.test(a)?String.fromCharCode(parseInt(a.slice(1),16)):({t:'\t',n:'\n',r:'\r',b:'\b',f:'\f',v:'\v','\\':'\\'}[a]??a));}
async function backupRows(binary,dump,{allDates=false}={}){
 const child=spawn(binary,['--data-only','--file=-','--table=finance_daily',dump],{stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b.toString().slice(0,500));let fields=null,inside=false;const rows=new Map();
 const exit=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Не прочитана резервная копия: '+stderr)));});
 for await(const line of readline.createInterface({input:child.stdout,crlfDelay:Infinity})){
  const header=line.match(/^COPY (?:public\.)?finance_daily \(([^)]+)\) FROM stdin;/);
  if(header){fields=header[1].split(',').map(s=>s.trim().replaceAll('"',''));inside=true;continue;}
  if(!inside)continue;if(line==='\\.'){inside=false;continue;}
  const values=line.split('\t').map(pgUnescape),row=Object.fromEntries(fields.map((f,i)=>[f,values[i]]));
  if(!candidateCabinets.includes(row.cabinet)||(!allDates&&(row.date<from||row.date>to)))continue;
  if(!row.name||row.sku==null||!Number.isFinite(Number(row.amount))||!Number.isFinite(Number(row.qty)))throw Error('Некорректная строка резервной копии');
  row.amount=Number(row.amount);row.qty=Number(row.qty);rows.set(key(row),row);
 }
 await exit;return rows;
}
(async()=>{
 publish();
 try{
  const initialJobs=await db.query("SELECT cabinet,job,last_success_at,last_error_at,last_error FROM ad_job_status WHERE job='finance' AND cabinet='defly'").catch(()=>[]);
  report.previousFinanceJobs=initialJobs.map(r=>({...r,last_error:r.last_error?safe(Error(r.last_error)):null}));
  const backupDir='/var/backups/mp',safety=path.join(backupDir,'history-safety-'+runId);fs.mkdirSync(safety,{recursive:true,mode:0o700});
  const dumps=fs.readdirSync(backupDir).filter(n=>/^mp-\d{8}\.dump$/.test(n)).sort().reverse();
  for(const n of dumps){try{fs.linkSync(path.join(backupDir,n),path.join(safety,n));}catch{fs.copyFileSync(path.join(backupDir,n),path.join(safety,n));}}
  report.protectedBackups=dumps.length;
  // Неподвижная копия текущей рабочей финансовой истории перед восстановлением.
  await db.query('CREATE TABLE IF NOT EXISTS finance_history_rescue (recovery_id TEXT NOT NULL,saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),cabinet TEXT NOT NULL,date DATE NOT NULL,sku TEXT NOT NULL,name TEXT NOT NULL,amount NUMERIC,qty NUMERIC)');
  await db.query('INSERT INTO finance_history_rescue(recovery_id,cabinet,date,sku,name,amount,qty) SELECT $1,cabinet,date,sku,name,amount,qty FROM finance_daily',[runId]);
  report.historyBefore=await inventory();report.before=await week();report.state='reading-source';publish();
  for(const cabinet of candidateCabinets.filter(c=>c==='defly'||env['ADS_SHEET_ID_'+c.toUpperCase()])){
   try{const warnings=[];report.source[cabinet]={changed:await require(path.join(APP,'backend/src/collectors/ads/sheetSync')).syncFinanceOnlyFromSheet(cabinet,{onWarning:m=>warnings.push(m)}),warnings};}
   catch(e){report.source[cabinet]={error:safe(e)};}publish();
  }
  report.afterSource=await week();report.state='checking-backups';publish();
  const versions=fs.readdirSync('/usr/lib/postgresql').sort((a,b)=>Number(b)-Number(a));const pgRestore='/usr/lib/postgresql/'+versions[0]+'/bin/pg_restore';
  const best=new Map();
  for(const n of dumps){
   try{
    const rows=await backupRows(pgRestore,path.join(safety,n),{allDates:true});report.backups.push({file:n,financeRows:rows.size});
    // Более свежая копия имеет приоритет; старые заполняют только отсутствующие ключи.
    for(const [k,r]of rows)if(!best.has(k))best.set(k,r);
   }catch(e){report.backups.push({file:n,error:safe(e)});}publish();
  }
  for(const cabinet of candidateCabinets){
   const current=await db.query('SELECT cabinet,date::text AS date,sku,name,amount,qty FROM finance_daily WHERE cabinet=$1',[cabinet]);
   const merged=new Map(current.map(r=>[key(r),r]));let added=0,conflicting=0;
   for(const [k,r]of best){if(r.cabinet!==cabinet)continue;const old=merged.get(k);if(!old){merged.set(k,r);added++;}else if(Number(old.amount)!==r.amount||Number(old.qty)!==r.qty)conflicting++;}
   if(added)await require(path.join(APP,'backend/src/lib/historyImport')).importHistory('finance_daily',cabinet,[...merged.values()].map(r=>columns.map(c=>r[c])),columns,columns.slice(0,4));
   report.restored[cabinet]={added,existingDifferences:conflicting};publish();
  }
  report.historyAfter=await inventory();report.after=await week();report.checkedAgainstExcel={expectedSeatCovers:163,matches:report.after.net===163};
  report.state='saving-backup';publish();
  report.backupSaved=await new Promise(resolve=>{const p=spawn('/bin/bash',[path.join(__dirname,'backup.sh')],{stdio:'ignore'});p.on('error',()=>resolve(false));p.on('exit',code=>resolve(code===0));});
  report.state=report.checkedAgainstExcel.matches&&report.backupSaved?'complete':'review-needed';report.finishedAt=new Date().toISOString();publish();
 }catch(e){report.state='error';report.error=safe(e);report.finishedAt=new Date().toISOString();publish();process.exitCode=1;}
 finally{await db.getPool().end().catch(()=>{});}
 // Сбрасываем кэши основного процесса, который не участвовал в этой записи.
 if(report.after){const {spawnSync}=require('child_process');spawnSync('systemctl',['restart','mp.service'],{stdio:'ignore'});}
})().catch(e=>{report.state='error';report.error=safe(e);publish();process.exitCode=1;});
