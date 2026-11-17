// Сохраняем историю независимо от скользящего окна очередной выгрузки WB.
// Эти функции выполняются на том же клиенте и внутри транзакции импорта.
const DATED=new Set(['orders','sales','ads','finance']);
async function ensureWbHistory(run){
 await run(`CREATE TABLE IF NOT EXISTS wb_history_rows(cabinet TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,value JSONB NOT NULL,collected_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(cabinet,kind,id))`);
 await run(`CREATE TABLE IF NOT EXISTS wb_history_snapshots(cabinet TEXT NOT NULL,kind TEXT NOT NULL,day DATE NOT NULL,meta JSONB NOT NULL,rows JSONB NOT NULL,collected_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(cabinet,kind,day))`);
 await run(`CREATE TABLE IF NOT EXISTS wb_history_revisions(id BIGSERIAL PRIMARY KEY,cabinet TEXT NOT NULL,kind TEXT NOT NULL,row_id TEXT NOT NULL,before_row JSONB NOT NULL,after_row JSONB NOT NULL,collected_at TIMESTAMPTZ NOT NULL)`);
}
async function captureWbHistory(client,meta){
 const args=[meta.cabinet,meta.kind];
 if(DATED.has(meta.kind)){
  await client.query(`INSERT INTO wb_history_revisions(cabinet,kind,row_id,before_row,after_row,collected_at)
    SELECT d.cabinet,d.kind,e.value->>'id',h.value,e.value,d.collected_at FROM wb_bridge_data d CROSS JOIN LATERAL jsonb_array_elements(d.rows) e(value)
    JOIN wb_history_rows h ON h.cabinet=d.cabinet AND h.kind=d.kind AND h.id=e.value->>'id'
    WHERE d.cabinet=$1 AND d.kind=$2 AND h.value IS DISTINCT FROM e.value AND d.collected_at>=h.collected_at`,args);
  await client.query(`INSERT INTO wb_history_rows(cabinet,kind,id,value,collected_at)
    SELECT d.cabinet,d.kind,e.value->>'id',e.value,d.collected_at FROM wb_bridge_data d CROSS JOIN LATERAL jsonb_array_elements(d.rows) e(value)
    WHERE d.cabinet=$1 AND d.kind=$2 AND e.value->>'id' IS NOT NULL
    ON CONFLICT(cabinet,kind,id) DO UPDATE SET value=EXCLUDED.value,collected_at=EXCLUDED.collected_at WHERE EXCLUDED.collected_at>=wb_history_rows.collected_at AND wb_history_rows.value IS DISTINCT FROM EXCLUDED.value`,args);
 }else{
  await client.query(`INSERT INTO wb_history_snapshots(cabinet,kind,day,meta,rows,collected_at)
    SELECT cabinet,kind,(collected_at AT TIME ZONE 'Europe/Moscow')::date,meta,rows,collected_at FROM wb_bridge_data WHERE cabinet=$1 AND kind=$2
    ON CONFLICT(cabinet,kind,day) DO UPDATE SET meta=EXCLUDED.meta,rows=EXCLUDED.rows,collected_at=EXCLUDED.collected_at WHERE EXCLUDED.collected_at>=wb_history_snapshots.collected_at`,args);
 }
}
async function accumulateWbHistory(client,meta,previous){
 await captureWbHistory(client,meta);
 if(!DATED.has(meta.kind))return;
 const from=[previous?.meta?.from,meta.from].filter(Boolean).sort()[0]||null;
 const to=[previous?.meta?.to,meta.to].filter(Boolean).sort().at(-1)||null;
 await client.query(`WITH accumulated AS (SELECT COALESCE(jsonb_agg(value ORDER BY id),'[]'::jsonb) AS rows,COUNT(*)::int AS total FROM wb_history_rows WHERE cabinet=$1 AND kind=$2)
   UPDATE wb_bridge_data d SET rows=a.rows,meta=d.meta||jsonb_build_object('total',a.total,'sourceTotal',$3::int,'from',$4::text,'to',$5::text,'historyAccumulated',true) FROM accumulated a WHERE d.cabinet=$1 AND d.kind=$2`,[meta.cabinet,meta.kind,meta.total,from,to]);
}
module.exports={ensureWbHistory,captureWbHistory,accumulateWbHistory,DATED};
