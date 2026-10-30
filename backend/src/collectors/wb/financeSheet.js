const axios = require('axios');
const { StringDecoder } = require('node:string_decoder');
const bridge = require('../../lib/wbBridge');
// Только финансовая вкладка: строки разбираются по мере получения, а не весь CSV в памяти.
async function* csvRows(stream) {
  const decoder = new StringDecoder('utf8');
  let row = [], field = '', quoted = false, closing = false, cr = false, first = true, bytes = 0;
  async function* chunks() { if (typeof stream === 'string') { yield stream; return; } for await (const chunk of stream) yield decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); const tail = decoder.end(); if (tail) yield tail; }
  for await (const text of chunks()) {
    bytes += Buffer.byteLength(text); if (bytes > 100 * 1024 * 1024) throw new Error('Финансовая вкладка превышает 100 МБ');
    for (const c of text) {
      if (first) { first = false; if (c === '\uFEFF') continue; }
      if (closing) { if (c === '"') { field += '"'; closing = false; continue; } quoted = false; closing = false; if (!',\r\n'.includes(c)) throw new Error('Повреждённый CSV финансов WB'); }
      if (quoted) { if (c === '"') closing = true; else field += c; }
      else if (c === '"') { if (field) throw new Error('Повреждённые кавычки CSV финансов WB'); quoted = true; cr = false; }
      else if (c === ',') { row.push(field); field = ''; cr = false; }
      else if (c === '\r' || c === '\n') { if (c === '\n' && cr) { cr = false; continue; } row.push(field); if (row.some(Boolean)) yield row; row = []; field = ''; cr = c === '\r'; }
      else { field += c; cr = false; }
      if (field.length > 60000 || row.length > 8) throw new Error('Слишком большая строка финансов WB');
    }
  }
  if (quoted && !closing) throw new Error('Финансовый CSV оборван внутри строки');
  if (field || row.length) { row.push(field); if (row.some(Boolean)) yield row; }
}
async function importFinance(m, sheetId) {
  const total = Number(m.total);
  if (!/^\d+$/.test(m.total) || !Number.isSafeInteger(total) || total < 0 || total > 150000) throw new Error('Некорректное число строк финансов WB');
  const parts = Math.max(1, Math.ceil(total / 1000));
  const meta = {cabinet:bridge.CABINET,kind:'finance',runId:m.run_id,collectedAt:m.collected_at,from:m.from,to:m.to,warning:m.warning||'',total,parts};
  const response = await axios.get(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=1&sheet=WB_finance`, {responseType:'stream',timeout:90000,maxContentLength:100*1024*1024});
  let headers, count = 0, batch = [], part = 0, last;
  const seen = new Set();
  try {
    for await (const row of csvRows(response.data)) {
      if (!headers) { headers = row; if (!['id','payload','run_id'].every(k=>headers.includes(k))) throw new Error('Не найдены колонки id / payload / run_id финансов WB'); continue; }
      if (row.length !== headers.length) throw new Error('Неполная строка финансов WB');
      const r = Object.fromEntries(headers.map((k,i)=>[k,row[i]]));
      if (r.run_id !== m.run_id || count >= total) throw new Error('Финансовая вкладка ещё обновляется; прежние данные сохранены');
      const data = JSON.parse(r.payload);
      if (data.id !== r.id || seen.has(r.id)) throw new Error('Повтор или несовпадение ID финансов WB');
      seen.add(r.id); batch.push(data); count++;
      if (batch.length === 1000) { last = {...meta,part:part++,rows:batch}; await bridge.ingest(last,{deferCommit:true}); batch = []; }
    }
    if (!headers || count !== total) throw new Error('Получен неполный финансовый отчёт; прежние данные сохранены');
    if (batch.length || !last) { last = {...meta,part:part++,rows:batch}; await bridge.ingest(last,{deferCommit:true}); }
    // Повтор последнего пакета разрешает фиксацию только после проверки конца CSV и всех строк.
    await bridge.ingest(last);
  } finally { response.data?.destroy?.(); }
}
module.exports = { csvRows, importFinance };
