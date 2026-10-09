import React, { useState, useEffect, useMemo, useCallback } from 'react';
import dayjs from 'dayjs';
import { getDiscountOverview, getDiscountHistory, getAdsGroups, addAdsGroup, assignAdsGroup } from '../api';
import { fmtInt, Delta, naturalCompare, shortModel, CAT_COLORS, ChartPane, niceScale, useTip, groupColorMap, AddToGroup } from './AdsStats2';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// Соинвест Ozon по категориям: категория → подкатегория → артикул.
// Средний Соинвест считается с весом по выручке за 30 дней (так он
// показывает, сколько реально даёт Ozon на продажах), рядом — простое
// среднее, изменение за сутки и неделю, разброс и цены по артикулу.
// Цены собирает расширение браузера «Соинвест Ozon» (см. browser-extension/).
// ─────────────────────────────────────────────────────────────────────────

const SEP = ' / ';
const OTHER = 'var(--a-ink3)';
const pct = v => (v === null || v === undefined || !Number.isFinite(v)) ? '—' : `${v.toFixed(1).replace('.', ',')}%`;

function stats(list) {
  // Два уровня: СПП по карте других банков (pct) и с Ozon Картой (pctCard).
  let w = 0, ws = 0, wc = 0, s0 = 0, sc = 0, n = 0, d1 = 0, d1n = 0, c1 = 0, c1n = 0, c7 = 0, c7n = 0, d7 = 0, d7n = 0;
  let min = Infinity, max = -Infinity, rev = 0, up = 0, down = 0;
  for (const a of list) {
    const weight = a.revenue30 || 0;
    w += weight; ws += weight * a.pct; wc += weight * a.pctCard; s0 += a.pct; sc += a.pctCard; n++; rev += weight;
    if (a.pctCard < min) min = a.pctCard; if (a.pctCard > max) max = a.pctCard;
    if (a.d1 !== null) { d1 += a.d1; d1n++; }
    if (a.d7 !== null) { d7 += a.d7; d7n++; }
    if (a.c1 !== null) { c1 += a.c1; c1n++; if (a.c1 >= 0.5) up++; if (a.c1 <= -0.5) down++; }
    if (a.c7 !== null) { c7 += a.c7; c7n++; }
  }
  return {
    n, rev, avgW: w ? ws / w : (n ? s0 / n : null), avgCardW: w ? wc / w : (n ? sc / n : null), avg: n ? s0 / n : null, avgCard: n ? sc / n : null,
    d1: d1n ? d1 / d1n : null, d7: d7n ? d7 / d7n : null, c1: c1n ? c1 / c1n : null, c7: c7n ? c7 / c7n : null,
    min: n ? min : null, max: n ? max : null, up, down,
  };
}

// График СПП по дням для выбранного набора товаров (среднее с весом по
// выручке за 30 дней): две линии — с Ozon Картой и по картам других банков.
function SppChart({ hist, list, tip }) {
  const [hover, setHover] = useState(null);
  const series = useMemo(() => {
    if (!hist) return null;
    const weight = new Map(list.map(a => [a.o, a.revenue30 || 1]));
    const N = hist.dates.length;
    const cur = new Map();
    for (const [o, p, pc] of hist.base) if (weight.has(o)) cur.set(o, [p, pc]);
    const byDay = Array.from({ length: N }, () => []);
    for (const r of hist.rows) if (weight.has(r[0])) byDay[r[1]].push(r);
    const card = [], bank = [];
    for (let d = 0; d < N; d++) {
      for (const [o, , p, pc] of byDay[d]) cur.set(o, [p, pc]);
      let w = 0, sp = 0, sc = 0;
      for (const [o, [p, pc]] of cur) { const k = weight.get(o); w += k; sp += k * p; sc += k * (pc ?? p); }
      bank.push(w ? sp / w : null); card.push(w ? sc / w : null);
    }
    return { card, bank };
  }, [hist, list]);
  if (!series) return <div className="a-empty">Загрузка истории…</div>;
  const nums = [...series.card, ...series.bank].filter(v => v !== null);
  if (!nums.length) return <div className="a-empty">История появится после нескольких сборов цен расширением.</div>;
  const scale = niceScale(Math.min(...nums), Math.max(...nums), true);
  const S = [
    { key: 'card', label: 'СПП с Ozon Картой', fmt: 'pct', color: 'var(--a-accent)', kind: 'line', side: 'left', values: series.card, scale },
    { key: 'bank', label: 'СПП: другие банки', fmt: 'pct', color: 'var(--a-spend)', kind: 'line', side: 'left', values: series.bank, scale },
  ];
  return (
    <>
      <ChartPane dates={hist.dates} series={S} events={[]} tip={tip} height={220} showX onHover={setHover} hoverIdx={hover} />
      <div className="s-legend">{S.map(x => <span key={x.key}><i style={{ background: x.color }} />{x.label}</span>)}</div>
    </>
  );
}

export default function SoinvestCats({ cabinet }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [sort, setSort] = useState({ key: 'rev', dir: -1 });
  const [hist, setHist] = useState(null);
  const [histDays, setHistDays] = useState(30);
  const [groupsData, setGroupsData] = useState({ groups: [], members: {} });
  const [group, setGroup] = useState('');
  const [newGroup, setNewGroup] = useState(null);
  const tip = useTip();
  useEffect(() => { setHist(null); getDiscountHistory(cabinet, histDays).then(r => setHist(r.data.data)).catch(() => setHist({ dates: [], rows: [], base: [] })); }, [cabinet, histDays]);
  useEffect(() => { getAdsGroups(cabinet).then(r => setGroupsData(r.data.data || { groups: [], members: {} })).catch(() => {}); }, [cabinet]);

  const load = useCallback(() => {
    setLoading(true);
    getDiscountOverview(cabinet).then(r => setData(r.data.data)).catch(() => setData({ items: [] })).finally(() => setLoading(false));
  }, [cabinet]);
  useEffect(() => { load(); }, [load]);

  const items = useMemo(() => (data?.items || []).map(a => ({ ...a, parts: a.cat.split(SEP), short: shortModel(a.n) || a.n })), [data]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(a => (!sel || a.cat === sel || a.cat.startsWith(sel + SEP)) && (!group || groupsData.members[a.o] === group)
      && (!q || a.o.toLowerCase().includes(q) || a.n.toLowerCase().includes(q)));
  }, [items, sel, search, group, groupsData]);
  const groupColors = useMemo(() => groupColorMap(groupsData.groups), [groupsData]);
  const tops = useMemo(() => {
    // Тот же порядок (и цвета), что в «Аналитике продаж».
    const rank = new Map(['Чехлы', 'Дефлекторы', 'Утеплители', 'Аксессуары'].map((x, i) => [x, i]));
    return [...new Set(items.map(a => a.parts[0]))].sort((x, y) => ((rank.has(x) ? rank.get(x) : 99) - (rank.has(y) ? rank.get(y) : 99)) || naturalCompare(x, y));
  }, [items]);

  if (loading && !data) return <div className="mpui"><div className="a-empty" style={{ padding: 40, textAlign: 'center' }}>Загрузка…</div></div>;

  const last = data?.lastCheckedAt ? dayjs(data.lastCheckedAt) : null;
  const ageH = last ? dayjs().diff(last, 'minute') / 60 : null;
  if (!items.length) {
    return (
      <div className="mpui">
        <div className="a-card" style={{ padding: 22, lineHeight: 1.6 }}>
          <b>Данных о Соинвесте по этому кабинету пока нет.</b><br />
          Цену на витрине с учётом Соинвеста Ozon отдаёт только кабинет продавца, а запросы с серверов Ozon блокирует.
          Поэтому цены собирает маленькое расширение браузера «Соинвест Ozon» — в том браузере, где вы вошли в seller.ozon.ru.
          Оно раз в час берёт цены по всем товарам Licio и Defly и присылает сюда. Как поставить — в файле README рядом с расширением.
        </div>
      </div>
    );
  }

  const depth = sel ? sel.split(SEP).length : 0;
  const all = stats(filtered);
  const groupBy = (list, d) => {
    const m = new Map();
    for (const a of list) { const k = a.parts[d]; if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return m;
  };
  const sortVal = (st, a) => {
    switch (sort.key) {
      case 'avg': return st.avgW ?? -1; case 'card': return st.avgCardW ?? -1; case 'd1': return st.c1 ?? -999; case 'd7': return st.c7 ?? -999; case 'n': return st.n;
      default: return st.rev + (a ? 0 : 0);
    }
  };
  const rows = [];
  const sortArts = l => [...l].sort((x, y) => (sort.key === 'avg' ? y.pct - x.pct : sort.key === 'card' ? y.pctCard - x.pctCard : sort.key === 'd1' ? (y.c1 ?? -999) - (x.c1 ?? -999) : y.revenue30 - x.revenue30));
  const pushLevel = (list, d, prefix) => {
    const m = groupBy(list, d);
    const groups = [...m.entries()].map(([k, l]) => ({ k, l, st: stats(l) })).sort((x, y) => (sortVal(x.st) - sortVal(y.st)) * sort.dir);
    groups.forEach(({ k, l, st }, gi) => {
      const path = prefix ? prefix + SEP + k : k;
      const isOpen = open.has(path);
      const color = d === 0 ? (CAT_COLORS[tops.indexOf(k)] || OTHER) : null;
      rows.push(
        <tr key={'c' + path} className={`row s-cat d${d - depth} ${isOpen ? 'open' : ''}`} onClick={() => setOpen(p => { const n = new Set(p); n.has(path) ? n.delete(path) : n.add(path); return n; })}>
          <td><div className="a-art" style={{ paddingLeft: (d - depth) * 16 }}><span className="a-chev">▶</span>{color && <i className="s-dot" style={{ background: color }} />}<span className="s-cname">{k}</span><span className="a-hint">{l.length}</span>
            <button type="button" className="s-focus" title="Показать только эту категорию" onClick={e => { e.stopPropagation(); setSel(path); }}>⌕</button></div></td>
          <td className="r"><b className="n">{pct(st.avgW)}</b></td>
          <td className="r"><b className="n sv-card">{pct(st.avgCardW)}</b></td>
          <td className="r"><Delta value={st.c1} unit="pp" goodWhen="up" /></td>
          <td className="r"><Delta value={st.c7} unit="pp" goodWhen="up" /></td>
          <td className="n r muted">{pct(st.min)} – {pct(st.max)}</td>
          <td className="n r">{fmtInt(st.rev)}</td>
          <td colSpan={4} />
        </tr>
      );
      if (!isOpen) return;
      const deeper = l.some(a => a.parts.length > d + 1);
      if (deeper) pushLevel(l, d + 1, path);
      else sortArts(l).slice(0, 200).forEach(a => rows.push(artRow(a, (d - depth + 1) * 16 + 14)));
    });
  };
  function artRow(a, indent, showCat) {
    return (
          <tr key={'a' + a.o} className="s-art">
            <td><div className="a-art" style={{ paddingLeft: indent }}><div style={{ minWidth: 0 }}><div className="id">{a.o}
              {groupsData.members[a.o] && <i className="s-dot" style={{ background: groupColors[groupsData.members[a.o]], marginLeft: 6 }} title={(groupsData.groups.find(g => g.id === groupsData.members[a.o]) || {}).name} />}</div>
              <div className="model" title={a.n}>{showCat ? `${a.short} · ${a.cat}` : a.short}</div></div></div></td>
            <td className="r"><b className="n">{pct(a.pct)}</b></td>
            <td className="r"><b className="n sv-card">{pct(a.pctCard)}</b></td>
            <td className="r"><Delta value={a.c1} unit="pp" goodWhen="up" /></td>
            <td className="r"><Delta value={a.c7} unit="pp" goodWhen="up" /></td>
            <td />
            <td className="n r">{fmtInt(a.revenue30)}</td>
            <td className="n r">{fmtInt(a.seller)}</td>
            <td className="n r">{fmtInt(a.site)}</td>
            <td className="n r sv-card">{a.card ? fmtInt(a.card) : '—'}</td>
            <td className="r a-hint">{a.schema || ''}</td>
          </tr>
    );
  }
  // При поиске — сразу список найденных артикулов с ценами, без раскрытия категорий.
  if (search.trim() || group) sortArts(filtered).slice(0, 300).forEach(a => rows.push(artRow(a, 0, true)));
  else pushLevel(filtered, depth, sel);

  const crumbs = sel ? sel.split(SEP) : [];
  const TH = (k, t) => <th className={`r ${k ? 'sortable' : ''} ${sort.key === k ? 'sorted' : ''}`} onClick={() => k && setSort(p => p.key === k ? { key: k, dir: -p.dir } : { key: k, dir: -1 })}>{t}{sort.key === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</th>;

  return (
    <div className="mpui">
      <div className="a-bar">
        <span className="a-fresh" style={{ marginLeft: 0 }}>
          <span className={`a-dot ${ageH === null ? 'bad' : ageH > 6 ? 'bad' : ageH > 2 ? 'warn' : ''}`} />
          {last ? `Цены обновлены ${last.format('DD.MM HH:mm')}` : 'Цены ещё не собирались'}
          {ageH !== null && ageH > 2 && ' — проверьте, что браузер с расширением открыт и вы вошли в seller.ozon.ru'}
        </span>
        <input className="a-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="Артикул или название" style={{ marginLeft: 'auto', minWidth: 220 }} />
      </div>
      <div className="a-bar">
        <div className="a-tabs">
          <button type="button" className={`a-tab ${!sel ? 'on' : ''}`} onClick={() => setSel('')}>Все<span className="c">{items.length}</span></button>
          {tops.map((c, i) => (
            <button key={c} type="button" className={`a-tab ${sel === c || sel.startsWith(c + SEP) ? 'on' : ''}`} onClick={() => setSel(c)}>
              <i className="s-dot" style={{ background: CAT_COLORS[i] || OTHER }} />{c}<span className="c">{items.filter(a => a.parts[0] === c).length}</span>
            </button>
          ))}
        </div>
      </div>
      {sel && (
        <div className="a-bar s-crumbs">
          <button type="button" className="s-crumb" onClick={() => setSel('')}>Все</button>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}><span className="a-hint">›</span>
              <button type="button" className={`s-crumb ${i === crumbs.length - 1 ? 'on' : ''}`} onClick={() => setSel(crumbs.slice(0, i + 1).join(SEP))}>{c}</button>
            </React.Fragment>
          ))}
        </div>
      )}

      <div className="a-bar">
        <div className="a-tabs">
          <span className="a-hint" style={{ marginRight: 4 }}>Группы:</span>
          <button type="button" className={`a-tab ${!group ? 'on' : ''}`} onClick={() => setGroup('')}>Все товары</button>
          {groupsData.groups.map(g => (
            <button key={g.id} type="button" className={`a-tab ${group === g.id ? 'on' : ''}`} onClick={() => setGroup(group === g.id ? '' : g.id)}>
              <i className="s-dot" style={{ background: groupColors[g.id] }} />{g.name}<span className="c">{Object.values(groupsData.members).filter(x => x === g.id).length}</span>
            </button>
          ))}
          {newGroup === null ? (
            <button type="button" className="a-tab add" onClick={() => setNewGroup('')}>+ Группа</button>
          ) : (
            <form style={{ display: 'flex', gap: 6 }} onSubmit={e => { e.preventDefault(); const n = newGroup.trim(); if (!n) return; addAdsGroup(cabinet, n).then(r => { setGroupsData(r.data.data); setNewGroup(null); }).catch(err => window.alert(err.response?.data?.error || 'Не удалось создать группу')); }}>
              <input className="a-input" autoFocus value={newGroup} onChange={e => setNewGroup(e.target.value)} placeholder="Название группы" onKeyDown={e => { if (e.key === 'Escape') setNewGroup(null); }} style={{ padding: '5px 10px' }} />
              <button type="submit" className="a-btn" disabled={!newGroup.trim()}>Создать</button>
            </form>
          )}
        </div>
        {group && <AddToGroup catalog={items.map(a => ({ offerId: a.o, productName: a.n }))} exclude={Object.entries(groupsData.members).filter(([, g]) => g === group).map(([o]) => o)}
          onPick={o => { setGroupsData(p => ({ ...p, members: { ...p.members, [o]: group } })); assignAdsGroup(cabinet, o, group).catch(() => {}); }} />}
      </div>
      <div className="a-hint" style={{ marginTop: -8 }}>Группы общие с вкладкой «Реклама»: созданная здесь группа появится и там.</div>

      <div className="a-kpis s-kpis">
        <div className="a-kpi"><span className="lbl">СПП с Ozon Картой (по выручке)</span><span className="val n sv-card">{pct(all.avgCardW)}</span>
          <span className="sub"><Delta value={all.c1} unit="pp" goodWhen="up" /> за сутки · <Delta value={all.c7} unit="pp" goodWhen="up" /> за неделю</span></div>
        <div className="a-kpi"><span className="lbl">СПП по картам других банков</span><span className="val n">{pct(all.avgW)}</span>
          <span className="sub"><Delta value={all.d1} unit="pp" goodWhen="up" /> за сутки · простое среднее {pct(all.avg)}</span></div>
        <div className="a-kpi"><span className="lbl">Товаров с СПП</span><span className="val n">{fmtInt(filtered.filter(a => a.pctCard >= 0.05).length)} <small className="s-of">из {fmtInt(filtered.length)}</small></span>
          <span className="sub">разброс (Ozon Карта) {pct(all.min)} – {pct(all.max)}</span></div>
        <div className="a-kpi"><span className="lbl">Изменилось за сутки</span><span className="val n">{fmtInt(all.up + all.down)}</span>
          <span className="sub"><span style={{ color: 'var(--a-good)' }}>▲ {all.up}</span> · <span style={{ color: 'var(--a-bad)' }}>▼ {all.down}</span> (на 0,5 п.п. и больше)</span></div>
      </div>

      <div className="a-card" style={{ padding: 14 }}>
        <div className="a-bar" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 14 }}>Как менялся СПП{group ? ` · ${(groupsData.groups.find(g => g.id === group) || {}).name || ''}` : sel ? ` · ${sel.split(SEP).pop()}` : ''}</b>
          <span className="a-hint">среднее по выбранным товарам с весом по выручке за 30 дней</span>
          <span className="a-seg" style={{ marginLeft: 'auto' }}>{[7, 14, 30, 90].map(n => <button key={n} type="button" className={histDays === n ? 'on' : ''} onClick={() => setHistDays(n)}>{n} дн</button>)}</span>
        </div>
        <SppChart hist={hist} list={filtered} tip={tip} />
      </div>

      <div className={`a-card ${loading ? 'a-loading' : ''}`}>
        <div className="a-scroll">
          <table className="a-t s-tree">
            <thead><tr>
              <th>Категория / артикул</th>{TH('avg', 'СПП: другие банки')}{TH('card', 'СПП: Ozon Карта')}{TH('d1', 'За сутки')}{TH('d7', 'За неделю')}{TH(null, 'Разброс')}
              {TH('rev', 'Выручка 30 дн, ₽')}{TH(null, 'Цена продавца')}{TH(null, 'Цена: другие банки')}{TH(null, 'Цена: Ozon Карта')}{TH(null, 'Схема')}
            </tr></thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      </div>
      {tip.node}
      <div className="a-hint" style={{ lineHeight: 1.5 }}>
        СПП (Соинвест) = (цена продавца − цена для покупателя) / цена продавца, в двух уровнях: по картам других банков и с Ozon Картой.
        Цена берётся по схеме доставки, где товар в наличии (её и видит покупатель). В строках категорий — среднее с весом по выручке за 30 дней.
        На сайте цена может отличаться на ~0,5–1% в зависимости от адреса доставки покупателя.
      </div>
    </div>
  );
}
