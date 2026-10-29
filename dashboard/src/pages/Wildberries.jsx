import React, { useCallback, useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell } from 'recharts';
import { getWbData } from '../api';
import { ThCtl, ResetCtl, useTableCtl } from '../components/TableTools';
import './ads2.css';
import './sales.css';
const fmt = v => v == null ? '—' : Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
const labels = { sales: 'Аналитика продаж', orders: 'Заказы, продажи и возвраты', inventory: 'Остатки', ads: 'Реклама', costs: 'Товары и цены' };
const kindLabels = { catalog: 'Каталог', orders: 'Заказы', sales: 'Продажи и возвраты', stocks: 'Остатки WB и продавца', campaigns: 'Кампании', ads: 'Статистика рекламы', prices: 'Цены' };
const statusName = v => ({ 4: 'Готова к запуску', 7: 'Завершена', 8: 'Отклонена', 9: 'Работает', 11: 'На паузе' }[v] || String(v ?? '—'));
const colsFor = page => page === 'ads' ? [['name', 'Кампания'], ['status', 'Статус'], ['spend', 'Расход, ₽'], ['views', 'Показы'], ['clicks', 'Клики'], ['atbs', 'Корзины'], ['orders', 'Заказы РК, шт'], ['orderRub', 'Заказы РК, ₽'], ['ctr', 'CTR, %'], ['cpc', 'CPC, ₽'], ['drr', 'ДРР РК, %']]
  : page === 'inventory' ? [['offer', 'Артикул'], ['name', 'Название'], ['stockWb', 'Склад WB, шт'], ['stockSeller', 'Склады продавца, шт'], ['toClient', 'К покупателям, шт'], ['fromClient', 'От покупателей, шт']]
  : page === 'costs' ? [['offer', 'Артикул'], ['name', 'Название'], ['nmId', 'Артикул WB'], ['price', 'Цена продавца со скидкой, ₽']]
  : [['offer', 'Артикул'], ['name', 'Название'], ['orders', 'Заказы, шт'], ['orderRub', 'Заказано, ₽'], ['cancelled', 'Отменено, шт'], ['sold', 'Продажи, шт'], ['returned', 'Возвраты, шт'], ['net', 'Продажи − возвраты, шт']];
export default function Wildberries({ page = 'sales', cabinet, active }) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [from, setFrom] = useState(dayjs(today).subtract(page === 'ads' ? 13 : 29, 'day').format('YYYY-MM-DD')), [to, setTo] = useState(today);
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [q, setQ] = useState('');
  const [feed, setFeed] = useState('orders'), [metric, setMetric] = useState('orderRub'), [limit, setLimit] = useState(200), [exportBusy, setExportBusy] = useState(false);
  const ctl = useTableCtl('wb:' + page);
  const load = useCallback(async () => { setLoading(true); setError(''); try { const r = await getWbData(cabinet, { dateFrom: from, dateTo: to }); setData(r.data.data); } catch (e) { setError(e.response?.data?.error || e.message); } finally { setLoading(false); } }, [cabinet, from, to]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!active) return; const t = setInterval(load, 60000); return () => clearInterval(t); }, [active, load]);
  const columns = page === 'orders' ? [['date', 'Дата'], ['offer', 'Артикул'], ['name', 'Товар'], ['nmId', 'Артикул WB'], ['price', 'Сумма продавца со скидкой, ₽'], ['warehouse', 'Склад'], ['region', 'Регион'], ['state', 'Состояние'], ['id', 'ID']] : colsFor(page);
  const rows = useMemo(() => {
    if (!data) return [];
    const base = page === 'orders' ? (feed === 'orders' ? data.orders : data.sales.filter(r => feed === 'sales' ? r.type === 'sale' : r.type === 'return')).map(r => ({ ...r, state: feed === 'orders' ? r.cancelled ? 'Отменён' : 'Заказ' : r.type === 'sale' ? 'Продажа' : 'Возврат' }))
      : page === 'ads' ? data.campaigns.map(r => ({ ...r, ctr: r.views > 0 && r.clicks != null ? r.clicks / r.views * 100 : null, cpc: r.clicks > 0 && r.spend != null ? r.spend / r.clicks : null, drr: r.orderRub > 0 && r.spend != null ? r.spend / r.orderRub * 100 : null, status: statusName(r.status) }))
        : data.articles.map(r => ({ ...r, net: r.sold == null || r.returned == null ? null : r.sold - r.returned }));
    return ctl.apply(base.filter(r => !q || [r.offer, r.name, r.nmId, r.id].join(' ').toLowerCase().includes(q.toLowerCase())), (r, k) => r[k]);
  }, [data, page, feed, q, ctl.apply]);
  async function download() {
    setExportBusy(true); setError('');
    try { const XLSX = await import('xlsx'), book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns.map(c => c[1]), ...rows.map(r => columns.map(([k]) => r[k] ?? null))]), 'Defly WB'); XLSX.writeFile(book, `Defly WB ${labels[page]} ${from}—${to}.xlsx`); }
    catch (e) { setError(e.message); } finally { setExportBusy(false); }
  }
  const summary = data?.summary;
  const chartData = data?.daily.map((d, i, a) => { const prev = a[i - 7]?.[metric], v = d[metric]; const good = metric !== 'returned'; return { ...d, color: v == null || prev == null || d.date === today ? 'var(--a-ink3)' : v === 0 && prev === 0 ? 'var(--a-warn)' : v >= prev * 1.05 ? (good ? 'var(--a-good)' : 'var(--a-bad)') : v < prev * .95 ? (good ? 'var(--a-bad)' : 'var(--a-good)') : 'var(--a-warn)' }; });
  return <div className="mpui wb-page" data-no-art>
    <div className="page-sticky"><div className="a-top"><h1>{labels[page]}</h1><span className="a-hint">Defly · Wildberries</span><input className="a-input" aria-label="Начало периода WB" type="date" value={from} onChange={e => setFrom(e.target.value)} /><span>—</span><input className="a-input" aria-label="Конец периода WB" type="date" value={to} onChange={e => setTo(e.target.value)} />{[7, 14, 30, 90].map(n => <button className="a-btn ghost" key={n} onClick={() => { setFrom(dayjs(today).subtract(n - 1, 'day').format('YYYY-MM-DD')); setTo(today); }}>{n} дн</button>)}<button className="a-btn" disabled={loading} onClick={load}>{loading ? 'Загрузка…' : 'Обновить'}</button></div></div>
    {error && <div role="alert" className="c-msg bad">{error}</div>}
    {!data ? <div className="a-card" style={{ padding: 20 }}>{loading ? 'Загрузка WB…' : 'Не удалось загрузить данные WB. Нажмите «Обновить».'}</div> : <>
      <div className="a-card" style={{ padding: 16 }}><p style={{ marginTop: 0 }}>Оперативные данные WB: заказы, продажи, возвраты, остатки и реклама. Финансовые отчёты, прибыль и маржа пока не подключены.</p>
        {!data.configured && <p style={{ color: 'var(--a-warn)' }}>Для начала сбора настройте WB_SYNC_SECRET в Render и Apps Script, вставьте новую версию скрипта и запустите сбор. Токен WB остаётся только в свойствах Apps Script.</p>}
        {!data.status.some(s => s.receivedAt) && <p>Данные WB ещё не поступили. После запуска скрипта они появятся автоматически. Незаполненные показатели отмечены «—».</p>}
        <details><summary>Состояние загрузки</summary><div className="a-scroll"><table className="a-t"><thead><tr><th>Источник</th><th>Получено</th><th>Период</th><th>Строк</th><th>Примечание</th></tr></thead><tbody>{data.status.map(s => <tr key={s.kind}><td>{kindLabels[s.kind]}</td><td>{s.receivedAt ? dayjs(s.receivedAt).format('DD.MM HH:mm') : 'Нет данных'}</td><td>{s.from ? `${s.from} — ${s.to}` : 'Снимок'}</td><td>{fmt(s.total)}</td><td>{s.warning || (s.receivedAt && !s.available ? 'Выбранный период загружен не полностью' : s.receivedAt && dayjs().diff(dayjs(s.collectedAt), 'hour') > 3 ? 'Данные давно не обновлялись' : '')}</td></tr>)}</tbody></table></div></details>
      </div>
      {data.status.filter(s => s.receivedAt && !s.available).map(s => <p key={s.kind} style={{ color: 'var(--a-warn)' }}>{kindLabels[s.kind]}: выбранный период загружен не полностью. Итоги неизвестны; в ленте показаны только полученные строки.</p>)}
      {data.status.filter(s => s.warning).map(s => <p key={s.kind} style={{ color: 'var(--a-warn)' }}>{kindLabels[s.kind]}: {s.warning}</p>)}
      {page === 'sales' && <><div className="a-bar" style={{ flexWrap: 'wrap', gap: 12 }}>{[['orders', 'Заказы, шт'], ['orderRub', 'Заказано, ₽'], ['sold', 'Продажи, шт'], ['returned', 'Возвраты, шт'], ['cancelled', 'Отмены, шт']].map(([key, label]) => <div className="a-card" key={key} style={{ padding: '14px 20px', minWidth: 150 }}><div className="a-hint">{label}</div><strong style={{ fontSize: 24 }}>{fmt(summary[key])}</strong></div>)}</div><div className="a-card" style={{ padding: 16 }}><div className="a-bar"><b>Динамика</b><select className="a-input" aria-label="Метрика графика WB" value={metric} onChange={e => setMetric(e.target.value)}>{[['orderRub', 'Заказы, ₽'], ['orders', 'Заказы, шт'], ['sold', 'Продажи, шт'], ['returned', 'Возвраты, шт']].map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></div><div style={{ height: 260 }}><ResponsiveContainer><BarChart data={chartData}><CartesianGrid stroke="var(--a-line)" vertical={false} /><XAxis dataKey="date" tickFormatter={s => dayjs(s).format('DD.MM')} stroke="var(--a-ink3)" /><YAxis stroke="var(--a-ink3)" /><Tooltip formatter={fmt} contentStyle={{ background: 'var(--a-panel)', border: '1px solid var(--a-line2)' }} /><Bar dataKey={metric} name="Значение">{chartData.map(d => <Cell key={d.date} fill={d.color} />)}</Bar></BarChart></ResponsiveContainer></div><p className="a-hint">Цвет сравнивает с тем же днём недели: зелёный — выше на 5% и более, жёлтый — примерно на том же уровне, красный — ниже более чем на 5%. Для возвратов рост отмечается красным. Сегодняшний день нейтральный.</p></div></>}
      <div className="a-card" style={{ padding: 16 }}>
        <div className="a-bar"><input className="a-input" aria-label="Поиск WB" placeholder="Артикул, название или ID" value={q} onChange={e => { setQ(e.target.value); setLimit(200); }} />{page === 'orders' && <div className="a-seg">{[['orders', 'Заказы'], ['sales', 'Продажи'], ['returns', 'Возвраты']].map(([k, label]) => <button className={feed === k ? 'on' : ''} key={k} onClick={() => { setFeed(k); setLimit(200); }}>{label}</button>)}</div>}<ResetCtl ctl={ctl} /><span className="a-hint">Строк: {rows.length}</span><button className="a-btn ghost" disabled={exportBusy || !rows.length} onClick={download}>Скачать Excel</button></div>
        <div className="a-scroll"><table className="a-t"><thead><tr>{columns.map(([k, label]) => <ThCtl key={k} ctl={ctl} k={k} filter={!['offer', 'name', 'status', 'state', 'date', 'warehouse', 'region', 'id'].includes(k)}>{label}</ThCtl>)}</tr></thead><tbody>{rows.slice(0, limit).map((r, i) => <tr key={r.id || r.offer || i}>{columns.map(([k]) => <td key={k}>{k === 'offer' && r.nmId ? <a href={`https://www.wildberries.ru/catalog/${encodeURIComponent(r.nmId)}/detail.aspx`} target="_blank" rel="noreferrer">{r.offer}</a> : typeof r[k] === 'number' || r[k] == null ? fmt(r[k]) : String(r[k])}</td>)}</tr>)}{!rows.length && <tr><td colSpan={columns.length}>Нет строк по выбранным условиям.</td></tr>}</tbody></table></div>{rows.length > limit && <button className="a-btn ghost" onClick={() => setLimit(v => v + 500)}>Показать ещё</button>}
      </div>
      {page === 'orders' && <p className="a-hint">Одна строка статистики WB — один товар. Продажи и возвраты стоят в дате операции; заказы — в дате заказа. Это разные события, поэтому деление продаж за период на заказы не даёт корректный процент выкупа. Возвраты к продавцу по браку/перемещению в этот список не входят.</p>}
      {page === 'inventory' && <p className="a-hint">Остатки — последний полученный снимок, выбранный диапазон дат его не меняет. WB и склады продавца показаны отдельно.</p>}
      {page === 'ads' && <p className="a-hint">Расход — статистика рекламных кампаний WB, без финансового отчёта. ДРР РК = расход / сумма заказов, отнесённых WB к кампании. Показатели кампаний не складываются повторно с детализацией товаров.</p>}
      {page === 'costs' && <p className="a-hint">Цена продавца после его скидки. Цена покупателя с СПП может отличаться. Расчёт маржи появится после подключения финансов.</p>}
      {!!summary.unknownSales && <p style={{ color: 'var(--a-warn)' }}>Есть {summary.unknownSales} строк продаж с неизвестным типом операции; они не включены в продажи и возвраты.</p>}
    </>}
  </div>;
}
