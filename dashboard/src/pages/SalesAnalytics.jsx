import React, { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { getOzonAnalytics, getOzonFunnel } from '../api';
import dayjs from 'dayjs';

const fmt  = n => Number(n||0).toLocaleString('ru-RU');
const fmtR = n => fmt(Math.round(n||0)) + ' ₽';
const fmtP = (n, d=1) => Number(n||0).toFixed(d) + '%';

const PERIODS = [
  { label:'Сегодня',       from:() => dayjs().format('YYYY-MM-DD'),                                to:() => dayjs().format('YYYY-MM-DD') },
  { label:'Вчера',         from:() => dayjs().subtract(1,'day').format('YYYY-MM-DD'),              to:() => dayjs().subtract(1,'day').format('YYYY-MM-DD') },
  { label:'7 дней',        from:() => dayjs().subtract(6,'day').format('YYYY-MM-DD'),              to:() => dayjs().format('YYYY-MM-DD') },
  { label:'30 дней',       from:() => dayjs().subtract(29,'day').format('YYYY-MM-DD'),             to:() => dayjs().format('YYYY-MM-DD') },
  { label:'Этот месяц',    from:() => dayjs().startOf('month').format('YYYY-MM-DD'),               to:() => dayjs().format('YYYY-MM-DD') },
  { label:'Прошлый месяц', from:() => dayjs().subtract(1,'month').startOf('month').format('YYYY-MM-DD'), to:() => dayjs().subtract(1,'month').endOf('month').format('YYYY-MM-DD') },
];

const CHART_METRICS = [
  { key:'revenue',         label:'Выручка ₽',       color:'#9061f9', fmt: fmtR },
  { key:'orders_item',     label:'Заказы шт',       color:'#005bff', fmt: fmt  },
  { key:'hits_view',       label:'Показы',          color:'#f59e0b', fmt: fmt  },
  { key:'hits_view_pdp',   label:'Клики (карточка)',color:'#10b981', fmt: fmt  },
  { key:'hits_tocart',     label:'Корзина',         color:'#f97316', fmt: fmt  },
  { key:'delivered_units', label:'Доставлено',      color:'#06b6d4', fmt: fmt  },
  { key:'ctr_pct',         label:'CTR %',           color:'#ec4899', fmt: v => fmtP(v,2) },
  { key:'cr_order_pct',    label:'CR в заказ %',    color:'#8b5cf6', fmt: v => fmtP(v,2) },
  { key:'redemption_pct',  label:'% выкупа',        color:'#14b8a6', fmt: v => fmtP(v,1) },
];

function Funnel({ data }) {
  const steps = [
    { label:'Показы',    value:data.impressions, conv:null },
    { label:'Карточка',  value:data.card_views,  conv:data.imp_to_card },
    { label:'Корзина',   value:data.cart_adds,   conv:data.card_to_cart },
    { label:'Заказы',    value:data.orders,      conv:data.cart_to_order },
    { label:'Доставлено',value:data.delivered,   conv:data.order_to_delivered },
  ];
  const colors = ['#9061f9','#005bff','#f59e0b','#10b981','#06b6d4'];
  return (
    <div style={{ display:'flex', background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
      {steps.map((s,i) => (
        <div key={i} style={{ flex:1, padding:'14px 10px', borderRight:i<steps.length-1?'1px solid var(--border)':'none', textAlign:'center' }}>
          <div style={{ fontSize:11, color:'var(--text2)', marginBottom:4, fontWeight:500 }}>{s.label}</div>
          <div style={{ fontSize:18, fontWeight:700, color:colors[i] }}>{fmt(s.value)}</div>
          {s.conv != null && <div style={{ fontSize:11, marginTop:4, color:'var(--text3)' }}>↓ <span style={{ color:Number(s.conv)>5?'var(--ok)':'var(--text2)', fontWeight:600 }}>{fmtP(s.conv,1)}</span></div>}
        </div>
      ))}
      <div style={{ flex:1, padding:'14px 10px', textAlign:'center', background:'rgba(16,185,129,0.06)' }}>
        <div style={{ fontSize:11, color:'var(--text2)', marginBottom:4, fontWeight:500 }}>CR итог</div>
        <div style={{ fontSize:18, fontWeight:700, color:'var(--ok)' }}>{fmtP(data.overall_cr,2)}</div>
        <div style={{ fontSize:11, marginTop:4, color:'var(--text3)' }}>показ→заказ</div>
      </div>
    </div>
  );
}

function ProductRow({ p, expanded, onToggle }) {
  const drr        = Number(p.drr||0);
  const redemption = Number(p.redemption_pct||0);
  const margin     = p.cost_price>0 && p.revenue>0
    ? ((p.revenue - p.cost_price*p.orders_item - p.ad_spend)/p.revenue*100) : null;
  const isWeak = drr>30 || (margin!==null && margin<0) || redemption<40;
  const Td = ({ children, style }) => <td style={{ padding:'8px 10px', borderBottom:'1px solid var(--border)', fontSize:12, ...style }}>{children}</td>;
  return (
    <>
      <tr style={{ background:isWeak?'rgba(239,68,68,0.04)':'transparent', cursor:'pointer' }} onClick={onToggle}>
        <Td><span style={{ marginRight:6, color:'var(--text3)', fontSize:10 }}>{expanded?'▼':'▶'}</span><span style={{ color:'var(--accent-oz)', fontWeight:600, fontSize:11 }}>{p.offer_id||p.sku}</span></Td>
        <Td style={{ maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text2)' }} title={p.product_name}>{p.product_name||'—'}</Td>
        <Td style={{ fontWeight:600 }}>{fmtR(p.revenue)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmt(p.orders_item)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmt(p.hits_view)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmt(p.hits_view_pdp)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmt(p.hits_tocart)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmtP(p.ctr_pct,2)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmtP(p.cr_cart_pct,2)}</Td>
        <Td style={{ color:'var(--text2)' }}>{fmtP(p.cr_order_pct,2)}</Td>
        <Td>{fmt(p.delivered_units)}</Td>
        <Td style={{ color:redemption<40?'var(--danger)':redemption<60?'var(--warn)':'var(--ok)', fontWeight:600 }}>{fmtP(p.redemption_pct,1)}</Td>
        <Td style={{ color:drr>30?'var(--danger)':drr>15?'var(--warn)':'var(--ok)', fontWeight:600 }}>{drr>0?fmtP(drr,1):'—'}</Td>
        <Td>{margin!==null?<span style={{ color:margin<0?'var(--danger)':margin<10?'var(--warn)':'var(--ok)', fontWeight:600 }}>{fmtP(margin,1)}</span>:<span style={{ color:'var(--text3)' }}>—</span>}</Td>
      </tr>
      {expanded && (
        <tr style={{ background:'var(--surface2)' }}>
          <td colSpan={14} style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)' }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))', gap:8 }}>
              {[['Ср. цена',fmtR(p.avg_price)],['Себестоимость',p.cost_price>0?fmtR(p.cost_price):'не задана'],['Расход реклама',p.ad_spend>0?fmtR(p.ad_spend):'—'],['Возвраты',fmt(p.returns)+' шт'],['Отмены',fmt(p.cancellations)+' шт'],['Остаток',fmt(p.stock_qty)+' шт'],['Корзина→Заказ',fmtP(p.cr_cart_to_order_pct,1)]].map(([label,val]) => (
                <div key={label} style={{ background:'var(--surface)', borderRadius:7, padding:'8px 12px', border:'1px solid var(--border)' }}>
                  <div style={{ fontSize:10, color:'var(--text3)', marginBottom:2 }}>{label}</div>
                  <div style={{ fontSize:13, fontWeight:600 }}>{val}</div>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function SalesAnalytics({ platform }) {
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(29,'day').format('YYYY-MM-DD'));
  const [dateTo,   setDateTo]   = useState(dayjs().format('YYYY-MM-DD'));
  const [activePeriod, setActivePeriod] = useState('30 дней');
  const [tableData, setTableData] = useState([]);
  const [chartData, setChartData] = useState([]);
  const [funnel,    setFunnel]    = useState({});
  const [totals,    setTotals]    = useState({});
  const [loading,   setLoading]   = useState(true);
  const [selectedMetrics, setSelectedMetrics] = useState(['revenue','orders_item','hits_view']);
  const [expandedRows, setExpandedRows] = useState({});
  const [search,   setSearch]   = useState('');
  const [sortKey,  setSortKey]  = useState('revenue');
  const [sortDir,  setSortDir]  = useState('desc');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      getOzonAnalytics({ dateFrom, dateTo, groupBy:'sku' }),
      getOzonAnalytics({ dateFrom, dateTo, groupBy:'day' }),
      getOzonFunnel({ dateFrom, dateTo }),
    ]).then(([table, chart, funnelRes]) => {
      setTableData(table.data.data||[]);
      setTotals(table.data.totals||{});
      setChartData((chart.data.data||[]).map(r => ({
        ...r, date:dayjs(r.date).format('DD.MM'),
        revenue:Number(r.revenue||0), orders_item:Number(r.orders_item||0),
        hits_view:Number(r.hits_view||0), hits_view_pdp:Number(r.hits_view_pdp||0),
        hits_tocart:Number(r.hits_tocart||0), delivered_units:Number(r.delivered_units||0),
        ctr_pct:Number(r.ctr_pct||0), cr_order_pct:Number(r.cr_order_pct||0), redemption_pct:Number(r.redemption_pct||0),
      })));
      setFunnel(funnelRes.data.data||{});
    }).catch(console.error).finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  function setPeriod(p) { setActivePeriod(p.label); setDateFrom(p.from()); setDateTo(p.to()); }
  function toggleMetric(key) { setSelectedMetrics(prev => prev.includes(key)?prev.filter(k=>k!==key):[...prev,key]); }
  function toggleRow(sku) { setExpandedRows(prev => ({...prev,[sku]:!prev[sku]})); }
  function handleSort(key) { if (sortKey===key) setSortDir(d=>d==='asc'?'desc':'asc'); else { setSortKey(key); setSortDir('desc'); } }

  const filtered = tableData
    .filter(p => { if (!search) return true; const s=search.toLowerCase(); return (p.offer_id||'').toLowerCase().includes(s)||(p.product_name||'').toLowerCase().includes(s); })
    .sort((a,b) => { const va=Number(a[sortKey]||0),vb=Number(b[sortKey]||0); return sortDir==='asc'?va-vb:vb-va; });

  const TH = ({ label, sKey, sortable }) => (
    <th onClick={sortable?()=>handleSort(sKey||label):undefined} style={{ padding:'8px 10px', textAlign:'left', color:'var(--text2)', fontWeight:500, fontSize:11, borderBottom:'1px solid var(--border)', whiteSpace:'nowrap', cursor:sortable?'pointer':'default', userSelect:'none' }}>
      {label}{sortable&&sortKey===(sKey||label)?(sortDir==='asc'?' ↑':' ↓'):''}
    </th>
  );

  if (platform!=='ozon'&&platform!=='all') return (
    <div style={{ padding:48, textAlign:'center', color:'var(--text2)' }}>
      <div style={{ fontSize:32, marginBottom:12 }}>📊</div>
      Переключи на «Ozon» или «Все» вверху.
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      {/* Периоды */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <h1 style={{ fontSize:17, fontWeight:700, marginRight:4 }}>Аналитика продаж · Ozon</h1>
        <div style={{ display:'flex', gap:3, marginLeft:'auto', flexWrap:'wrap', alignItems:'center' }}>
          {PERIODS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)} style={{ padding:'4px 10px', border:'1px solid var(--border)', borderRadius:6, fontSize:12, fontWeight:500, transition:'all .12s', background:activePeriod===p.label?'var(--accent-oz)':'var(--surface2)', color:activePeriod===p.label?'#fff':'var(--text2)' }}>{p.label}</button>
          ))}
          <input type="date" value={dateFrom} onChange={e=>{setDateFrom(e.target.value);setActivePeriod('');}} style={{ width:130, fontSize:12 }}/>
          <span style={{ color:'var(--text3)' }}>—</span>
          <input type="date" value={dateTo} onChange={e=>{setDateTo(e.target.value);setActivePeriod('');}} style={{ width:130, fontSize:12 }}/>
        </div>
      </div>

      {loading ? <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div> : tableData.length===0 ? (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:48, textAlign:'center', color:'var(--text2)' }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📭</div>
          <div style={{ fontWeight:600, marginBottom:6 }}>Нет данных за этот период</div>
          <div style={{ fontSize:12, color:'var(--text3)' }}>Настройки → Обновить Ozon</div>
        </div>
      ) : (
        <>
          <Funnel data={funnel}/>

          {/* Итоги */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(140px, 1fr))', gap:10 }}>
            {[['Выручка',fmtR(totals.revenue),'var(--accent-oz)'],['Заказов шт',fmt(totals.orders_item),'var(--accent-oz)'],['Доставлено',fmt(totals.delivered_units),'var(--ok)'],['% выкупа',fmtP(totals.redemption_pct,1),Number(totals.redemption_pct)>60?'var(--ok)':'var(--warn)'],['CTR',fmtP(totals.ctr_pct,2),'var(--text)'],['CR в заказ',fmtP(totals.cr_order_pct,2),'var(--text)']].map(([label,val,color]) => (
              <div key={label} style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
                <div style={{ fontSize:10, color:'var(--text2)', marginBottom:5, textTransform:'uppercase', letterSpacing:.5 }}>{label}</div>
                <div style={{ fontSize:20, fontWeight:700, color }}>{val}</div>
              </div>
            ))}
          </div>

          {/* График */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:16 }}>
            <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
              {CHART_METRICS.map(m => (
                <button key={m.key} onClick={() => toggleMetric(m.key)} style={{ padding:'3px 10px', border:`1px solid ${selectedMetrics.includes(m.key)?m.color:'var(--border)'}`, borderRadius:20, fontSize:11, fontWeight:500, background:selectedMetrics.includes(m.key)?m.color+'22':'transparent', color:selectedMetrics.includes(m.key)?m.color:'var(--text2)' }}>{m.label}</button>
              ))}
            </div>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
                <XAxis dataKey="date" tick={{ fill:'var(--text2)', fontSize:10 }}/>
                <YAxis tick={{ fill:'var(--text2)', fontSize:10 }} tickFormatter={v => v>=1000?(v/1000).toFixed(0)+'k':v}/>
                <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8, fontSize:12 }} formatter={(v,name) => { const m=CHART_METRICS.find(x=>x.key===name); return [m?m.fmt(v):v, m?.label||name]; }}/>
                <Legend wrapperStyle={{ fontSize:11 }} formatter={name => CHART_METRICS.find(x=>x.key===name)?.label||name}/>
                {CHART_METRICS.filter(m=>selectedMetrics.includes(m.key)).map(m => (
                  <Line key={m.key} dataKey={m.key} stroke={m.color} strokeWidth={2} dot={false}/>
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Таблица */}
          <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            <div style={{ padding:'12px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontWeight:600, fontSize:13 }}>По товарам · {filtered.length} арт.</span>
              <input placeholder="Поиск по артикулу или названию..." value={search} onChange={e=>setSearch(e.target.value)} style={{ marginLeft:'auto', width:260, fontSize:12 }}/>
            </div>
            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <TH label="Артикул" sortable sKey="offer_id"/>
                    <TH label="Название"/>
                    <TH label="Выручка ₽" sortable sKey="revenue"/>
                    <TH label="Заказы шт" sortable sKey="orders_item"/>
                    <TH label="Показы" sortable sKey="hits_view"/>
                    <TH label="Карточка" sortable sKey="hits_view_pdp"/>
                    <TH label="Корзина" sortable sKey="hits_tocart"/>
                    <TH label="CTR" sortable sKey="ctr_pct"/>
                    <TH label="CR корзина" sortable sKey="cr_cart_pct"/>
                    <TH label="CR заказ" sortable sKey="cr_order_pct"/>
                    <TH label="Доставлено" sortable sKey="delivered_units"/>
                    <TH label="% выкупа" sortable sKey="redemption_pct"/>
                    <TH label="ДРР" sortable sKey="drr"/>
                    <TH label="Маржа"/>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => <ProductRow key={p.sku} p={p} expanded={!!expandedRows[p.sku]} onToggle={()=>toggleRow(p.sku)}/>)}
                  {filtered.length===0 && <tr><td colSpan={14} style={{ padding:32, textAlign:'center', color:'var(--text2)' }}>Ничего не найдено</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
