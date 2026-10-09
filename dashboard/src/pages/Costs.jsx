import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import dayjs from 'dayjs';
import { getCostList, saveCostList } from '../api';
import { fmtInt, fmtPct, naturalCompare, shortModel } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Себестоимость» — одна себестоимость на наш артикул (общая для WB и Ozon).
// Ввод прямо в таблице или через Excel: скачать шаблон → заполнить колонку
// «Себестоимость, ₽» → загрузить обратно (покажем, что изменится, до
// сохранения).
// ─────────────────────────────────────────────────────────────────────────

const COL_ID = 'Артикул', COL_NAME = 'Название', COL_CAT = 'Категория', COL_COST = 'Себестоимость, ₽', COL_PRICE = 'Средняя цена продажи за 30 дней, ₽';
const parseCost = v => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s|₽|руб\.?/gi, '').replace(',', '.');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

export default function Costs({ cabinet }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({}); // offerId -> строка ввода
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [onlySold, setOnlySold] = useState(false);
  const [sort, setSort] = useState({ key: 'id', dir: 1 });
  const [bulk, setBulk] = useState('');
  const [preview, setPreview] = useState(null);
  const [limit, setLimit] = useState(200);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    getCostList(cabinet).then(r => setItems(r.data.data.items || [])).catch(() => setMsg({ bad: true, text: 'Не удалось загрузить список артикулов.' })).finally(() => setLoading(false));
  }, [cabinet]);
  useEffect(() => { load(); setDraft({}); setPreview(null); setCat(''); }, [load]);

  const cats = useMemo(() => {
    const s = new Set();
    for (const it of items) { const p = it.category.split(' / '); for (let i = 1; i <= p.length; i++) s.add(p.slice(0, i).join(' / ')); }
    return [...s].sort(naturalCompare);
  }, [items]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items.filter(it => (!cat || it.category === cat || it.category.startsWith(cat + ' / '))
      && (!q || it.offerId.toLowerCase().includes(q) || it.name.toLowerCase().includes(q))
      && (!onlyEmpty || it.cost === null) && (!onlySold || it.orders30 > 0));
    const val = it => {
      switch (sort.key) {
        case 'id': return it.offerId; case 'cat': return it.category; case 'price': return it.avgPrice30 ?? -1;
        case 'orders': return it.orders30; case 'cost': return it.cost ?? -1;
        case 'pct': return it.cost !== null && it.avgPrice30 ? it.cost / it.avgPrice30 : -1;
        default: return 0;
      }
    };
    return list.sort((a, b) => { const x = val(a), y = val(b); return typeof x === 'string' ? naturalCompare(x, y) * sort.dir : (x - y) * sort.dir; });
  }, [items, cat, search, onlyEmpty, onlySold, sort]);

  const filled = items.filter(it => it.cost !== null).length;
  const soldItems = items.filter(it => it.orders30 > 0);
  const soldFilled = soldItems.filter(it => it.cost !== null).length;
  const dirtyIds = Object.keys(draft).filter(id => {
    const it = items.find(x => x.offerId === id);
    const v = parseCost(draft[id]);
    return it && !Number.isNaN(v) && v !== it.cost;
  });
  const badIds = Object.keys(draft).filter(id => Number.isNaN(parseCost(draft[id])));

  async function save(list) {
    setSaving(true); setMsg(null);
    try {
      const r = await saveCostList(cabinet, list);
      const byId = new Map(list.map(x => [x.offerId, x.cost]));
      const now = new Date().toISOString();
      setItems(prev => prev.map(it => byId.has(it.offerId) ? { ...it, cost: byId.get(it.offerId), updatedAt: byId.get(it.offerId) === null ? null : now } : it));
      setDraft(prev => { const n = { ...prev }; for (const x of list) delete n[x.offerId]; return n; });
      setMsg({ text: `Сохранено: ${r.data.saved}${r.data.removed ? `, очищено: ${r.data.removed}` : ''}.` });
    } catch (e) {
      setMsg({ bad: true, text: `Не сохранилось: ${e.response?.data?.error || e.message}` });
    } finally { setSaving(false); }
  }
  const saveDraft = () => save(dirtyIds.map(id => ({ offerId: id, cost: parseCost(draft[id]) })));

  function applyBulk() {
    const v = parseCost(bulk);
    if (v === null || Number.isNaN(v)) return;
    if (!window.confirm(`Проставить ${v} ₽ всем ${rows.length} артикулам в текущем фильтре? Сохранится после кнопки «Сохранить».`)) return;
    setDraft(prev => { const n = { ...prev }; for (const it of rows) n[it.offerId] = String(v); return n; });
    setBulk('');
  }

  async function downloadTemplate(list) {
    const XLSX = await import('xlsx');
    const aoa = [[COL_ID, COL_NAME, COL_CAT, COL_COST, COL_PRICE]];
    for (const it of list) aoa.push([it.offerId, it.name, it.category, it.cost ?? '', it.avgPrice30 ?? '']);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 18 }, { wch: 70 }, { wch: 42 }, { wch: 16 }, { wch: 18 }];
    ws['!autofilter'] = { ref: `A1:E${aoa.length}` };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Себестоимость');
    const help = XLSX.utils.aoa_to_sheet([
      ['Как заполнить'],
      ['1. Впишите себестоимость в колонку «Себестоимость, ₽» (число, копейки через запятую или точку).'],
      ['2. Пустая клетка — артикул не меняется. Чтобы удалить себестоимость, впишите слово «удалить».'],
      ['3. Колонку «Артикул» не меняйте — по ней идёт сопоставление. Остальные колонки только для удобства.'],
      ['4. Сохраните файл и загрузите его на вкладке «Себестоимость» кнопкой «Загрузить из Excel».'],
    ]);
    help['!cols'] = [{ wch: 110 }];
    XLSX.utils.book_append_sheet(wb, help, 'Как заполнить');
    XLSX.writeFile(wb, `Себестоимость_${cabinet}_${dayjs().format('YYYY-MM-DD')}.xlsx`);
  }

  async function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setMsg(null);
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await f.arrayBuffer());
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
      // Ищем шапку: строка, где есть «артикул» и «себестоимость».
      const hi = aoa.findIndex(r => r.some(c => /артикул/i.test(String(c))) && r.some(c => /себест/i.test(String(c))));
      if (hi === -1) { setMsg({ bad: true, text: 'Не нашёл колонки «Артикул» и «Себестоимость» в первом листе файла.' }); return; }
      const head = aoa[hi].map(c => String(c));
      const ci = head.findIndex(c => /артикул/i.test(c)), cc = head.findIndex(c => /себест/i.test(c));
      const byId = new Map(items.map(it => [it.offerId.toLowerCase(), it]));
      const changes = [], unknown = [], bad = [];
      let same = 0, empty = 0;
      for (const r of aoa.slice(hi + 1)) {
        const id = String(r[ci] ?? '').trim();
        if (!id) continue;
        const raw = r[cc];
        const it = byId.get(id.toLowerCase());
        if (String(raw).trim() === '') { empty++; continue; }
        const v = /удал/i.test(String(raw)) ? null : parseCost(raw);
        if (Number.isNaN(v)) { bad.push(`${id}: «${raw}»`); continue; }
        if (!it) { unknown.push(id); continue; }
        if (v === it.cost) { same++; continue; }
        changes.push({ offerId: it.offerId, name: it.name, from: it.cost, cost: v });
      }
      setPreview({ file: f.name, changes, unknown, bad, same, empty });
    } catch (err) {
      setMsg({ bad: true, text: `Не удалось прочитать файл: ${err.message}` });
    }
  }

  const clickSort = k => setSort(p => p.key === k ? { key: k, dir: -p.dir } : { key: k, dir: k === 'id' || k === 'cat' ? 1 : -1 });
  const TH = ([k, t, r]) => <th key={t} className={`sortable ${sort.key === k ? 'sorted' : ''} ${r ? 'r' : ''}`} onClick={() => clickSort(k)}>{t}{sort.key === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;

  return (
    <div className="ads2 costs">
      <div className="a-top">
        <h1>Себестоимость</h1>
        <span className="a-hint">{fmtInt(filled)} из {fmtInt(items.length)} артикулов заполнено · из продававшихся за 30 дней — {fmtInt(soldFilled)} из {fmtInt(soldItems.length)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="a-btn" onClick={() => downloadTemplate(items)} disabled={!items.length}>Скачать шаблон (все)</button>
          {rows.length !== items.length && <button type="button" className="a-btn" onClick={() => downloadTemplate(rows)}>Шаблон по фильтру ({fmtInt(rows.length)})</button>}
          <button type="button" className="a-btn primary" onClick={() => fileRef.current?.click()}>Загрузить из Excel</button>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onFile} />
        </span>
      </div>

      <div className="c-note">
        Себестоимость одна на артикул — она же используется для WB и Ozon. Её возьмут в расчёт прибыли.
        Ввести можно прямо в таблице (изменённые клетки подсвечиваются, потом «Сохранить») или через Excel: скачайте шаблон, заполните колонку «{COL_COST}» и загрузите файл обратно — перед сохранением покажем, что изменится.
      </div>

      {msg && <div className={`c-msg ${msg.bad ? 'bad' : ''}`}>{msg.text}</div>}

      {preview && (
        <div className="a-card" style={{ padding: 14 }}>
          <div className="a-bar" style={{ marginBottom: 8 }}>
            <b>Файл «{preview.file}»</b>
            <span className="a-hint">изменится: {preview.changes.length} · без изменений: {preview.same} · пустых: {preview.empty}{preview.unknown.length ? ` · нет в кабинете: ${preview.unknown.length}` : ''}{preview.bad.length ? ` · не число: ${preview.bad.length}` : ''}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button type="button" className="a-btn" onClick={() => setPreview(null)}>Отмена</button>
              <button type="button" className="a-btn primary" disabled={!preview.changes.length || saving}
                onClick={async () => { await save(preview.changes.map(c => ({ offerId: c.offerId, cost: c.cost }))); setPreview(null); }}>
                {saving ? 'Сохраняем…' : `Применить ${preview.changes.length}`}
              </button>
            </span>
          </div>
          {preview.bad.length > 0 && <div className="a-hint" style={{ color: 'var(--a-bad)', marginBottom: 6 }}>Не число (пропущено): {preview.bad.slice(0, 10).join(', ')}{preview.bad.length > 10 ? '…' : ''}</div>}
          {preview.unknown.length > 0 && <div className="a-hint" style={{ marginBottom: 6 }}>Нет в кабинете (пропущено): {preview.unknown.slice(0, 15).join(', ')}{preview.unknown.length > 15 ? '…' : ''}</div>}
          {preview.changes.length > 0 && (
            <div className="a-scroll" style={{ maxHeight: 280, overflowY: 'auto' }}>
              <table className="a-t c-table">
                <thead><tr><th>Артикул</th><th>Название</th><th className="r">Было, ₽</th><th className="r">Станет, ₽</th></tr></thead>
                <tbody>{preview.changes.slice(0, 300).map(c => (
                  <tr key={c.offerId}><td className="n">{c.offerId}</td><td title={c.name}>{shortModel(c.name) || c.name}</td>
                    <td className="n r">{c.from === null ? '—' : fmtInt(c.from)}</td><td className="n r"><b>{c.cost === null ? 'удалить' : c.cost.toLocaleString('ru-RU')}</b></td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="a-bar">
        <select className="a-sel" value={cat} onChange={e => setCat(e.target.value)} style={{ maxWidth: 360 }}>
          <option value="">Все категории</option>
          {cats.map(c => <option key={c} value={c}>{'  '.repeat(c.split(' / ').length - 1)}{c.split(' / ').pop()}</option>)}
        </select>
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ minWidth: 220 }} />
        <button type="button" className="a-toggle" onClick={() => setOnlyEmpty(v => !v)}><span className={`a-sw ${onlyEmpty ? 'on' : ''}`} />Только без себестоимости</button>
        <button type="button" className="a-toggle" onClick={() => setOnlySold(v => !v)}><span className={`a-sw ${onlySold ? 'on' : ''}`} />Только с продажами</button>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="a-input" value={bulk} onChange={e => setBulk(e.target.value)} placeholder="₽ всем в фильтре" style={{ width: 130 }} />
          <button type="button" className="a-btn" disabled={parseCost(bulk) === null || Number.isNaN(parseCost(bulk)) || !rows.length} onClick={applyBulk}>Проставить</button>
          <button type="button" className="a-btn primary" disabled={!dirtyIds.length || saving || badIds.length > 0} onClick={saveDraft}>
            {saving ? 'Сохраняем…' : `Сохранить${dirtyIds.length ? ` (${dirtyIds.length})` : ''}`}
          </button>
          {Object.keys(draft).length > 0 && <button type="button" className="a-btn ghost" onClick={() => setDraft({})}>Отменить правки</button>}
        </span>
      </div>

      <div className={`a-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-scroll">
          <table className="a-t c-table">
            <thead><tr>
              {TH(['id', 'Артикул'])}<th>Название</th>{TH(['cat', 'Категория'])}{TH(['orders', 'Заказы за 30 дн', 1])}
              {TH(['price', 'Ср. цена, ₽', 1])}{TH(['cost', 'Себестоимость, ₽', 1])}{TH(['pct', '% от цены', 1])}<th className="r">Обновлено</th>
            </tr></thead>
            <tbody>
              {rows.slice(0, limit).map(it => {
                const d = draft[it.offerId];
                const shown = d !== undefined ? d : (it.cost ?? '');
                const v = d !== undefined ? parseCost(d) : it.cost;
                const bad = Number.isNaN(v);
                const pct = v !== null && !bad && it.avgPrice30 ? v / it.avgPrice30 * 100 : null;
                return (
                  <tr key={it.offerId}>
                    <td className="n">{it.offerId}</td>
                    <td title={it.name} style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</td>
                    <td className="a-hint">{it.category}</td>
                    <td className="n r">{it.orders30 ? fmtInt(it.orders30) : <span className="muted">—</span>}</td>
                    <td className="n r">{it.avgPrice30 ? fmtInt(it.avgPrice30) : <span className="muted">—</span>}</td>
                    <td className="r">
                      <input value={shown} inputMode="decimal" className={d !== undefined && (bad || v !== it.cost) ? 'dirty' : ''} style={bad ? { borderColor: 'var(--a-bad)' } : undefined}
                        onChange={e => setDraft(p => ({ ...p, [it.offerId]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') { const tr = e.target.closest('tr')?.nextElementSibling; tr?.querySelector('input')?.focus(); } }} />
                    </td>
                    <td className="n r">{pct === null ? <span className="muted">—</span> : <span style={{ color: pct > 60 ? 'var(--a-bad)' : pct > 40 ? 'var(--a-warn)' : undefined }}>{fmtPct(pct)}</span>}</td>
                    <td className="r a-hint">{it.updatedAt ? dayjs(it.updatedAt).format('DD.MM.YY') : ''}</td>
                  </tr>
                );
              })}
              {!rows.length && !loading && <tr><td colSpan={8} className="a-empty">Ничего не найдено.</td></tr>}
            </tbody>
          </table>
        </div>
        {rows.length > limit && (
          <div style={{ padding: 10 }}><button type="button" className="a-btn ghost" onClick={() => setLimit(l => l + 500)}>Показать ещё (всего {fmtInt(rows.length)})</button></div>
        )}
      </div>
    </div>
  );
}
