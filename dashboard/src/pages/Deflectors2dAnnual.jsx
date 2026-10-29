import React, { useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { parseAnnual2d, validate2d } from '../lib/deflectors2d.mjs';

export default function Deflectors2dAnnual({ annual, rows, apply }) {
  const input = useRef(null);
  const [file, setFile] = useState(null), [sheet, setSheet] = useState(0), [offerCol, setOfferCol] = useState(0), [qtyCol, setQtyCol] = useState(1), [start, setStart] = useState(2);
  const [from, setFrom] = useState(dayjs().subtract(1, 'year').format('YYYY-MM-DD')), [to, setTo] = useState(dayjs().subtract(1, 'day').format('YYYY-MM-DD'));
  const [error, setError] = useState(''), [reading, setReading] = useState(false);
  const data = file?.sheets[sheet]?.rows || [];
  const parsed = useMemo(() => { try { return parseAnnual2d(data, offerCol, qtyCol, start - 1); } catch (e) { return { items: {}, rejected: [], error: e.message }; } }, [data, offerCol, qtyCol, start]);
  const known = new Set(rows.map(r => r.offer.toLowerCase())), matched = Object.keys(parsed.items).filter(o => known.has(o));
  const width = Math.min(80, Math.max(2, ...data.slice(0, 30).map(r => r.length)));
  const names = Array.from({ length: width }, (_, i) => `${i + 1}: ${String(data[Math.max(0, start - 2)]?.[i] || '').slice(0, 65)}`);
  async function read(e) {
    const f = e.target.files?.[0]; e.target.value = ''; if (!f) return;
    if (f.size > 15 * 1024 * 1024) { setError('Размер файла не должен превышать 15 МБ'); return; }
    setReading(true); setError('');
    try {
      const XLSX = await import('xlsx'), book = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      const sheets = book.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: '' }) }));
      if (sheets.some(s => s.rows.length > 30000)) throw new Error('Допустимо не более 30 000 строк на листе');
      setFile({ name: f.name, sheets }); setSheet(0); setOfferCol(0); setQtyCol(1); setStart(2);
    } catch (e) { setError('Не удалось прочитать файл: ' + e.message); }
    finally { setReading(false); }
  }
  function accept() {
    setError('');
    try {
      if (offerCol === qtyCol) throw new Error('Для артикула и количества выберите разные колонки');
      if (parsed.rejected.length || parsed.error) throw new Error(parsed.error || 'Исправьте строки с некорректными данными или измените первую строку данных');
      if (!Object.keys(parsed.items).length) throw new Error('В выбранных колонках нет продаж');
      const a = { from, to, file: file.name, uploadedAt: new Date().toISOString(), items: parsed.items };
      validate2d({ settings: { multiple: 10, periodDays: 7, salesDays: 30, total: 140 }, rows: [], annual: a });
      apply(a); setFile(null);
    } catch (e) { setError(e.message); }
  }
  return <div className="a-card pr-card">
    <h3 style={{ marginTop: 0 }}>Годовые продажи из 1С</h3>
    <p className="a-hint">Дополнительная история по всей компании. Не складывается с маркетплейсами и не меняет свежий темп заказов. Раз в месяц загружайте новый файл за год; он заменит предыдущий после сохранения таблицы.</p>
    {annual ? <p>{annual.file} · {dayjs(annual.from).format('DD.MM.YYYY')} — {dayjs(annual.to).format('DD.MM.YYYY')} · {Object.keys(annual.items).length} артикулов · загружено {dayjs(annual.uploadedAt).format('DD.MM.YYYY HH:mm')}{dayjs().diff(dayjs(annual.to), 'day') > 40 && <span style={{ color: 'var(--a-warn)' }}> · пора обновить файл</span>}</p> : <p>Годовой файл ещё не загружен.</p>}
    <input ref={input} type="file" accept=".xlsx,.xls,.csv" aria-label="Файл годовых продаж 1С" onChange={read} style={{ display: 'none' }} />
    <button className="a-btn ghost" disabled={reading} onClick={() => input.current.click()}>{reading ? 'Чтение файла…' : 'Загрузить годовые продажи 1С'}</button>
    {error && <p role="alert" style={{ color: 'var(--a-bad)' }}>{error}</p>}
    {file && <div style={{ marginTop: 14 }}>
      <b>{file.name}</b>
      <div className="a-bar" style={{ flexWrap: 'wrap', gap: 12, margin: '12px 0' }}>
        <label>Лист <select className="a-input" value={sheet} onChange={e => setSheet(Number(e.target.value))}>{file.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select></label>
        <label>Колонка артикула <select className="a-input" value={offerCol} onChange={e => setOfferCol(Number(e.target.value))}>{names.map((n, i) => <option key={i} value={i}>{n}</option>)}</select></label>
        <label>Колонка количества <select className="a-input" value={qtyCol} onChange={e => setQtyCol(Number(e.target.value))}>{names.map((n, i) => <option key={i} value={i}>{n}</option>)}</select></label>
        <label>Первая строка данных <input className="a-input" type="number" min="1" max={Math.max(1, data.length)} value={start} onChange={e => setStart(Math.max(1, Number(e.target.value) || 1))} style={{ width: 75 }} /></label>
      </div>
      <div className="a-bar" style={{ gap: 12 }}><label>Начало периода 1С <input className="a-input" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Конец периода 1С <input className="a-input" type="date" value={to} onChange={e => setTo(e.target.value)} /></label></div>
      <p>Распознано {Object.keys(parsed.items).length} артикулов; совпало с таблицей 2D: {matched.length}. Остальные сохранятся в файле данных, но в подсорт не добавляются.</p>
      {!!parsed.rejected.length && <p style={{ color: 'var(--a-bad)' }}>Некорректные строки: {parsed.rejected.slice(0, 20).join(', ')}. Пустые, отрицательные и дробные количества не принимаются.</p>}
      <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Артикул</th><th>Продажи за год, шт</th><th>В таблице 2D</th></tr></thead><tbody>{Object.entries(parsed.items).slice(0, 12).map(([o, q]) => <tr key={o}><td>{o}</td><td>{q}</td><td>{known.has(o) ? 'Да' : 'Нет'}</td></tr>)}</tbody></table></div>
      <div className="a-bar" style={{ marginTop: 12 }}><button className="a-btn" disabled={!Object.keys(parsed.items).length || !!parsed.rejected.length || !!parsed.error} onClick={accept}>Применить файл к таблице</button><button className="a-btn ghost" onClick={() => setFile(null)}>Отмена</button></div>
      <p className="a-hint">После применения нажмите «Сохранить таблицу», чтобы файл стал доступен с другого компьютера.</p>
    </div>}
  </div>;
}
