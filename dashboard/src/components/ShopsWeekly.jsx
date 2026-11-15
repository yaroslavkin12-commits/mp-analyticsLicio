import React,{useMemo,useState,useEffect} from 'react';
import dayjs from 'dayjs';
import {calendarWeeks,rangeTotals,WEEK_METRICS} from '../lib/shopsWeekly';
import {fmtInt,fmtPct} from '../pages/AdsStats2';
export default function ShopsWeekly({shops,daily,from,to,category}){
 const [selected,setSelected]=useState('all');
 const [metrics,setMetrics]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem('mp-shops-week-metrics'));if(Array.isArray(saved)&&saved.length){const valid=saved.filter(k=>WEEK_METRICS.some(m=>m[0]===k));if(valid.length)return valid;}}catch{}return ['ordersRub','ordersQty','revenue','qty','payForecast','payActual'];});
 useEffect(()=>{localStorage.setItem('mp-shops-week-metrics',JSON.stringify(metrics));},[metrics]);
 useEffect(()=>{if(!['all','ozon','wb'].includes(selected)&&!shops.some(s=>s.id===selected))setSelected('all');},[shops,selected]);
 const weeks=useMemo(()=>calendarWeeks(from,to),[from,to]);
 const chosen=shops.filter(s=>selected==='all'||s.id===selected||s.platform===selected);
 const rows=chosen.map(s=>daily[s.id]||null),columns=weeks.map(w=>rangeTotals(rows,w.from,w.to)),total=rangeTotals(rows,from,to);
 const value=(v,type)=>!Number.isFinite(v)?'—':type==='pct'?fmtPct(v):fmtInt(type==='expense'?-v:v)+(type==='money'||type==='expense'?' ₽':'');
 return <div className="a-card ss-weekly" style={{padding:0,marginTop:16}}>
  <div className="a-bar" style={{padding:'12px 14px',gap:12}}><b>Сводка по неделям{category?' · '+category.split(' / ').at(-1):''}</b>
   <select className="a-sel" aria-label="Магазины недельной сводки" value={selected} onChange={e=>setSelected(e.target.value)}><option value="all">Все магазины</option>{['ozon','wb'].filter(p=>shops.some(s=>s.platform===p)).map(p=><option key={p} value={p}>{p==='ozon'?'Ozon':'WB'}</option>)}{shops.map(s=><option key={s.id} value={s.id}>{s.label||s.shop?.label||s.id}</option>)}</select>
   <details className="ss-metrics" style={{marginLeft:'auto'}}><summary className="a-btn">Показатели · {metrics.length}</summary><div className="ss-metric-options">{WEEK_METRICS.map(([key,label])=><button key={key} className={'a-btn '+(metrics.includes(key)?'on':'ghost')} aria-pressed={metrics.includes(key)} onClick={()=>setMetrics(prev=>prev.includes(key)?prev.length>1?prev.filter(k=>k!==key):prev:[...prev,key])}>{label}</button>)}</div></details>
  </div>
  <div className="a-scroll"><table className="a-t ss-week-table no-sh"><thead><tr><th>Показатель</th><th>Итого</th>{weeks.map(w=><th key={w.key}>{dayjs(w.from).format('DD.MM')} — {dayjs(w.to).format('DD.MM')}<small className="ss-sub">{w.partial?'часть недели':'пн — вс'}</small></th>)}</tr></thead><tbody>
  {WEEK_METRICS.filter(m=>metrics.includes(m[0])).map(([key,label,type])=><tr key={key}><th>{label}</th><td className="n ss-week-total">{value(total?.[key],type)}</td>{weeks.map((w,i)=><td className="n" key={w.key}>{value(columns[i]?.[key],type)}</td>)}</tr>)}
  </tbody></table></div>
  <div className="a-hint" style={{padding:'8px 14px 12px'}}>Недели с понедельника по воскресенье. Крайние недели ограничены выбранными датами. Факт — по загруженным выкупам; прогноз — по действующей модели юнит-экономики. Средние считаются из сумм и количества, а не средним процентов.</div>
 </div>;
}
