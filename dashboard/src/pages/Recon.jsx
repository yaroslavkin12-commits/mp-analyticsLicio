import React, { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import { getFinancePnl } from '../api';
import { fmtInt } from './AdsStats2';
import { Kpi, Empty, pct1 } from './finShared';
import './ads2.css';
import './sales.css';

// ─────────────────────────────────────────────────────────────────────────
// «Сверка» — загружаете отчёт Ozon «Начисления» (xlsx из кабинета продавца:
// Финансы → Начисления → Скачать), сервис раскладывает его по тем же
// статьям, что P&L, и сравнивает с тем, что собрал скрипт: по статьям, по
// дням и по артикулам. Расхождение показывает, где данные неполные или
// статья отнесена не туда. Файл никуда не отправляется — разбор в браузере.
// ─────────────────────────────────────────────────────────────────────────

const BUCKETS = [['sale', 'Выручка (продажи)'], ['return', 'Возвраты'], ['commission', 'Комиссия'], ['logistics', 'Логистика и доставка'], ['acquiring', 'Эквайринг'],
  ['storage', 'Хранение и размещение'], ['ads', 'Реклама'], ['promo', 'Подписки, отзывы, бейджи'], ['other', 'Прочее и штрафы']];
const LABEL = Object.fromEntries(BUCKETS);

function bucketOfReport(group, type) {
  const g = String(group || ''), t = String(type || '');
  if (/^Продажи/i.test(g)) return 'sale';
  if (/^Возвраты/i.test(g)) return 'return';
  if (/Вознаграждение/i.test(g)) return 'commission';
  if (/эквайр/i.test(t)) return 'acquiring';
  if (/размещени|хранени/i.test(t)) return 'storage';
  if (/Услуги доставки|Услуги партн|Услуги FBO/i.test(g)) return 'logistics';
  if (/упаков/i.test(t)) return 'logistics';
  if (/Продвижение/i.test(g)) return /клик|оплатой за заказ|трафарет|продвижение в поиске/i.test(t) ? 'ads' : 'promo';
  if (/Озон Технологии/i.test(g)) return 'promo';
  return 'other';
}
const day = v => (v instanceof Date ? dayjs(v).format('YYYY-MM-DD') : /^\d{2}\.\d{2}\.\d{4}/.test(String(v)) ? `${String(v).slice(6, 10)}-${String(v).slice(3, 5)}-${String(v).slice(0, 2)}` : String(v || '').slice(0, 10));
// Отчёт Ozon записан строками вида <c t="str"><v>&#x41F;…</v></c> — библиотека
// xlsx портит такую кириллицу, поэтому читаем лист сами (zip → XML).
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = t => String(t).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e] ?? m)));
function readSheet(XLSX, buf) {
  const cfb = XLSX.CFB.read(new Uint8Array(buf), { type: 'array' });
  const file = name => { const i = cfb.FullPaths.findIndex(p => p.endsWith(name)); return i >= 0 ? new TextDecoder().decode(cfb.FileIndex[i].content) : null; };
  const sheetXml = file('xl/worksheets/sheet1.xml');
  if (!sheetXml) { const wb = XLSX.read(buf, { type: 'array', cellDates: true }); return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true }); }
  const sst = []; const sx = file('xl/sharedStrings.xml') || '';
  sx.replace(/<si>([\s\S]*?)<\/si>/g, (m, inner) => { sst.push(unxml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))); return m; });
  const col = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const out = [];
  for (const rowXml of sheetXml.split('<row').slice(1)) {
    const row = []; let ci = 0;
    const re = /<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
    while ((m = re.exec(rowXml))) {
      const attrs = m[1], body = m[2] || '';
      const r = attrs.match(/\br="([A-Z]+\d+)"/); if (r) ci = col(r[1]);
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      let val = v === undefined ? '' : unxml(v);
      if (t === 's') val = sst[Number(val)] ?? '';
      else if ((t === 'n' || !t) && val !== '' && !Number.isNaN(Number(val))) val = Number(val);
      row[ci++] = val;
    }
    out.push(row);
  }
  // Даты в отчёте — числа Excel: переводим в колонках «Дата …».
  const hi = out.findIndex(r => r.some(c => String(c).trim() === 'Тип начисления'));
  if (hi >= 0) out[hi].forEach((h, ci) => { if (/^Дата/.test(String(h))) for (let i = hi + 1; i < out.length; i++) { const v = out[i][ci]; if (typeof v === 'number' && v > 30000) out[i][ci] = new Date(Math.round((v - 25569) * 86400e3)); } });
  return out;
}
const ok = (a, b) => Math.abs(a - b) <= Math.max(100, Math.abs(a) * 0.01);
const Diff = ({ a, b }) => {
  const d = b - a;
  return <span className={`pill ${ok(a, b) ? 'g' : Math.abs(d) <= Math.max(1000, Math.abs(a) * 0.05) ? 'w' : 'b'}`}>{d > 0 ? '+' : ''}{fmtInt(d)}</span>;
};

export default function Recon({ cabinet }) {
  const [rep, setRep] = useState(null);
  const [ours, setOurs] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [openArt, setOpenArt] = useState(null);

  async function onFile(file) {
    if (!file) return;
    setError(null); setBusy('Читаю отчёт…'); setOurs(null);
    try {
      const XLSX = await import('xlsx');
      const aoa = readSheet(XLSX, await file.arrayBuffer());
      const hi = aoa.findIndex(r => r && r.some(c => String(c).trim() === 'Тип начисления'));
      if (hi < 0) throw new Error('Не нашёл колонку «Тип начисления» — это точно отчёт «Начисления»?');
      const H = aoa[hi].map(c => String(c || '').trim());
      const col = name => H.findIndex(h => h.startsWith(name));
      const cG = col('Группа услуг'), cT = col('Тип начисления'), cA = col('Артикул'), cS = col('Сумма итого'), cD = col('Дата начисления'), cSch = col('Схема работы');
      const rows = [];
      for (const r of aoa.slice(hi + 1)) {
        if (!r || r[cT] === undefined || r[cT] === null || r[cT] === '') continue;
        const amount = Number(String(r[cS]).replace(/\s/g, '').replace(',', '.')) || 0;
        rows.push({ d: day(r[cD]), art: String(r[cA] || ''), b: bucketOfReport(r[cG], r[cT]), group: String(r[cG] || ''), type: String(r[cT] || ''), scheme: String(r[cSch] || ''), amount });
      }
      if (!rows.length) throw new Error('В отчёте нет строк начислений');
      const dates = rows.map(r => r.d).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      const period = (String(aoa[0]?.[0] || '').match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/) || []);
      const from = period[1] ? day(period[1]) : dates[0], to = period[2] ? day(period[2]) : dates[dates.length - 1];
      setRep({ rows, from, to, name: file.name });
      setBusy('Загружаю данные сервиса за тот же период…');
      const p = await getFinancePnl(cabinet, { dateFrom: from, dateTo: to, fresh: 1 });
      setOurs(p.data.data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    setBusy('');
  }

  const cmp = useMemo(() => {
    if (!rep || !ours) return null;
    const R = { b: {}, d: new Map(), a: new Map(), types: new Map() }, O = { b: {}, d: new Map(), a: new Map() };
    const addA = (M, art, b, v) => { const k = art || '—'; const x = M.get(k) || {}; x[b] = (x[b] || 0) + v; x.all = (x.all || 0) + v; M.set(k, x); };
    for (const r of rep.rows) {
      if (r.d < rep.from || r.d > rep.to) continue;
      R.b[r.b] = (R.b[r.b] || 0) + r.amount; R.d.set(r.d, (R.d.get(r.d) || 0) + r.amount); addA(R.a, r.art, r.b, r.amount);
      const tk = r.group + ' · ' + r.type; const t = R.types.get(tk) || { group: r.group, type: r.type, b: r.b, sum: 0, n: 0 }; t.sum += r.amount; t.n++; R.types.set(tk, t);
    }
    for (const [ai, di, bi, a] of ours.rows) {
      const b = ours.buckets[bi], d = ours.dates[di], art = ours.articles[ai]?.o || '';
      O.b[b] = (O.b[b] || 0) + a; O.d.set(d, (O.d.get(d) || 0) + a); addA(O.a, art, b, a);
    }
    for (const [di, bi, a] of ours.noSku) { const b = ours.buckets[bi], d = ours.dates[di]; O.b[b] = (O.b[b] || 0) + a; O.d.set(d, (O.d.get(d) || 0) + a); addA(O.a, '', b, a); }
    const tot = o => Object.values(o).reduce((s, v) => s + v, 0);
    const days = [...new Set([...R.d.keys(), ...O.d.keys()])].filter(d => d >= rep.from && d <= rep.to).sort();
    const arts = [...new Set([...R.a.keys(), ...O.a.keys()])].map(k => ({ k, r: R.a.get(k) || {}, o: O.a.get(k === '—' ? '—' : k) || {} }))
      .map(x => ({ ...x, diff: (x.o.all || 0) - (x.r.all || 0) })).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
    return { R, O, totR: tot(R.b), totO: tot(O.b), days, arts, types: [...R.types.values()].sort((x, y) => Math.abs(y.sum) - Math.abs(x.sum)) };
  }, [rep, ours]);

  return (
    <div className="mpui sa-page">
      <div className="page-sticky"><div className="a-top">
        <h1>Сверка с отчётом Ozon</h1>
        <label className="a-btn primary" style={{ cursor: 'pointer' }}>
          {rep ? 'Загрузить другой отчёт' : 'Загрузить отчёт «Начисления» (xlsx)'}
          <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={e => onFile(e.target.files[0])} />
        </label>
        {rep && <span className="a-hint">{rep.name} · {dayjs(rep.from).format('DD.MM')}–{dayjs(rep.to).format('DD.MM.YYYY')} · {fmtInt(rep.rows.length)} строк</span>}
        {busy && <span className="a-hint">{busy}</span>}
      </div></div>

      {error && <div className="c-msg bad">{error}</div>}
      {!rep && (
        <Empty>
          <b>Как сверить:</b> в кабинете Ozon откройте <i>Финансы → Начисления</i>, выберите период (до месяца), нажмите «Скачать» и загрузите файл сюда.
          Сервис разложит отчёт по статьям P&L и сравнит с тем, что собрал Google-скрипт: итоги по статьям, по дням и по артикулам.
          Расхождение до 1% (или до 100 ₽) — норма: часть начислений Ozon проводит с задержкой. Файл обрабатывается прямо в браузере и никуда не отправляется.
        </Empty>
      )}

      {cmp && (
        <>
          <div className="a-kpis s-kpis">
            <Kpi label="Итого по отчёту Ozon" value={`${fmtInt(cmp.totR)} ₽`} sub="сумма всех начислений" />
            <Kpi label="Итого в сервисе" value={`${fmtInt(cmp.totO)} ₽`} sub={<Diff a={cmp.totR} b={cmp.totO} />} />
            <Kpi label="Совпадение" value={pct1(cmp.totR ? Math.max(0, 100 - Math.abs(cmp.totO - cmp.totR) / Math.abs(cmp.totR) * 100) : null)} sub="100% − расхождение к сумме отчёта" />
            <Kpi label="Дней с расхождением" value={`${cmp.days.filter(d => !ok(cmp.R.d.get(d) || 0, cmp.O.d.get(d) || 0)).length} из ${cmp.days.length}`} sub="больше 1% или 100 ₽" />
          </div>

          <div className="s-two">
            <div className="a-card">
              <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>По статьям</b></div>
              <table className="a-t s-slice">
                <thead><tr><th>Статья</th><th className="r">Отчёт Ozon</th><th className="r">Сервис</th><th className="r">Разница</th></tr></thead>
                <tbody>
                  {BUCKETS.filter(([k]) => cmp.R.b[k] || cmp.O.b[k]).map(([k, l]) => (
                    <tr key={k}><td>{l}</td><td className="n r">{fmtInt(cmp.R.b[k] || 0)}</td><td className="n r">{fmtInt(cmp.O.b[k] || 0)}</td><td className="r"><Diff a={cmp.R.b[k] || 0} b={cmp.O.b[k] || 0} /></td></tr>
                  ))}
                  <tr className="s-total"><td><b>Итого</b></td><td className="n r">{fmtInt(cmp.totR)}</td><td className="n r">{fmtInt(cmp.totO)}</td><td className="r"><Diff a={cmp.totR} b={cmp.totO} /></td></tr>
                </tbody>
              </table>
            </div>
            <div className="a-card">
              <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>По дням</b><span className="a-hint">по дате начисления</span></div>
              <table className="a-t s-slice">
                <thead><tr><th>День</th><th className="r">Отчёт Ozon</th><th className="r">Сервис</th><th className="r">Разница</th></tr></thead>
                <tbody>{cmp.days.map(d => (
                  <tr key={d}><td>{dayjs(d).format('DD.MM, dd')}</td><td className="n r">{fmtInt(cmp.R.d.get(d) || 0)}</td><td className="n r">{fmtInt(cmp.O.d.get(d) || 0)}</td><td className="r"><Diff a={cmp.R.d.get(d) || 0} b={cmp.O.d.get(d) || 0} /></td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>Артикулы с наибольшим расхождением</b><span className="a-hint">клик — по статьям; «—» — начисления без артикула</span></div>
            <table className="a-t s-slice">
              <thead><tr><th>Артикул</th><th className="r">Отчёт Ozon</th><th className="r">Сервис</th><th className="r">Разница</th></tr></thead>
              <tbody>
                {cmp.arts.filter(x => !ok(x.r.all || 0, x.o.all || 0)).slice(0, 40).map(x => (
                  <React.Fragment key={x.k}>
                    <tr className={`row ${openArt === x.k ? 'open' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setOpenArt(openArt === x.k ? null : x.k)}>
                      <td><b>{x.k}</b></td><td className="n r">{fmtInt(x.r.all || 0)}</td><td className="n r">{fmtInt(x.o.all || 0)}</td><td className="r"><Diff a={x.r.all || 0} b={x.o.all || 0} /></td>
                    </tr>
                    {openArt === x.k && BUCKETS.filter(([k]) => x.r[k] || x.o[k]).map(([k, l]) => (
                      <tr key={k} className="sub"><td style={{ paddingLeft: 28 }} className="muted">{l}</td><td className="n r">{fmtInt(x.r[k] || 0)}</td><td className="n r">{fmtInt(x.o[k] || 0)}</td><td className="r"><Diff a={x.r[k] || 0} b={x.o[k] || 0} /></td></tr>
                    ))}
                  </React.Fragment>
                ))}
                {!cmp.arts.some(x => !ok(x.r.all || 0, x.o.all || 0)) && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>Расхождений по артикулам нет</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="a-card">
            <div className="a-bar" style={{ padding: '12px 14px 4px' }}><b style={{ fontSize: 14 }}>Типы начислений в отчёте</b><span className="a-hint">как сервис относит каждый тип — для проверки разноски</span></div>
            <table className="a-t s-slice">
              <thead><tr><th>Группа услуг</th><th>Тип начисления</th><th>Статья в сервисе</th><th className="r">Строк</th><th className="r">Сумма</th></tr></thead>
              <tbody>{cmp.types.map(t => (
                <tr key={t.group + t.type}><td className="muted">{t.group}</td><td>{t.type}</td><td>{LABEL[t.b]}</td><td className="n r">{fmtInt(t.n)}</td><td className="n r">{fmtInt(t.sum)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
