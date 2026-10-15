import React, { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import { closeProductionJournal } from '../api';
import { useTableCtl, ThCtl, ResetCtl } from '../components/TableTools';
import { fmtInt } from './AdsStats2';
import { SHOPS, J_STATUS } from '../lib/production';

// Журнал заявок на производство: что и когда передали в цех и видно ли это в
// пошиве 1С. Строка — артикул; открытые заявки суммируются. «Закрыть» —
// считать заявки по артикулу выполненными (например, отшили и пришло на склад).
export default function ProdJournal({ cabinet, journal, master, setD, setMsg }) {
  const [fSt, setFSt] = useState('');
  const [fShop, setFShop] = useState('');
  const [onlyFill, setOnlyFill] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [q, setQ] = useState('');
  const [full, setFull] = useState(false);
  const ctl = useTableCtl(`prodj-${cabinet}`, { k: 'date', dir: -1 });

  const open = journal.filter(r => !r.closed);
  const cnt = k => open.filter(r => r.st === k && (!fShop || r.shop === fShop)).length;
  const list = useMemo(() => journal.filter(r => (showClosed ? r.closed : !r.closed)
    && (!fSt || r.st === fSt) && (!fShop || r.shop === fShop) && (!onlyFill || r.fill > 0)
    && (!q || r.o.toLowerCase().includes(q.toLowerCase()) || String(master?.[r.o]?.n || '').toLowerCase().includes(q.toLowerCase()))),
  [journal, showClosed, fSt, fShop, onlyFill, q, master]);
  const ORDER = ['miss', 'part', 'wait', 'fresh', 'unk', 'work'];
  const GET = { o: r => r.o, shop: r => r.shop, date: r => r.last.at, qty: r => r.qty, sew0: r => r.sew0, sew: r => r.sewNow, inc: r => r.inc, stock: r => r.stockNow, st: r => ORDER.indexOf(r.st), days: r => r.days };
  const shown = ctl.apply(list, (r, k) => (GET[k] ? GET[k](r) : null));
  const vis = full ? shown : shown.slice(0, 30);

  const close = (offers, c) => closeProductionJournal(cabinet, offers, c)
    .then(r => setD(p => ({ ...p, closed: r.data.data })))
    .catch(e => setMsg({ bad: true, text: e.message }));

  return (
    <div className="a-card pr-card">
      <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <b style={{ fontSize: 14 }}>Журнал заявок</b>
        <span className="a-hint" style={{ margin: 0 }}>что передали в цех и появилось ли это в пошиве 1С · в расчёт потребности не входит, только подсказка</span>
      </div>
      <div className="a-bar" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <span className="a-seg">
          <button type="button" className={!fShop ? 'on' : ''} onClick={() => setFShop('')}>Все цеха</button>
          {SHOPS.map(s => <button key={s} type="button" className={fShop === s ? 'on' : ''} onClick={() => setFShop(s)}>{s}</button>)}
        </span>
        {!showClosed && ORDER.filter(k => k !== 'unk' || cnt(k)).map(k => (
          <button key={k} type="button" className={`s-chip ${fSt === k ? 'on' : ''}`} onClick={() => setFSt(v => (v === k ? '' : k))}>
            <span className={`pr-sig ${J_STATUS[k][1]}`}>{J_STATUS[k][0]}</span> <b className="n">{cnt(k)}</b>
          </button>
        ))}
        <button type="button" className={`s-chip ${onlyFill ? 'on' : ''}`} onClick={() => setOnlyFill(v => !v)} title="В заявке был добор сверх потребности">⊕ добор</button>
        <button type="button" className="a-toggle" onClick={() => { setShowClosed(v => !v); setFSt(''); }}><span className={`a-sw ${showClosed ? 'on' : ''}`} />Закрытые</button>
        <input className="a-input" placeholder="Артикул или название" value={q} onChange={e => setQ(e.target.value)} style={{ minWidth: 200 }} />
        <ResetCtl ctl={ctl} style={{ marginLeft: 'auto' }} />
      </div>
      <div className="a-scroll">
        <table className="a-t pr-t">
          <thead><tr>
            <ThCtl ctl={ctl} k="o" className="" filter={false}>Артикул</ThCtl>
            <ThCtl ctl={ctl} k="shop" className="" filter={false}>Цех</ThCtl>
            <ThCtl ctl={ctl} k="date" className="" filter={false} hint="Открытые заявки по артикулу: дата и количество">Заявки</ThCtl>
            <ThCtl ctl={ctl} k="qty" hint="Сумма открытых заявок">Заказано</ThCtl>
            <ThCtl ctl={ctl} k="sew0" hint="Сколько было в пошиве (1С) в момент первой открытой заявки">Пошив при заявке</ThCtl>
            <ThCtl ctl={ctl} k="sew" hint="В последнем загруженном файле «Пошив»">Пошив сейчас</ThCtl>
            <ThCtl ctl={ctl} k="inc" hint="Насколько вырос пошив после заявки — столько цех взял в работу">Взяли</ThCtl>
            <ThCtl ctl={ctl} k="stock" hint="Остаток на момент заявки → сейчас">Остаток</ThCtl>
            <ThCtl ctl={ctl} k="st" className="" filter={false}>Статус</ThCtl>
            <th />
          </tr></thead>
          <tbody>
            {!vis.length && <tr><td colSpan={10} className="muted" style={{ padding: 14 }}>{journal.length ? 'Ничего не подходит под фильтр' : 'Заявок пока нет — они появятся, когда вы зафиксируете заказ кнопкой «Зафиксировать»'}</td></tr>}
            {vis.map(r => {
              const s = J_STATUS[r.st] || ['закрыто', ''];
              const lines = r.closed ? r.closedLines : r.lines;
              return (
                <tr key={r.o} className={r.st === 'miss' ? 'pj-miss' : r.fill ? 'pr-fill-row' : ''}>
                  <td><div className="a-art"><div style={{ minWidth: 0 }}><div className="id">{r.o}</div><div className="model" title={master?.[r.o]?.n}>{master?.[r.o]?.car || master?.[r.o]?.n || ''}</div></div></div></td>
                  <td className="pr-l">{r.shop}</td>
                  <td className="pr-l" style={{ whiteSpace: 'normal', minWidth: 170 }}>
                    {lines.slice(-4).map(l => <div key={l.id + l.date} className="pj-line">{dayjs(l.date).format('DD.MM')} — <b>{l.qty}</b> шт{l.fill ? <span className="pr-fillb"> (добор {l.fill})</span> : ''}</div>)}
                    {lines.length > 4 && <small className="muted">ещё {lines.length - 4}</small>}
                  </td>
                  <td className="n r"><b>{fmtInt(r.closed ? lines.reduce((x, l) => x + l.qty, 0) : r.qty)}</b></td>
                  <td className="n r">{r.sew0 === null ? <span className="muted" title="Заявка подана до появления журнала — пошив на тот момент неизвестен, считаем от нуля">—</span> : fmtInt(r.sew0)}</td>
                  <td className="n r">{fmtInt(r.sewNow)}</td>
                  <td className="n r">{r.closed ? '—' : <span className={r.inc >= r.qty * 0.8 ? 's-up' : r.inc > 0 ? 's-warn' : 's-down'}>{r.inc > 0 ? `+${fmtInt(r.inc)}` : fmtInt(r.inc)}</span>}</td>
                  <td className="n r">{r.stock0 !== null ? <>{fmtInt(r.stock0)} → </> : null}{fmtInt(r.stockNow)}</td>
                  <td className="pr-l">{r.closed ? <span className="muted">закрыто {r.closedAt ? dayjs(r.closedAt).format('DD.MM') : ''}</span> : <span className={`pr-sig ${s[1]}`}>{s[0]}</span>}
                    {!r.closed && <small className="pr-sub2">{r.days ? `${r.days} дн с заявки` : 'сегодня'}</small>}</td>
                  <td className="r">{r.closed
                    ? <button type="button" className="a-btn ghost" onClick={() => close([r.o], false)} title="Вернуть в открытые">↺</button>
                    : <button type="button" className="a-btn ghost" onClick={() => close([r.o], true)} title="Закрыть: заявки по артикулу выполнены (отшили) или больше не ждём">✓ закрыть</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {shown.length > 30 && <button type="button" className="s-fold" onClick={() => setFull(f => !f)}>{full ? 'Свернуть ▲' : `Показать все ${shown.length} ▼`}</button>}
    </div>
  );
}
