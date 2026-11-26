import React, { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ArtSearch from '../components/ArtSearch';
import CategoryNav from '../components/CategoryNav';
import DateRangePicker from '../components/DateRangePicker';
import QuickPeriods from '../components/QuickPeriods';
import { getSalesMarkets } from '../api';
import './salesMarkets.css';

const MARKETS = [
  {id:'ozon', name:'Ozon', color:'#3989ee'},
  {id:'wb', name:'WB', color:'#9a65f2'},
];
const METRICS = ['Заказы, шт.','Заказано, ₽','Выкупы, шт.','Выкупы, ₽'];
const PERIODS = [['day','Дни'],['week','Недели'],['month','Месяцы']];
const number = new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const pct = new Intl.NumberFormat('ru-RU',{style:'percent', maximumFractionDigits:1});
const fmt = value => Number.isFinite(value) ? number.format(value) : '—';
const sum = values => values.some(Number.isFinite) ? values.reduce((s,v) => s + (Number.isFinite(v) ? v : 0),0) : null;
const weekStart = date => dayjs(date).subtract((dayjs(date).day()+6)%7,'day');
const labelOf = (date, gran) => gran === 'week' ? weekStart(date).format('DD.MM.YY') : dayjs(date).format(gran === 'month' ? 'MM.YY' : 'DD.MM.YY');
const segment = (scope, setScope, label, choices, extraClass = '') => (
  <div className={`a-seg ${extraClass}`} role="group" aria-label={label}>
    {choices.map(([v,l]) => <button key={v} type="button" className={v===scope?'on':''} aria-pressed={v===scope} onClick={()=>setScope(v)}>{l}</button>)}
  </div>
);

export function SalesScope({ scope, setScope, cabinetLabel }) {
  return segment(scope,setScope,'Кабинеты аналитики', [['cabinet',cabinetLabel],['all','Все кабинеты'],['ozon','Ozon'],['wb','WB']], 'sales-market-scopes');
}

function Hint({active, payload, metric, gran}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return <div className="sales-market-tip">
    <strong>{gran === 'week' ? 'Неделя с ' : ''}{point.label}</strong>
    {MARKETS.filter(m=>point[m.id]!==undefined).map(m=><div key={m.id}><i style={{background:m.color}} />{m.name} <b>{fmt(point[m.id])}{metric%2===1 && Number.isFinite(point[m.id]) ? ' ₽' : ''}</b></div>)}
  </div>;
}

function cabinetTotals(shops, n) {
  return shops.map(s => ({
    ...s,
    totals: METRICS.map((_,i)=>sum((s.daily || []).map(row=>row[i]))),
    partial:METRICS.map((_,i)=>!s.daily || s.daily.filter(row=>Number.isFinite(row[i])).length<n),
  }));
}

export default function SalesMarkets({ scope, search, setSearch, dateFrom, dateTo, setDateRange, gran, setGran, control, active }) {
  const [data,setData] = useState(null);
  const [category,setCategory] = useState('');
  const [metric,setMetric] = useState(2);
  const [open,setOpen] = useState({});
  const [status,setStatus] = useState({loading:true,error:null});
  const [retry,setRetry] = useState(0);
  const marketScope = useRef(scope);
  marketScope.current = scope;
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    setStatus({loading:true,error:null});
    async function refresh(background) {
      try {
        const response = await getSalesMarkets({dateFrom,dateTo,search,category},controller.signal);
        if (!controller.signal.aborted) { setData(response.data.data); setStatus({loading:false,error:null}); }
      } catch (error) {
        if (!background && !controller.signal.aborted) setStatus({loading:false,error:error.response?.data?.error || error.message});
      }
    }
    const timer = setTimeout(() => refresh(false), search ? 240 : 0);
    const update = setInterval(() => {
      const moscowDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' });
      if (marketScope.current !== 'wb' && !document.hidden && dateFrom <= moscowDay && dateTo >= moscowDay) refresh(true);
    }, 15 * 60 * 1000);
    return () => {clearTimeout(timer);clearInterval(update);controller.abort();};
  },[search,dateFrom,dateTo,category,retry,active]);

  const markets = MARKETS.filter(m=>scope==='all'||m.id===scope);
  const { totals, points } = useMemo(()=>{
    if (!data) return {totals:[],points:[]};
    const shops = cabinetTotals(data.shops,data.dates.length);
    const totals = markets.map(m=>{
      const subset=shops.filter(s=>s.platform===m.id);
      return {...m,shops:subset,values:METRICS.map((_,i)=>sum(subset.map(s=>s.totals[i]))),
        partial:METRICS.map((_,i)=>subset.some(s=>s.partial[i]))};
    });
    const buckets = new Map();
    data.dates.forEach((date,di)=>{
      const label = labelOf(date,gran);
      if (!buckets.has(label)) buckets.set(label, Object.fromEntries(markets.map(m=>[m.id,[]])));
      for (const m of totals) buckets.get(label)[m.id].push(sum(m.shops.map(s=>s.daily?.[di]?.[metric])));
    });
    return {totals,points:[...buckets].map(([label,v])=>({label,...Object.fromEntries(markets.map(m=>[m.id,sum(v[m.id])]))}))};
  },[scope,data,gran,metric]);
  const knownTotal = sum(totals.map(m=>m.values[metric]));
  const share = (value,base) => Number.isFinite(value)&&value>=0&&base>0&&value<=base ? pct.format(value/base) : '—';
  const sourceReady = totals.some(m=>m.shops.some(s=>s.daily));
  const partial = totals.some(m=>m.partial.some(Boolean));
  const categories = data?.categories || [];
  const childrenOf = parent => categories.filter(path=>parent ? path.startsWith(parent+' / ') && !path.slice(parent.length+3).includes(' / ') : !path.includes(' / '))
    .map(path=>parent?path.slice(parent.length+3):path);
  const top = childrenOf('');
  const toggle = id => setOpen(value=>({...value,[id]:!value[id]}));

  return <div className="mpui sa-page sales-markets">
    <div className="page-sticky">
      <div className="a-top">
        <h1>Аналитика продаж</h1>
        <ArtSearch value={search} onChange={setSearch} options={data?.options} style={{minWidth:200}} />
        <QuickPeriods from={dateFrom} to={dateTo} onChange={setDateRange} periods={[7,14,30,90]} />
        <DateRangePicker from={dateFrom} to={dateTo} onChange={setDateRange} />
        {control}
      </div>
      {!!top.length && <CategoryNav tops={top} value={category} onChange={setCategory} childrenOf={childrenOf} />}
    </div>
    {status.error && <div className="a-empty" role="alert">{status.error} <button className="a-btn" onClick={()=>setRetry(v=>v+1)}>Повторить</button></div>}
    {status.loading && <div className="a-hint" role="status">Загружаем данные кабинетов…</div>}
    {data && !status.loading && !status.error && !sourceReady && <div className="a-empty" role="status">Данные выбранных кабинетов недоступны. <button className="a-btn" onClick={()=>setRetry(v=>v+1)}>Повторить</button></div>}
    {data && !status.loading && !status.error && sourceReady && ((totals.some(m=>m.shops.some(s=>s.matched)) || (!search.trim() && !category)) ? <>
      <div className="a-kpis sales-market-kpis">
        {METRICS.map((name,i)=><div className="a-kpi" key={name}>
          <span className="lbl">{name}</span><span className="val n">{fmt(sum(totals.map(m=>m.values[i])))}</span>
          <div className="sales-market-mini">
            {totals.map(m=><span key={m.id}><i style={{background:m.color}} />{m.name} <b>{fmt(m.values[i])}</b></span>)}
          </div>
        </div>)}
      </div>
      <div className="a-card s-card">
        <div className="a-bar">
          <b>Динамика продаж</b>
          <select className="a-sel" aria-label="Показатель столбчатого графика" value={metric} onChange={e=>setMetric(Number(e.target.value))}>
            {METRICS.map((name,i)=><option value={i} key={name}>{name}</option>)}
          </select>
          <div className="sales-market-gran">{segment(gran,setGran,'Период столбцов',PERIODS)}</div>
        </div>
        <div className="sales-market-chart">
          <div style={{minWidth:Math.max(290, points.length*17)}}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={points} stackOffset="sign" margin={{top:14,right:15,left:4,bottom:4}}>
                <CartesianGrid vertical={false} stroke="var(--a-line)" />
                <XAxis dataKey="label" tickFormatter={v=>gran==='month'?v:v.slice(0,5)} tick={{fill:'var(--a-ink3)',fontSize:11}} minTickGap={16} />
                <YAxis tickFormatter={fmt} tick={{fill:'var(--a-ink3)',fontSize:11}} width={68}/>
                <Tooltip content={<Hint metric={metric} gran={gran}/>} cursor={{fill:'var(--a-line)',opacity:.35}} />
                {totals.map(m=><Bar key={m.id} dataKey={m.id} name={m.name} stackId="market" fill={m.color} maxBarSize={62} isAnimationActive={false} />)}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="sales-market-mini sales-market-legend">{totals.map(m=><span key={m.id}><i style={{background:m.color}} />{m.name}</span>)}</div>
      </div>
      <div className="a-card">
        <div className="a-bar sales-market-table-head"><b>Доли площадок и кабинетов</b><span className="a-hint">{METRICS[metric]}</span></div>
        <div className="a-scroll">
          <table className="a-t sales-market-table">
            <thead><tr><th>Площадка / кабинет</th>{METRICS.map(m=><th key={m}>{m}</th>)}<th>Доля</th></tr></thead>
            <tbody>
              {totals.map(m=><React.Fragment key={m.id}>
                <tr className="sales-market-total">
                  <td><button className="a-btn ghost sales-market-toggle" type="button" aria-expanded={!!open[m.id]} onClick={()=>toggle(m.id)}><span>{open[m.id]?'▾':'▸'}</span><i style={{background:m.color}} />{m.name}</button></td>
                  {m.values.map((v,i)=><td key={i} className="n">{fmt(v)}</td>)}
                  <td className="n">{share(m.values[metric],knownTotal)}</td>
                </tr>
                {open[m.id] && m.shops.map(s=><tr key={s.id}>
                  <td className="sales-market-shop">{s.label}{!s.daily&&<small className="a-hint"> · данные не загрузились</small>}</td>
                  {s.totals.map((v,i)=><td key={i} className="n">{fmt(v)}</td>)}
                  <td className="n">{share(s.totals[metric],m.values[metric])}</td>
                </tr>)}
              </React.Fragment>)}
            </tbody>
          </table>
        </div>
        <div className="a-hint sales-market-note">Доля кабинета считается внутри площадки. Выкупы учитываются за вычетом возвратов по датам начислений.{partial&&' Итоги и доли рассчитаны по загруженным дням.'}</div>
      </div>
    </> : <div className="a-empty">По этим фильтрам товары не найдены.</div>)}
  </div>;
}
