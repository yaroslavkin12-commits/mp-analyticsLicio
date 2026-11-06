import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getCompetitors, getSerp, addCompetitor, removeCompetitor, saveSkuPhoto, importCompetitorReport, latestOnly } from '../api';
import { fmtInt, fmtPct } from './AdsStats2';
import { Empty } from './finShared';
import { parseOzonReport } from '../lib/ozonReports';

// ─────────────────────────────────────────────────────────────────────────
// «Позиции в поиске» → товар → «Сравнение с конкурентами».
// Ozon не отдаёт данные о чужих товарах по API — только отчёты кабинета:
//  • «Аналитика → Товары на Ozon» за 7 или 28 дней (по нашему товару —
//    тот же отчёт, чтобы сравнивать одинаковые цифры). Каждая загрузка —
//    снимок «окно на дату отчёта»; разница двух соседних снимков = новый
//    день минус день, выпавший из окна (не сам день!);
//  • «Результаты по запросу» — выдача: позиции, ставки, стратегии.
// ─────────────────────────────────────────────────────────────────────────

const money = v => (v == null ? '—' : `${fmtInt(v)} ₽`);
const pct = v => (v == null ? '—' : fmtPct(v));
const dd = d => (d ? `${d.slice(8)}.${d.slice(5, 7)}` : '—');
const ozonUrl = sku => `https://www.ozon.ru/product/${sku}/`;

// Показатели отчёта «Товары на Ozon», которые сравниваем.
const MCOLS = [
  { k: 'rev', l: 'Заказы, ₽', f: money, diff: true, hint: 'Заказано на сумму за окно отчёта' },
  { k: 'qty', l: 'Заказы, шт', f: fmtInt, diff: true },
  { k: 'avgPrice', l: 'Ср. цена', f: money },
  { k: 'views', l: 'Показы', f: fmtInt, diff: true, hint: 'Показы всего: поиск, каталог, рекомендации' },
  { k: 'searchViews', l: 'Просм. в поиске', f: fmtInt, diff: true, hint: 'Просмотры в поиске и каталоге' },
  { k: 'pdp', l: 'Просм. карточки', f: fmtInt, diff: true },
  { k: 'ctr', l: 'CTR', f: pct, calc: d => (d.views > 0 && d.pdp != null ? d.pdp / d.views * 100 : null), hint: 'Просмотры карточки / показы — посчитано сервисом' },
  { k: 'cartPdp', l: 'В корзину из карточки', f: pct },
  { k: 'convOrder', l: 'Показ → заказ', f: pct, hint: 'Конверсия из показа в заказ (Ozon)' },
  { k: 'drr', l: 'ДРР', f: pct, hint: 'Доля рекламных расходов от суммы заказов (Ozon)' },
  { k: 'adDays', l: 'Дней с продвиж.', f: v => v || '—' },
  { k: 'buyout', l: 'Выкуп', f: pct },
  { k: 'stock', l: 'Остаток', f: fmtInt },
];
const valOf = (c, d) => (c.calc ? c.calc(d || {}) : (d || {})[c.k] ?? null);

// Фото: вставка (Ctrl+V), перетаскивание файла или ссылка. Картинка
// уменьшается до 240 px и хранится в сервисе.
async function shrink(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const k = Math.min(1, 240 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } finally { URL.revokeObjectURL(url); }
}
function Photo({ sku, src, onSave }) {
  const [open, setOpenRaw] = useState(null);
  const [msg, setMsg] = useState('');
  const btn = useRef(null);
  // Окно — поверх таблицы (fixed), иначе его обрезает прокрутка таблицы.
  const setOpen = v => {
    const want = typeof v === 'function' ? v(!!open) : v;
    if (!want) return setOpenRaw(null);
    const r = btn.current.getBoundingClientRect();
    setOpenRaw({ top: Math.min(r.bottom + 6, window.innerHeight - 170), left: Math.min(r.left, window.innerWidth - 320) });
  };
  const take = async blob => { setMsg('сохраняю…'); try { await onSave(sku, await shrink(blob)); setOpen(false); setMsg(''); } catch (e) { setMsg('не получилось'); } };
  const onPaste = async e => {
    const it = [...(e.clipboardData?.items || [])].find(x => x.type.startsWith('image/'));
    if (it) { e.preventDefault(); await take(it.getAsFile()); return; }
    const t = e.clipboardData?.getData('text') || '';
    if (/^https:\/\/\S+$/.test(t.trim())) { e.preventDefault(); setMsg('сохраняю…'); await onSave(sku, t.trim()); setOpen(false); setMsg(''); }
  };
  return (
    <div className="sc-ph">
      <button ref={btn} type="button" className="sc-phb" onClick={() => setOpen(v => !v)} title="Фото товара: нажмите, чтобы вставить или заменить">
        {src ? <img src={src} alt="" /> : <span>фото</span>}
      </button>
      {open && (
        <div className="sc-pop" style={{ top: open.top, left: open.left }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) take(f); }}>
          <input autoFocus className="a-input" placeholder="Ctrl+V — картинка или ссылка" onPaste={onPaste} onKeyDown={e => e.key === 'Escape' && setOpen(false)} />
          <div className="a-hint">Скопируйте главное фото на Ozon (правая кнопка → «Копировать картинку») и вставьте сюда. Можно перетащить файл.</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label className="a-btn sm">Файл…<input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && take(e.target.files[0])} /></label>
            {src && <button type="button" className="a-btn sm" onClick={async () => { await onSave(sku, null); setOpen(false); }}>Убрать</button>}
            <button type="button" className="a-btn sm" onClick={() => setOpen(false)}>Закрыть</button>
            <span className="a-hint">{msg}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SearchCompetitors({ cabinet, offer, tip }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [win, setWin] = useState(7);
  const [sku, setSku] = useState(''), [label, setLabel] = useState('');
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState('rev');
  const [diffMode, setDiffMode] = useState(false);
  const fileRef = useRef(null);

  const load = useCallback(() => {
    const ok = latestOnly('sc:' + cabinet);
    getCompetitors(cabinet, offer).then(ok(r => { setData(r.data.data); setErr(null); })).catch(ok(e => setErr(e.response?.data?.error || e.message)));
  }, [cabinet, offer]);
  useEffect(() => { setData(null); setLog([]); load(); }, [load]);

  const add = async (s, l) => {
    const clean = String(s || '').replace(/\D/g, '');
    if (!clean) return;
    try { await addCompetitor(cabinet, offer, clean, l || ''); setSku(''); setLabel(''); load(); }
    catch (e) { setLog(v => [{ ok: false, text: e.response?.data?.error || e.message }, ...v]); }
  };
  const remove = async s => { if (!window.confirm('Убрать конкурента из сравнения? Загруженные отчёты останутся.')) return; await removeCompetitor(cabinet, offer, s); load(); };
  const savePhoto = async (s, p) => { await saveSkuPhoto(cabinet, s, p); load(); };

  const upload = async files => {
    setBusy(true);
    const out = [];
    for (const f of files) {
      try {
        const r = await parseOzonReport(f);
        if (r.kind === 'market' || r.kind === 'serp') {
          const res = await importCompetitorReport(cabinet, r);
          out.push({ ok: true, text: `${f.name}: ${r.label}, отчёт от ${dd(r.date)} — загружено`, skus: r.kind === 'market' ? r.rows.map(x => ({ sku: x.sku, name: x.name, seller: x.seller })) : null, n: res.data.data.rows });
        } else out.push({ ok: r.kind === 'ours', text: `${f.name}: ${r.label}` });
      } catch (e) { out.push({ ok: false, text: `${f.name}: ${e.response?.data?.error || e.message}` }); }
    }
    setLog(v => [...out, ...v].slice(0, 20));
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
    load();
  };

  // Строки сравнения: наши SKU, затем конкуренты.
  const items = useMemo(() => {
    if (!data) return [];
    const snaps = new Map();
    for (const m of data.market) { if (m.window !== win) continue; (snaps.get(m.sku) || snaps.set(m.sku, []).get(m.sku)).push(m); }
    const mk = (sku, kind, label, name, seller) => {
      const list = (snaps.get(sku) || []).sort((a, b) => (a.date < b.date ? -1 : 1));
      const last = list[list.length - 1] || null, prev = list[list.length - 2] || null;
      return { sku, kind, label, name: last?.name || name || '', seller: last?.seller || seller || '', last, prev, list, photo: data.photos[sku] || null };
    };
    return [...data.our.map(o => mk(o.sku, 'our', 'Мы', o.name, 'Defly')), ...data.competitors.map(c => mk(c.sku, 'comp', c.label, c.name, c.seller))];
  }, [data, win]);
  const known = useMemo(() => new Set(items.map(x => x.sku)), [items]);
  const dates = useMemo(() => [...new Set(items.flatMap(x => x.list.map(m => m.date)))].sort(), [items]);

  if (err) return <Empty>Не удалось загрузить: {err}</Empty>;
  if (!data) return <div className="a-hint" style={{ padding: 20 }}>Загрузка…</div>;
  const mcol = MCOLS.find(c => c.k === metric) || MCOLS[0];

  return (
    <>
      <div className="a-card sc-bar">
        <form className="sc-add" onSubmit={e => { e.preventDefault(); add(sku, label); }}>
          <b>+ Конкурент</b>
          <input className="a-input" placeholder="SKU Ozon (из ссылки)" value={sku} onChange={e => setSku(e.target.value)} style={{ width: 170 }} />
          <input className="a-input" placeholder="Как назвать: «Автопилот»" value={label} onChange={e => setLabel(e.target.value)} style={{ width: 190 }} />
          <button type="submit" className="a-btn" disabled={!sku.replace(/\D/g, '')}>Добавить</button>
        </form>
        <label className={`a-btn ${busy ? 'dis' : ''}`} title="Можно выбрать сразу несколько файлов">
          {busy ? 'Загружаю…' : 'Загрузить отчёты Ozon (.xlsx)'}
          <input ref={fileRef} type="file" accept=".xlsx" multiple hidden disabled={busy} onChange={e => e.target.files?.length && upload([...e.target.files])} />
        </label>
        <span className="a-seg">{[7, 28].map(w => <button key={w} type="button" className={win === w ? 'on' : ''} onClick={() => setWin(w)}>{w} дней</button>)}</span>
      </div>
      {log.length > 0 && (
        <div className="a-card sc-log">
          {log.map((x, i) => (
            <div key={i} className={x.ok ? '' : 'bad'}>
              {x.ok ? '✓' : '×'} {x.text}
              {x.skus && x.skus.filter(s => !known.has(s.sku)).map(s => (
                <button key={s.sku} type="button" className="a-btn sm" style={{ marginLeft: 6 }} onClick={() => add(s.sku, s.seller)} title={s.name}>+ {s.seller || s.sku} в конкуренты</button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="a-card">
        <div className="sp-tbar"><b>Сравнение за {win} дней — по последнему загруженному отчёту</b></div>
        <div className="a-scroll">
          <table className="a-t sc-t">
            <thead><tr><th />{['Товар', 'Отчёт от'].map(h => <th key={h}>{h}</th>)}{MCOLS.map(c => <th key={c.k} className="r" title={c.hint}>{c.l}</th>)}<th /></tr></thead>
            <tbody>
              {items.map(x => (
                <tr key={x.sku} className={x.kind === 'our' ? 'sc-our' : ''}>
                  <td><Photo sku={x.sku} src={x.photo} onSave={savePhoto} /></td>
                  <td className="sc-name">
                    <b>{x.kind === 'our' ? 'Мы' : (x.label || x.seller || 'Конкурент')}</b> <a href={ozonUrl(x.sku)} target="_blank" rel="noreferrer" className="muted">{x.sku}</a>
                    <div className="muted">{x.seller && x.kind !== 'our' ? `${x.seller} · ` : ''}{x.name || '—'}</div>
                  </td>
                  <td className="n">{x.last ? dd(x.last.date) : <span className="muted" title="Загрузите отчёт «Товары на Ozon» с этим товаром">нет отчёта</span>}</td>
                  {MCOLS.map(c => {
                    const v = x.last ? valOf(c, x.last.data) : null;
                    const p = x.prev && c.diff ? valOf(c, x.prev.data) : null;
                    const d = v != null && p != null ? v - p : null;
                    return (
                      <td key={c.k} className="n r">
                        {c.f(v)}
                        {d != null && <div className={`sc-d ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`} title={`К отчёту от ${dd(x.prev.date)}: это новый день минус день, выпавший из окна ${win} дней — не продажи одного дня`}>{d > 0 ? '+' : ''}{fmtInt(d)}</div>}
                      </td>
                    );
                  })}
                  <td>{x.kind === 'comp' && <button type="button" className="sp-reset" title="Убрать из сравнения" onClick={() => remove(x.sku)}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="a-hint" style={{ padding: '6px 12px 10px' }}>
          Все цифры — из отчёта Ozon «Аналитика → Товары на Ozon» за {win} дней. Для честного сравнения скачивайте его и по нашему товару, в тот же день. Мелкая цифра под значением — разница с прошлым отчётом:
          это «новый день минус день, выпавший из окна», а не продажи одного дня. Точные дни по нашему товару — во вкладке «Поисковые запросы».
        </div>
      </div>

      {dates.length > 1 && (
        <div className="a-card" style={{ marginTop: 12 }}>
          <div className="sp-tbar" style={{ flexWrap: 'wrap' }}>
            <b>История отчётов · за {win} дней на дату</b>
            <select className="a-input" value={metric} onChange={e => setMetric(e.target.value)} style={{ width: 'auto' }}>
              {MCOLS.filter(c => c.k !== 'adDays').map(c => <option key={c.k} value={c.k}>{c.l}</option>)}
            </select>
            {mcol.diff && <span className="a-seg">{[[false, 'значения'], [true, 'разница к прошлому']].map(([k, l]) => <button key={l} type="button" className={diffMode === k ? 'on' : ''} onClick={() => setDiffMode(k)}>{l}</button>)}</span>}
          </div>
          <div className="a-scroll">
            <table className="a-t sc-t">
              <thead><tr><th>Товар</th>{dates.map(d => <th key={d} className="r">{dd(d)}</th>)}</tr></thead>
              <tbody>
                {items.map(x => {
                  const by = new Map(x.list.map(m => [m.date, m]));
                  return (
                    <tr key={x.sku} className={x.kind === 'our' ? 'sc-our' : ''}>
                      <td><b>{x.kind === 'our' ? 'Мы' : (x.label || x.seller)}</b> <span className="muted">{x.sku}</span></td>
                      {dates.map((d, i) => {
                        const m = by.get(d);
                        let v = m ? valOf(mcol, m.data) : null;
                        if (diffMode && mcol.diff) {
                          const pm = i > 0 ? by.get(dates[i - 1]) : null;
                          const pv = pm ? valOf(mcol, pm.data) : null;
                          v = v != null && pv != null ? v - pv : null;
                        }
                        return <td key={d} className="n r">{v == null ? '—' : diffMode && mcol.diff ? `${v > 0 ? '+' : ''}${fmtInt(v)}` : mcol.f(v)}</td>;
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <SerpBlock cabinet={cabinet} queries={data.serpQueries} items={items} onAdd={add} />
    </>
  );
}

// Выдача по запросу: позиции, ставки и стратегии наших товаров и конкурентов.
function SerpBlock({ cabinet, queries, items, onAdd }) {
  const [sel, setSel] = useState(queries[0] ? `${queries[0].query}|${queries[0].region}` : '');
  const [rows, setRows] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => { if (!sel && queries[0]) setSel(`${queries[0].query}|${queries[0].region}`); }, [queries, sel]);
  useEffect(() => {
    if (!sel) return;
    const [q, r] = sel.split('|');
    setRows(null);
    getSerp(cabinet, q, r).then(x => setRows(x.data.data)).catch(() => setRows([]));
  }, [cabinet, sel]);
  const mark = useMemo(() => new Map(items.map(x => [x.sku, x])), [items]);
  const dates = useMemo(() => [...new Set((rows || []).map(r => r.d))].sort(), [rows]);
  const last = dates[dates.length - 1];
  const lastRows = (rows || []).filter(r => r.d === last);
  const shown = all ? lastRows : lastRows.filter(r => mark.has(r.sku) || (r.position != null && r.position <= 10));
  const ours = new Set(items.filter(x => x.kind === 'our').map(x => x.sku));
  return (
    <div className="a-card" style={{ marginTop: 12 }}>
      <div className="sp-tbar" style={{ flexWrap: 'wrap' }}>
        <b>Выдача по запросу</b>
        {queries.length ? (
          <select className="a-input" value={sel} onChange={e => setSel(e.target.value)} style={{ width: 'auto', maxWidth: '100%' }}>
            {queries.map(q => <option key={q.query + q.region} value={`${q.query}|${q.region}`}>{q.query} · {q.region} · {dd(q.last)}{q.n > 1 ? ` · ${q.n} снимков` : ''}</option>)}
          </select>
        ) : null}
        {rows && lastRows.length > shown.length && <button type="button" className="a-btn sm" onClick={() => setAll(true)}>вся выдача ({lastRows.length})</button>}
        {all && <button type="button" className="a-btn sm" onClick={() => setAll(false)}>только топ-10 и наши</button>}
      </div>
      {!queries.length ? (
        <div className="a-hint" style={{ padding: '4px 12px 12px' }}>Загрузите отчёт «Результаты по запросу» (кабинет Ozon → Аналитика → Товары в поиске → запрос → «Почему товар на этой позиции» / выгрузка выдачи) — здесь появятся позиции, ставки за клик и стратегии наших товаров и конкурентов по этому запросу.</div>
      ) : rows === null ? <div className="a-hint" style={{ padding: 12 }}>Загрузка…</div> : (
        <>
          <div className="a-scroll">
            <table className="a-t sc-t">
              <thead><tr>{['Место', 'Товар', 'Продавец', 'Статус', 'Ставка за клик', 'Стратегия', 'За заказ', 'Соответствие', 'Популярность', 'Отзывы', 'Цена', 'Акции', 'Доставка'].map(h => <th key={h} className={['Место', 'Ставка за клик', 'Соответствие', 'Популярность', 'Цена'].includes(h) ? 'r' : ''}>{h}</th>)}<th /></tr></thead>
              <tbody>
                {shown.map(r => {
                  const x = mark.get(r.sku);
                  return (
                    <tr key={r.sku} className={ours.has(r.sku) || r.seller === 'Дефлай' ? 'sc-our' : x ? 'sc-comp' : ''}>
                      <td className="n r"><b>{r.position ?? '—'}</b></td>
                      <td className="sc-name"><a href={ozonUrl(r.sku)} target="_blank" rel="noreferrer">{x ? <b>{x.kind === 'our' ? 'Мы' : x.label || r.seller}</b> : null} {r.name}</a> <span className="muted">{r.sku}</span></td>
                      <td>{r.seller}</td><td className="muted">{r.status || '—'}</td>
                      <td className="n r">{r.cpc != null ? `${String(r.cpc).replace('.', ',')} ₽` : '—'}</td><td>{r.strategy || '—'}</td><td>{r.cpo || '—'}</td>
                      <td className="n r">{r.relevance != null ? String(r.relevance).replace('.', ',') : '—'}</td><td className="n r">{r.popularity != null ? String(r.popularity).replace('.', ',') : '—'}</td>
                      <td className="n">{r.rating != null ? `${String(r.rating).replace('.', ',')} (${fmtInt(r.reviews)})` : '—'}</td>
                      <td className="n r">{money(r.price)}</td><td>{r.promo || '—'}</td><td>{r.delivery || '—'}</td>
                      <td>{!x && <button type="button" className="a-btn sm" title="Добавить в конкуренты этого товара" onClick={() => onAdd(r.sku, r.seller)}>+</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {dates.length > 1 && (
            <div className="a-scroll" style={{ marginTop: 8 }}>
              <table className="a-t sc-t">
                <thead><tr><th>Позиция по датам</th>{dates.map(d => <th key={d} className="r">{dd(d)}</th>)}</tr></thead>
                <tbody>
                  {items.map(x => {
                    const by = new Map((rows || []).filter(r => r.sku === x.sku).map(r => [r.d, r]));
                    if (!by.size) return null;
                    return <tr key={x.sku} className={x.kind === 'our' ? 'sc-our' : ''}><td><b>{x.kind === 'our' ? 'Мы' : x.label || x.seller}</b> <span className="muted">{x.sku}</span></td>{dates.map(d => <td key={d} className="n r">{by.get(d)?.position ?? '—'}{by.get(d)?.cpc != null && <div className="muted">{String(by.get(d).cpc).replace('.', ',')} ₽</div>}</td>)}</tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="a-hint" style={{ padding: '6px 12px 10px' }}>Снимок выдачи на {dd(last)}: зелёным — наши товары, синим — отслеживаемые конкуренты. «+» добавляет товар в конкуренты. Скачивайте этот отчёт по главным запросам раз в день — появится история позиций и ставок.</div>
        </>
      )}
    </div>
  );
}
