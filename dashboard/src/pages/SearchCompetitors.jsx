import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getCompetitors, getSerp, addCompetitor, removeCompetitor, saveSkuPhoto, saveCompetitorView, importCompetitorReport, latestOnly } from '../api';
import { fmtInt, fmtPct } from './AdsStats2';
import { Empty } from './finShared';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
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
const SHOP = { defly: 'Defly', nabauto: 'NABauto', alex: 'Alex', fullgas: 'Fullgas', accent: 'Accent Line', licio: 'Licio' };
// Короткое название: до первой запятой, без «- ПРОДАВЕЦ -» в начале, не длиннее ~42 знаков.
function shortName(n) {
  let t = String(n || '').replace(/^\s*-[^-]{2,40}-\s*/, '').split(/,|\s\/\s|\(/)[0].trim();
  if (t.length > 42) t = t.slice(0, 42).replace(/\s+\S*$/, '') + '…';
  return t || String(n || '');
}
// Лучшее значение в колонке подсвечиваем зелёным: 'up' — больше лучше, 'down' — меньше лучше.
const BEST = { rev: 'up', qty: 'up', avgPrice: 'down', views: 'up', searchViews: 'up', pdp: 'up', carts: 'up', ctr: 'up', cartPdp: 'up', crOrder: 'up', drr: 'down', buyout: 'up' };
function bestOf(values, dir) {
  const ok = values.filter(v => v != null && Number.isFinite(v));
  if (ok.length < 2) return null;
  const b = dir === 'up' ? Math.max(...ok) : Math.min(...ok);
  return ok.every(v => v === b) ? null : b;
}

// Показатели отчёта «Товары на Ozon», которые сравниваем.
const MCOLS = [
  { k: 'rev', g: 'Заказы', s: '₽', l: 'Заказы, ₽', f: money, diff: true, hint: 'Заказано на сумму за окно отчёта' },
  { k: 'qty', g: 'Заказы', s: 'шт', l: 'Заказы, шт', f: fmtInt, diff: true },
  { k: 'avgPrice', g: 'Заказы', s: 'ср. цена', l: 'Ср. цена', f: money },
  { k: 'views', g: 'Трафик', s: 'показы', l: 'Показы', f: fmtInt, diff: true, hint: 'Показы всего: поиск, каталог, рекомендации (Ozon)' },
  { k: 'searchViews', g: 'Трафик', s: 'в поиске', l: 'Показы в поиске', f: fmtInt, diff: true, hint: 'Показы в поиске и каталоге (Ozon)' },
  { k: 'pdp', g: 'Трафик', s: 'клики', l: 'Клики', f: fmtInt, diff: true, hint: 'Клики — переходы в карточку товара (Ozon)' },
  { k: 'carts', g: 'Трафик', s: 'корзины', l: 'Корзины', f: fmtInt, diff: true, calc: carts, hint: 'Корзины — расчётно: клики × «в корзину из карточки» + показы в поиске × «в корзину из поиска» (Ozon даёт только проценты)' },
  { k: 'ctr', g: 'Конверсии', s: 'CTR', l: 'CTR', f: pct, calc: d => (d.views > 0 && d.pdp != null ? d.pdp / d.views * 100 : null), hint: 'Клики / показы' },
  { k: 'cartPdp', g: 'Конверсии', s: 'в корзину', l: 'В корзину', hint: 'Из карточки в корзину — процент от Ozon', f: pct },
  { k: 'crOrder', g: 'Конверсии', s: 'в заказ', l: 'В заказ', f: pct, calc: d => { const c = carts(d); return c > 0 && d.qty != null ? d.qty / c * 100 : null; }, hint: 'Заказы / корзины (корзины — расчётные)' },
  { k: 'drr', g: 'Реклама', s: 'ДРР', l: 'ДРР', f: pct, hint: 'Доля рекламных расходов от суммы заказов (Ozon)' },
  { k: 'adDays', g: 'Реклама', s: 'дней', l: 'Дней с продвиж.', hint: 'Дней с продвижением за окно отчёта', f: v => v || '—' },
  { k: 'buyout', g: 'Выкуп и остаток', s: 'выкуп', l: 'Выкуп', f: pct },
  { k: 'stock', g: 'Выкуп и остаток', s: 'остаток', l: 'Остаток', f: fmtInt },
];
// Корзины в штуках Ozon не отдаёт — считаем из кликов и процентов «в корзину».
function carts(d) {
  if (!d || d.pdp == null || d.cartPdp == null) return null;
  return d.pdp * d.cartPdp / 100 + (d.searchViews != null && d.cartSearch != null ? d.searchViews * d.cartSearch / 100 : 0);
}
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
// Подпись строки: нажмите ✎, чтобы переименовать (пусто — вернуть исходную).
function Label({ x, onSave }) {
  const [edit, setEdit] = useState(false);
  const [t, setT] = useState(x.label);
  useEffect(() => setT(x.label), [x.label]);
  if (edit) return (
    <input autoFocus className="a-input sc-lbl" value={t} onChange={e => setT(e.target.value)}
      onBlur={() => { setEdit(false); if (t.trim() !== x.label) onSave(t.trim()); }}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { setT(x.label); setEdit(false); } }} />
  );
  return <><b>{x.label}</b><button type="button" className="sc-edit" title="Переименовать" onClick={() => setEdit(true)}>✎</button></>;
}
function Photo({ sku, src, auto, onSave }) {
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
      <button ref={btn} type="button" className="sc-phb" onClick={() => setOpen(v => !v)} title={auto ? 'Главное фото с Ozon — обновляется само (расширение). Нажмите, чтобы поставить своё' : 'Фото товара: подтянется само, когда расширение откроет карточку на Ozon; можно вставить вручную'}>
        {src ? <img src={src} alt="" /> : <span>фото</span>}
      </button>
      {open && createPortal(
        <div className="sc-pop" style={{ top: open.top, left: open.left }} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) take(f); }}>
          <input autoFocus className="a-input" placeholder="Ctrl+V — картинка или ссылка" onPaste={onPaste} onKeyDown={e => e.key === 'Escape' && setOpen(false)} />
          <div className="a-hint">Обычно фото подтягивается само: расширение раз в 6 часов открывает карточку на Ozon и замечает смену главного фото. Вручную — только если нужно своё: вставьте картинку (Ctrl+V), ссылку или перетащите файл.</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <label className="a-btn sm">Файл…<input type="file" accept="image/*" hidden onChange={e => e.target.files?.[0] && take(e.target.files[0])} /></label>
            {src && !auto && <button type="button" className="a-btn sm" onClick={async () => { await onSave(sku, null); setOpen(false); }} title="Убрать своё фото — вернётся фото с Ozon">Убрать своё</button>}
            <button type="button" className="a-btn sm" onClick={() => setOpen(false)}>Закрыть</button>
            <span className="a-hint">{msg}</span>
          </div>
        </div>,
        btn.current?.closest('.mpui') || document.body)}
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

  // Строки сравнения: наши SKU и конкуренты, в сохранённом порядке.
  const items = useMemo(() => {
    if (!data) return [];
    const snaps = new Map();
    for (const m of data.market) { if (m.window !== win) continue; (snaps.get(m.sku) || snaps.set(m.sku, []).get(m.sku)).push(m); }
    const labels = data.view?.labels || {};
    const mk = (sku, kind, label, name, seller, own) => {
      const list = (snaps.get(sku) || []).sort((a, b) => (a.date < b.date ? -1 : 1));
      const last = list[list.length - 1] || null, prev = list[list.length - 2] || null;
      const card = (data.cards || {})[sku] || null;
      const full = last?.name || card?.title || name || '';
      return { sku, kind, own, label: labels[sku] || label, name: full, short: shortName(full), seller: last?.seller || seller || '', last, prev, list, card, manualPhoto: data.photos[sku] || null, photo: data.photos[sku] || card?.photo || null };
    };
    const shop = SHOP[cabinet] || cabinet;
    const list = [...data.our.map(o => mk(o.sku, 'our', shop, o.name, shop, true)), ...data.competitors.map(c => mk(c.sku, 'comp', c.label || c.seller || 'Конкурент', c.name, c.seller, !!c.ours))];
    const ord = new Map((data.view?.order || []).map((k, i) => [k, i]));
    return list.map((x, i) => ({ x, i })).sort((a, b) => (ord.has(a.x.sku) ? ord.get(a.x.sku) : 1e3 + a.i) - (ord.has(b.x.sku) ? ord.get(b.x.sku) : 1e3 + b.i)).map(o => o.x);
  }, [data, win, cabinet]);
  // Порядок строк — перетаскиванием (как в «Рекламе»).
  const [dragKey, setDragKey] = useState(null), [overKey, setOverKey] = useState(null);
  const reorder = async (from, to) => {
    if (!from || !to || from === to) return;
    const order = items.map(x => x.sku);
    order.splice(order.indexOf(to), 0, order.splice(order.indexOf(from), 1)[0]);
    setData(d => ({ ...d, view: { ...(d.view || {}), order } }));
    await saveCompetitorView(cabinet, offer, { order }).catch(() => load());
  };
  // Выдача для сравнения: запрос и регион, последний снимок — место, ставка, популярность, соответствие.
  const [serpSel, setSerpSel] = useState('');
  const [serpMap, setSerpMap] = useState(null);
  useEffect(() => {
    const qs = data?.serpQueries || [];
    if (!qs.length) { setSerpSel(''); return; }
    if (!qs.some(q => `${q.query}|${q.region}` === serpSel)) {
      const pick = qs.find(q => q.region.startsWith('Москва')) || qs[0];
      setSerpSel(`${pick.query}|${pick.region}`);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!serpSel) { setSerpMap(null); return; }
    const [q, r] = serpSel.split('|');
    getSerp(cabinet, q, r).then(res => {
      const rows = res.data.data || [];
      const last = rows.reduce((m, x) => (x.d > m ? x.d : m), '');
      setSerpMap({ date: last, by: new Map(rows.filter(x => x.d === last).map(x => [x.sku, x])) });
    }).catch(() => setSerpMap(null));
  }, [cabinet, serpSel]);
  const rename = async (x, text) => {
    if (x.kind === 'comp') await addCompetitor(cabinet, offer, x.sku, text);
    await saveCompetitorView(cabinet, offer, { label: { sku: x.sku, text } });
    load();
  };
  // Колонки сравнения: цена и рейтинг с витрины, место/ставка из выдачи, показатели отчёта.
  // Необязательные группы колонок: «Витрина» и «Выдача» — по переключателю (помним в браузере).
  const [show, setShowRaw] = useState(() => { try { return JSON.parse(localStorage.getItem('sc-show') || '{}') || {}; } catch (e) { return {}; } });
  const setShow = (k, v) => setShowRaw(o => { const n = { ...o, [k]: v }; try { localStorage.setItem('sc-show', JSON.stringify(n)); } catch (e) { /* без памяти */ } return n; });
  const cols = useMemo(() => {
    const sv = (x, k) => serpMap?.by.get(x.sku)?.[k] ?? null;
    return [
      ...(show.vit ? [{ k: 'cur', g: 'Витрина', l: 'цена', best: 'down', f: money, get: x => (x.card ? x.card.cardPrice ?? x.card.price : null), hint: 'Цена на сайте сейчас (с Ozon-картой) — по данным расширения' },
      { k: 'rating', g: 'Витрина', l: 'рейтинг', best: 'up', get: x => x.card?.rating ?? null, f: (v, x) => (v == null ? '—' : `${String(v).replace('.', ',')}${x.card?.reviews != null ? ` (${fmtInt(x.card.reviews)})` : ''}`), hint: 'Рейтинг и число отзывов — по данным расширения' }] : []),
      ...(show.serp && serpMap ? [
        { k: 'pos', g: 'Выдача', l: 'место', best: 'down', serp: true, get: x => sv(x, 'position'), f: v => (v == null ? '—' : v), hint: 'Место в выдаче по выбранному запросу и региону' },
        { k: 'cpc', g: 'Выдача', l: 'за клик', serp: true, get: x => sv(x, 'cpc'), f: (v, x) => (v == null ? (sv(x, 'status') ? <span className="muted">не продвигается</span> : '—') : <>{`${String(v).replace('.', ',')} ₽`}{sv(x, 'strategy') && <div className="sc-d">{String(sv(x, 'strategy')).replace(/стоимость клика/i, 'цена клика')}</div>}</>), hint: 'Ставка «Оплата за клик» в выдаче и стратегия' },
        { k: 'cpo', g: 'Выдача', l: 'за заказ', serp: true, get: x => { const t = sv(x, 'cpo'); const m = /([\d,.]+)\s*%/.exec(t || ''); return m ? Number(m[1].replace(',', '.')) : null; }, f: (v, x) => (v != null ? `${String(v).replace('.', ',')}%` : (sv(x, 'cpo') || '—')), hint: 'Ставка «Оплата за заказ» в выдаче' },
        { k: 'pop', g: 'Выдача', l: 'популярн.', best: 'up', serp: true, get: x => sv(x, 'popularity'), f: v => (v == null ? '—' : String(v).replace('.', ',')), hint: 'Популярность товара по этому запросу (Ozon)' },
        { k: 'rel', g: 'Выдача', l: 'соответств.', best: 'up', serp: true, get: x => sv(x, 'relevance'), f: v => (v == null ? '—' : String(v).replace('.', ',')), hint: 'Насколько карточка соответствует запросу (Ozon)' },
      ] : []),
      ...MCOLS.filter(c => c.k !== 'adDays').map(c => ({ k: c.k, g: c.g, l: c.s, best: BEST[c.k] || null, f: v => c.f(v), get: x => (x.last ? valOf(c, x.last.data) : null), hint: c.hint, diff: c.diff, m: c })),
    ];
  }, [serpMap, show.vit, show.serp]);
  const groups = useMemo(() => {
    const out = [];
    cols.forEach(c => { const last = out[out.length - 1]; if (last && last.g === c.g) last.n++; else { out.push({ g: c.g, n: 1 }); c.gs = true; } });
    return out;
  }, [cols]);
  const best = useMemo(() => Object.fromEntries(cols.filter(c => c.best).map(c => [c.k, bestOf(items.map(c.get), c.best)])), [cols, items]);
  const ctl = useTableCtl('sc-cmp');
  const rows = useMemo(() => ctl.apply(items, (x, k) => (k === 'name' ? x.label : (cols.find(c => c.k === k)?.get(x) ?? null))), [ctl, items, cols]);
  const dragOn = !ctl.changed;
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
        <div className="sp-tbar" style={{ flexWrap: 'wrap' }}>
          <b>Сравнение за {win} дней</b>
          <span className="sc-tg">
            <button type="button" className={show.vit ? 'on' : ''} onClick={() => setShow('vit', !show.vit)} title="Цена на сайте и рейтинг — по данным расширения">{show.vit ? '−' : '+'} Витрина</button>
            <button type="button" className={show.serp ? 'on' : ''} onClick={() => setShow('serp', !show.serp)} title="Место, ставка, популярность и соответствие из отчёта «Результаты по запросу»">{show.serp ? '−' : '+'} Выдача</button>
          </span>
          {show.serp && ((data.serpQueries || []).length > 0 ? (
            <select className="a-input" value={serpSel} onChange={e => setSerpSel(e.target.value)} style={{ width: 'auto', maxWidth: 360 }}>
              {data.serpQueries.map(q => <option key={q.query + q.region} value={`${q.query}|${q.region}`}>{q.query} · {q.region} · {dd(q.last)}</option>)}
            </select>
          ) : <span className="a-hint">загрузите отчёт «Результаты по запросу»</span>)}
          <ResetCtl ctl={ctl} />
        </div>
        <div className="a-scroll">
          <table className="a-t sc-t sc-cmp no-sh">
            <thead>
              <tr className="sc-grp">
                <th className="stk s0" rowSpan={2} /><th className="stk s1" rowSpan={2} />
                <ThCtl ctl={ctl} k="name" className="stk s2" filter={false} dnd={{ rowSpan: 2 }}>Товар</ThCtl>
                {groups.map(g => <th key={g.g} colSpan={g.n} className={`gs ${g.g === 'Выдача' ? 'sc-serp' : ''}`} title={g.g === 'Выдача' && serpSel ? serpSel.replace('|', ' · ') : undefined}>{g.g === 'Выдача' && serpSel ? `Выдача · ${serpSel.split('|')[0]}` : g.g}</th>)}
                <th rowSpan={2} className="gs">Отчёт от</th><th rowSpan={2} />
              </tr>
              <tr>{cols.map(c => <ThCtl key={c.k} ctl={ctl} k={c.k} hint={c.hint} className={`c ${c.serp ? 'sc-serp' : ''} ${c.gs ? 'gs' : ''}`}>{c.l}</ThCtl>)}</tr>
            </thead>
            <tbody>
              {rows.map(x => (
                <tr key={x.sku} className={`${x.own ? 'sc-our' : ''} ${dragKey === x.sku ? 'dragging' : ''} ${overKey === x.sku && dragKey && dragKey !== x.sku ? 'dropover' : ''}`}
                  draggable={dragOn}
                  onDragStart={dragOn ? () => setDragKey(x.sku) : undefined}
                  onDragOver={dragOn ? e => { e.preventDefault(); setOverKey(x.sku); } : undefined}
                  onDrop={dragOn ? e => { e.preventDefault(); reorder(dragKey, x.sku); setDragKey(null); setOverKey(null); } : undefined}
                  onDragEnd={dragOn ? () => { setDragKey(null); setOverKey(null); } : undefined}>
                  <td className="stk s0 sc-grip">{dragOn ? <span className="a-handle" title="Перетащите, чтобы поменять порядок">⠿</span> : null}</td>
                  <td className="stk s1"><Photo sku={x.sku} src={x.photo} auto={!x.manualPhoto && !!x.card?.photo} onSave={savePhoto} /></td>
                  <td className="stk s2 sc-name">
                    <div className="sc-l1"><Label x={x} onSave={t => rename(x, t)} />{x.own && x.label !== (SHOP[cabinet] || cabinet) && <span className="sc-own" title="Наш товар">{SHOP[cabinet] || 'наш'}</span>}</div>
                    <div className="muted sc-short" title={`${x.name}\nSKU ${x.sku}${x.seller && !x.own ? ' · ' + x.seller : ''}`}><a href={ozonUrl(x.sku)} target="_blank" rel="noreferrer">{x.short || x.sku}</a></div>
                    {x.card?.photoChanged && (Date.now() - Date.parse(x.card.photoChanged)) < 14 * 864e5 && <div className="sc-flag">фото сменилось {dd(x.card.photoChanged)}</div>}
                  </td>
                  {cols.map(c => {
                    const v = c.get(x);
                    const p = c.diff && x.prev ? valOf(c.m, x.prev.data) : null;
                    const d = v != null && p != null ? v - p : null;
                    return (
                      <td key={c.k} className={`n c ${c.gs ? 'gs' : ''} ${c.serp ? 'sc-serp' : ''} ${best[c.k] != null && v === best[c.k] ? 'sc-best' : ''}`}>
                        {c.f(v, x)}
                        {d != null && <div className={`sc-d ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`} title={`К отчёту от ${dd(x.prev.date)}: это новый день минус день, выпавший из окна ${win} дней — не продажи одного дня`}>{d > 0 ? '+' : ''}{fmtInt(d)}</div>}
                      </td>
                    );
                  })}
                  <td className="n c gs">{x.last ? <>{dd(x.last.date)}{x.last.data?._empty && <div className="sc-d" title={`Ozon вернул пустую строку: за ${win} дней у товара не было заказов`}>нет заказов</div>}</> : <span className="muted" title="Загрузите отчёт «Товары на Ozon» с этим товаром">нет отчёта</span>}</td>
                  <td>{x.kind === 'comp' && <button type="button" className="sp-reset" title="Убрать из сравнения" onClick={() => remove(x.sku)}>×</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="a-hint" style={{ padding: '6px 12px 10px' }}>
          Зелёным — лучшее значение в колонке (для цены и ДРР — самое низкое). Подписи меняются карандашом ✎, порядок строк — перетаскиванием за ⠿ (когда не включена сортировка). Клик по названию колонки: по убыванию → по возрастанию → как было; воронка — фильтр «от … до …». Место, ставка, популярность и соответствие — из последнего загруженного отчёта «Результаты по запросу» для выбранного запроса и региона. Все цифры — из отчёта Ozon «Аналитика → Товары на Ozon» за {win} дней. Для честного сравнения скачивайте его и по нашему товару, в тот же день. Мелкая цифра под значением — разница с прошлым отчётом:
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
                    <tr key={x.sku} className={x.own ? 'sc-our' : ''}>
                      <td><b>{x.label}</b> <span className="muted">{x.sku}</span></td>
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

// Выдача по запросу. Один запрос — несколько регионов (в отчёте Ozon регион
// выбирается при выгрузке): сверху матрица «товар × регион» по последнему
// снимку каждого региона, ниже — выдача выбранного региона целиком.
const REGION_ORDER = ['Москва', 'Санкт-Петербург', 'Казань', 'Самара', 'Краснодар', 'Новосибирск', 'Екатеринбург'];
const regionRank = r => { const i = REGION_ORDER.findIndex(x => r.startsWith(x)); return i < 0 ? 99 : i; };
function SerpBlock({ cabinet, queries, items, onAdd }) {
  const qList = useMemo(() => {
    const m = new Map();
    for (const q of queries) { const x = m.get(q.query) || { query: q.query, regions: [], last: q.last }; x.regions.push(q); if (q.last > x.last) x.last = q.last; m.set(q.query, x); }
    return [...m.values()].map(x => ({ ...x, regions: x.regions.sort((a, b) => regionRank(a.region) - regionRank(b.region) || a.region.localeCompare(b.region)) })).sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [queries]);
  const [q, setQ] = useState(qList[0]?.query || '');
  const [region, setRegion] = useState('');
  const [byRegion, setByRegion] = useState(null);
  const [all, setAll] = useState(false);
  const cur = qList.find(x => x.query === q) || qList[0];
  useEffect(() => { if (!q && qList[0]) setQ(qList[0].query); }, [qList, q]);
  useEffect(() => {
    if (!cur) return;
    setByRegion(null);
    Promise.all(cur.regions.map(r => getSerp(cabinet, cur.query, r.region).then(x => [r.region, x.data.data]).catch(() => [r.region, []])))
      .then(list => { setByRegion(Object.fromEntries(list)); setRegion(rg => (cur.regions.some(r => r.region === rg) ? rg : cur.regions[0].region)); });
  }, [cabinet, cur?.query, cur?.regions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const mark = useMemo(() => new Map(items.map(x => [x.sku, x])), [items]);
  const ours = new Set(items.filter(x => x.own).map(x => x.sku));
  const regions = cur ? cur.regions.map(r => r.region) : [];
  const lastOf = rg => { const rows = byRegion?.[rg] || []; const d = rows.reduce((m, r) => (r.d > m ? r.d : m), ''); return { d, rows: rows.filter(r => r.d === d) }; };
  const rows = byRegion?.[region] || [];
  const dates = [...new Set(rows.map(r => r.d))].sort();
  const { d: last, rows: lastRows } = lastOf(region);
  const shown = all ? lastRows : lastRows.filter(r => mark.has(r.sku) || ours.has(r.sku) || (r.position != null && r.position <= 10));
  const name = x => x.label || x.seller || x.sku;
  return (
    <div className="a-card" style={{ marginTop: 12 }}>
      <div className="sp-tbar" style={{ flexWrap: 'wrap' }}>
        <b>Выдача по запросу</b>
        {qList.length ? (
          <select className="a-input" value={cur?.query || ''} onChange={e => setQ(e.target.value)} style={{ width: 'auto', maxWidth: '100%' }}>
            {qList.map(x => <option key={x.query} value={x.query}>{x.query} · {x.regions.length} рег. · {dd(x.last)}</option>)}
          </select>
        ) : null}
      </div>
      {!qList.length ? (
        <div className="a-hint" style={{ padding: '4px 12px 12px' }}>Загрузите отчёт «Результаты по запросу» — здесь появятся позиции, ставки за клик и стратегии наших товаров и конкурентов. Один и тот же запрос можно загружать по разным регионам: сервис сам разложит их по регионам.</div>
      ) : byRegion === null ? <div className="a-hint" style={{ padding: 12 }}>Загрузка…</div> : (
        <>
          <div className="a-scroll">
            <table className="a-t sc-t sc-reg">
              <thead><tr><th>Позиция по регионам · последний снимок</th>{regions.map(rg => <th key={rg} className={`r ${rg === region ? 'on' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setRegion(rg)} title="Показать выдачу этого региона">{rg}<div className="muted">{dd(lastOf(rg).d)}</div></th>)}</tr></thead>
              <tbody>
                {items.map(x => (
                  <tr key={x.sku} className={x.own ? 'sc-our' : ''}>
                    <td><b>{name(x)}</b> <span className="muted">{x.sku}</span></td>
                    {regions.map(rg => {
                      const r = lastOf(rg).rows.find(y => y.sku === x.sku);
                      return <td key={rg} className={`n r ${rg === region ? 'on' : ''}`}>{r ? <><b>{r.position ?? '—'}</b>{r.cpc != null && <div className="muted">{String(r.cpc).replace('.', ',')} ₽</div>}</> : <span className="muted" title="Нет в выдаче этого снимка">—</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sp-tbar" style={{ flexWrap: 'wrap' }}>
            <b>Выдача · {region} · {dd(last)}</b>
            <span className="a-seg">{regions.map(rg => <button key={rg} type="button" className={rg === region ? 'on' : ''} onClick={() => setRegion(rg)}>{rg}</button>)}</span>
            {lastRows.length > shown.length && <button type="button" className="a-btn sm" onClick={() => setAll(true)}>вся выдача ({lastRows.length})</button>}
            {all && <button type="button" className="a-btn sm" onClick={() => setAll(false)}>только топ-10 и наши</button>}
          </div>
          <div className="a-scroll">
            <table className="a-t sc-t">
              <thead><tr>{['Место', 'Товар', 'Продавец', 'Статус', 'Ставка за клик', 'Стратегия', 'За заказ', 'Соответствие', 'Популярность', 'Отзывы', 'Цена', 'Акции', 'Доставка'].map(h => <th key={h} className={['Место', 'Ставка за клик', 'Соответствие', 'Популярность', 'Цена'].includes(h) ? 'r' : ''}>{h}</th>)}<th /></tr></thead>
              <tbody>
                {shown.map(r => {
                  const x = mark.get(r.sku);
                  return (
                    <tr key={r.sku} className={ours.has(r.sku) || r.seller === 'Дефлай' ? 'sc-our' : x ? 'sc-comp' : ''}>
                      <td className="n r"><b>{r.position ?? '—'}</b></td>
                      <td className="sc-name"><a href={ozonUrl(r.sku)} target="_blank" rel="noreferrer">{x ? <b>{name(x)}</b> : null} {r.name}</a> <span className="muted">{r.sku}</span></td>
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
                <thead><tr><th>Позиция по датам · {region}</th>{dates.map(d => <th key={d} className="r">{dd(d)}</th>)}</tr></thead>
                <tbody>
                  {items.map(x => {
                    const by = new Map(rows.filter(r => r.sku === x.sku).map(r => [r.d, r]));
                    if (!by.size) return null;
                    return <tr key={x.sku} className={x.own ? 'sc-our' : ''}><td><b>{name(x)}</b> <span className="muted">{x.sku}</span></td>{dates.map(d => <td key={d} className="n r">{by.get(d)?.position ?? '—'}{by.get(d)?.cpc != null && <div className="muted">{String(by.get(d).cpc).replace('.', ',')} ₽</div>}</td>)}</tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="a-hint" style={{ padding: '6px 12px 10px' }}>Зелёным — наши товары, синим — конкуренты из списка. В матрице — место и ставка за клик в каждом регионе по последнему загруженному снимку; нажмите на регион, чтобы открыть его выдачу. «+» добавляет товар в конкуренты.</div>
        </>
      )}
    </div>
  );
}
