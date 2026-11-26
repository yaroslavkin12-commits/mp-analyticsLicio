import React, { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getWbDiscounts } from '../api';
import ArtSearch, { artMatch } from '../components/ArtSearch';
import CategoryNav from '../components/CategoryNav';
import DateRangePicker from '../components/DateRangePicker';

const SEP = ' / ';
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
const price = n => n == null ? '—' : money.format(n);
const discount = ([seller, buyer, count]) => count && seller > 0 ? ((1 - buyer / seller) * 100).toFixed(1).replace('.', ',') + '%' : '—';
const total = values => values.reduce(([seller, buyer, count], row) => [seller + row[0], buyer + row[1], count + row[2]], [0, 0, 0]);
const prices = ([seller, buyer, count]) => [price(count ? seller / count : null), price(count ? buyer / count : null)];

export default function WbDiscounts({ cabinet, active }) {
  const [range, setRange] = useState(() => [dayjs().subtract(29, 'day').format('YYYY-MM-DD'), dayjs().format('YYYY-MM-DD')]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [detail, setDetail] = useState(null);
  const [view, setView] = useState('articles');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    getWbDiscounts(cabinet, ...range).then(r => {
      if (!cancelled) setData(r.data.data);
    }).catch(e => {
      if (!cancelled) setError(e.response?.data?.error || 'Не удалось загрузить цены WB');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cabinet, active, range, revision]);
  const items = useMemo(() => (data?.items || []).map(row => ({ ...row, parts: row.cat.split(SEP), value: total(Object.values(row.days)) })), [data]);
  const filtered = items.filter(row => (!category || row.cat === category || row.cat.startsWith(category + SEP)) && artMatch(row.o, row.n, search));
  const groups = new Map();
  const depth = category ? category.split(SEP).length + 1 : 1;
  for (const row of filtered) {
    const name = row.parts.slice(0, depth).join(SEP);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  const summary = total(filtered.map(row => row.value));
  const detailItems = detail === 'all' ? filtered : view === 'categories' ? groups.get(detail) || [] : filtered.filter(row => row.o === detail);
  const daily = detail ? (data?.dates || []).map(date => [date, total(detailItems.flatMap(row => row.days[date] ? [row.days[date]] : []))]) : [];
  const trend = daily.map(([date, [seller, buyer, n]]) => ({
    date, seller: n ? seller / n : null, buyer: n ? buyer / n : null,
  }));
  return <div className="mpui sa-page">
    <div className="page-sticky"><div className="a-top">
      <h1>Соинвест WB</h1>
      <ArtSearch options={items} value={search} onChange={v => { setSearch(v); setDetail(null); }} placeholder="Артикул или название" />
      <DateRangePicker from={range[0]} to={range[1]} onChange={(from, to) => setRange([from, to])} />
      <button type="button" className="a-btn" disabled={loading} onClick={() => setRevision(n => n + 1)}>Обновить</button>
      {data?.pricesAt && <span className="a-hint">Цены продавца на {dayjs(data.pricesAt).format('DD.MM.YYYY HH:mm')}</span>}
    </div></div>
    <CategoryNav tops={[...new Set(items.map(row => row.parts[0]))]} value={category}
      onChange={value => { setCategory(value); setDetail(null); }}
      childrenOf={path => [...new Set(items.filter(row => row.cat.startsWith(path + SEP)).map(row => row.parts[path.split(SEP).length]).filter(Boolean))]} />
    <div className="a-bar" style={{ margin: '16px 0 8px', flexWrap: 'wrap' }}>
      <span className="a-seg">{[['articles', 'По артикулам'], ['categories', 'По категориям']].map(([id, title]) =>
        <button type="button" key={id} className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => { setView(id); setDetail(null); }}>{title}</button>)}</span>
      <span className="a-hint">Цена покупателя по оформленным заказам. Разница может включать скидки WB Клуба и Кошелька. Нажмите на строку, чтобы открыть историю.</span>
    </div>
    {error && <div className="c-msg bad" role="alert">{error}</div>}
    {loading && <div className="a-hint" role="status">Загружаю цены WB…</div>}
    <div className="a-card" style={{ overflowX: 'auto' }}>
      <table className="a-t">
        <thead><tr><th>{view === 'articles' ? 'Артикул' : 'Категория'}</th><th>Цена продавца сейчас, от</th><th>Цена продавца по заказам</th><th>Цена покупателя по заказам</th><th>Разница, %</th><th>Заказов с двумя ценами</th></tr></thead>
        <tbody>
          <tr className="s-total"><td><button className="a-btn ghost" onClick={() => setDetail(detail === 'all' ? null : 'all')} aria-expanded={detail === 'all'}>Итого</button></td><td>—</td>{prices(summary).map((p, i) => <td key={i}>{p}</td>)}<td>{discount(summary)}</td><td>{summary[2]}</td></tr>
          {(view === 'articles' ? filtered.map(row => [row.o, row.n, row.sellerNow, row.value]) : [...groups].map(([name, rows]) => [name, '', null, total(rows.map(row => row.value))])).map(([name, title, current, value]) =>
            <tr key={name}><td><button type="button" className="a-btn ghost" onClick={() => setDetail(detail === name ? null : name)} aria-expanded={detail === name}>{name}</button>{title && <small className="muted"> {title}</small>}</td><td>{price(current)}</td>{prices(value).map((p, i) => <td key={i}>{p}</td>)}<td>{discount(value)}</td><td>{value[2]}</td></tr>)}
        </tbody>
      </table>
      {!filtered.length && !loading && !error && <div className="a-hint" style={{ padding: 14 }}>Под выбранные фильтры ничего не найдено.</div>}
    </div>
    {detail && <div className="a-card" style={{ marginTop: 14, overflowX: 'auto' }}>
      <div className="a-bar" style={{ padding: 12 }}><b>История по дням · {detail === 'all' ? 'Итого' : detail}</b><button type="button" className="a-btn ghost" onClick={() => setDetail(null)}>Свернуть</button></div>
      {trend.some(row => row.buyer !== null) && <ResponsiveContainer width="100%" height={225}>
        <LineChart data={trend} margin={{ top: 12, right: 24, left: 12 }}>
          <CartesianGrid stroke="var(--a-line)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={d => dayjs(d).format('DD.MM')} />
          <YAxis tickFormatter={price} width={88} domain={['auto', 'auto']} />
          <Tooltip formatter={price} labelFormatter={d => dayjs(d).format('DD.MM.YYYY')} />
          <Line type="linear" name="Цена продавца" dataKey="seller" stroke="#4b8dff" strokeWidth={2} dot={{ r: 2 }} />
          <Line type="linear" name="Цена покупателя" dataKey="buyer" stroke="#a16af7" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>}
      <table className="a-t"><thead><tr><th>Дата</th><th>Цена продавца по заказам</th><th>Цена покупателя по заказам</th><th>Разница, %</th><th>Заказов с двумя ценами</th></tr></thead>
        <tbody>{daily.slice().reverse().map(([date, value]) => <tr key={date}><td>{dayjs(date).format('DD.MM.YYYY')}</td>{prices(value).map((p, i) => <td key={i}>{p}</td>)}<td>{discount(value)}</td><td>{value[2] || '—'}</td></tr>)}</tbody>
      </table>
    </div>}
  </div>;
}
