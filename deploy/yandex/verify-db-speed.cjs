// Только чтение: отделяем выполнение SQL от передачи ответа. В статус не
// попадают строки отчётов, параметры подключения и текст запросов пользователей.
module.exports=async env=>{
 const {Client}=require('../../backend/node_modules/pg');
 const client=new Client({connectionString:env.DATABASE_URL,ssl:/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL||'')?false:{rejectUnauthorized:false},connectionTimeoutMillis:10000,statement_timeout:20000,query_timeout:25000});
 const out={};
 try{
  await client.connect();
  let start=performance.now();await client.query("SELECT repeat('x',1048576) AS probe");out.transfer1MbMs=Math.round(performance.now()-start);
  const {neon,neonConfig}=require('../../backend/node_modules/@neondatabase/serverless'),originalFetch=neonConfig.fetchFunction;
  let encoding=null;neonConfig.fetchFunction=async(...args)=>{const response=await fetch(...args);encoding=response.headers.get('content-encoding');return response;};
  try{
   const sql=neon(env.DATABASE_URL,{types:require('../../backend/node_modules/pg').types});
   start=performance.now();const [probe]=await sql.query("SELECT repeat('x',1048576) AS probe",[],{fetchOptions:{signal:AbortSignal.timeout(15000)}});out.httpTransfer1MbMs=Math.round(performance.now()-start);out.httpEncoding=encoding;out.httpPayloadCorrect=probe.probe.length===1048576;
   const [shape]=await sql.query("SELECT 12.34::numeric AS amount, true AS flag, jsonb_build_object('n',1) AS object",[],{fetchOptions:{signal:AbortSignal.timeout(15000)}});out.httpTypesCorrect=shape.amount==='12.34'&&shape.flag===true&&shape.object.n===1;
  }catch(e){out.httpError=e.code||'unavailable';}finally{neonConfig.fetchFunction=originalFetch;}
  const to=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()),from=new Date(Date.parse(to)-29*86400000).toISOString().slice(0,10);
  start=performance.now();const r=await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT date::text d,sku,name,SUM(amount) a,SUM(qty) q FROM finance_daily WHERE cabinet=$1 AND date BETWEEN $2 AND $3 GROUP BY date,sku,name',['defly',from,to]);
  const p=r.rows[0]['QUERY PLAN'][0];out.financePlan={roundtripMs:Math.round(performance.now()-start),executionMs:p['Execution Time'],planningMs:p['Planning Time'],nodes:[]};
  const walk=n=>{out.financePlan.nodes.push({type:n['Node Type'],index:n['Index Name'],rows:n['Actual Rows'],read:n['Shared Read Blocks'],hit:n['Shared Hit Blocks']});for(const child of n.Plans||[])walk(child);};walk(p.Plan);
  out.wbSizes=(await client.query('SELECT kind,pg_column_size(rows)::bigint bytes,(meta->>\'total\')::bigint rows FROM wb_bridge_data WHERE cabinet=$1',['defly_wb'])).rows.map(r=>({kind:r.kind,bytes:Number(r.bytes),rows:Number(r.rows)}));
 }catch(e){out.error=e.code||'timeout';}
 finally{await client.end().catch(()=>{});}
 return out;
};
