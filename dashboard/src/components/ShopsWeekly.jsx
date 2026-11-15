import React,{useMemo,useState,useEffect,useRef,useLayoutEffect} from 'react';
import dayjs from 'dayjs';
import {combineTotals,WEEK_METRICS,historyMetricGroup,historyChange} from '../lib/shopsWeekly';
import {getShopsHistory} from '../api';
import {accessMode} from '../lib/accessClient';
import {fmtInt,fmtPct} from '../pages/AdsStats2';
export default function ShopsWeekly({shops,category,active=true,ready=true,taxVersion=0}){
 const [selected,setSelected]=useState('all'),[mode,setMode]=useState('weeks'),[data,setData]=useState({}),[loading,setLoading]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0);
 const [metrics,setMetrics]=useState(()=>{try{const saved=JSON.parse(localStorage.getItem('mp-shops-week-metrics'));if(Array.isArray(saved)&&saved.length){const valid=saved.filter(k=>WEEK_METRICS.some(m=>m[0]===k));if(valid.length)return valid;}}catch{}return ['ordersRub','ordersQty','revenue','qty','payForecast','payActual'];});
 const scroll=useRef(),epoch=useRef(0),busy=useRef(false),position=useRef(null),lastLoaded=useRef({at:0,tick:0}),enabled=useRef(false),scope=accessMode().cacheTag||'';
 enabled.current=active&&ready;
 const shopIds=shops.map(s=>s.id).join(','),chosen=shops.filter(s=>selected==='all'||s.id===selected||s.platform===selected),ids=chosen.map(s=>s.id).join(',');
 useEffect(()=>{localStorage.setItem('mp-shops-week-metrics',JSON.stringify(metrics));},[metrics]);
 useEffect(()=>{if(!['all','ozon','wb'].includes(selected)&&!shops.some(s=>s.id===selected))setSelected('all');},[shopIds,selected]);
 // Календарь верхней таблицы намеренно не передаётся сюда. Смена вкладки
 // браузера также не сбрасывает загруженные значения.
 useEffect(()=>{if(!active)return;const timer=setInterval(()=>setRefresh(v=>v+1),300000);return()=>clearInterval(timer);},[active]);
 const loadRef=useRef();
 useEffect(()=>{
  const token=++epoch.current;busy.current=false;lastLoaded.current={at:0,tick:refresh};setData({});setError('');position.current={current:true};
  const load=async(older=false,tick=refresh)=>{
   if(busy.current||!enabled.current||token!==epoch.current)return;busy.current=true;setLoading(true);setError('');
   if(older&&scroll.current)position.current={width:scroll.current.scrollWidth,left:scroll.current.scrollLeft};
   try{for(const id of ids.split(',').filter(Boolean)){
    if(!enabled.current)return;
    const end=older?loadRef.current?.cursors?.[id]:undefined;
    if(older&&!end)continue;
    const result=(await getShopsHistory(id,{mode,category,end})).data.data;
    if(token!==epoch.current)return;
    if(older||!(id in loadRef.current.cursors))loadRef.current.cursors[id]=result.olderThan;
    setData(prev=>{const latest=new Set(result.periods.map(p=>p.key));return {...prev,[id]:{...result,olderThan:loadRef.current.cursors[id],periods:older?[...result.periods,...(prev[id]?.periods||[])]:[...(prev[id]?.periods||[]).filter(p=>!latest.has(p.key)),...result.periods]}};});
   }if(!older)lastLoaded.current={at:Date.now(),tick};}catch(e){if(token===epoch.current)setError(e.response?.data?.error||'Не удалось загрузить историю. Повторите загрузку.');}
   finally{if(token===epoch.current){busy.current=false;setLoading(false);}}
  };
  loadRef.current={load,cursors:{}};
  return()=>{epoch.current++;};
 },[ids,mode,category,scope,taxVersion]); // eslint-disable-line react-hooks/exhaustive-deps
 useEffect(()=>{
  if(!active||!ready||error)return;
  // Возврат на вкладку и смена верхнего календаря не запускают повторную
  // загрузку истории. Первый запрос ждёт завершения основной сводки.
  const last=lastLoaded.current;
  if(last.at&&last.tick===refresh&&Date.now()-last.at<300000)return;
  loadRef.current?.load(false,refresh);
 },[active,ready,refresh,ids,mode,category,scope,taxVersion,loading,error]);
 const periods=useMemo(()=>[...new Map(Object.values(data).flatMap(d=>d.periods).map(p=>[p.key,p])).values()].sort((a,b)=>a.start.localeCompare(b.start)),[data]);
 useLayoutEffect(()=>{const el=scroll.current,p=position.current;if(!el||!p)return;if(p.current)el.scrollLeft=el.scrollWidth;else el.scrollLeft=p.left+el.scrollWidth-p.width;if(!loading)position.current=null;},[periods,loading]);
 const older=Object.values(data).some(d=>d.olderThan);
 const maps=useMemo(()=>Object.fromEntries(Object.entries(data).map(([id,d])=>[id,new Map(d.periods.map(p=>[p.key,p]))])),[data]);
 const value=(v,type)=>!Number.isFinite(v)?'—':type==='pct'?fmtPct(v):fmtInt(type==='expense'?-v:v)+(type==='money'||type==='expense'?' ₽':'');
 const cell=(period,key,type)=>{
  const columns=chosen.map(s=>maps[s.id]?.get(period.key)),total=columns.every(Boolean)?combineTotals(columns.map(p=>p.totals||{})):null,group=historyMetricGroup(key);
  const compares=columns.map(p=>p?.comparisons[group]),known=compares.every(c=>c?.current&&c?.previous);
  const a=known?combineTotals(compares.map(c=>c.current))?.[key]:null,b=known?combineTotals(compares.map(c=>c.previous))?.[key]:null;
  const change=historyChange(type==='expense'&&Number.isFinite(a)?-a:a,type==='expense'&&Number.isFinite(b)?-b:b,type);
  const dates=[...new Set(compares.filter(c=>c?.range).map(c=>{const r=c.range;return `${dayjs(r.from).format('DD.MM.YYYY')} — ${dayjs(r.to).format('DD.MM.YYYY')} / ${dayjs(r.previousFrom).format('DD.MM.YYYY')} — ${dayjs(r.previousTo).format('DD.MM.YYYY')}`;}))];
  const partial=compares.some(c=>c?.partial),tone=change?.tone;
  return <td key={period.key} className={'n ss-history-cell '+(tone?'ss-history-'+tone:'')} title={(dates.length?'Сравнение: '+dates.join('; '):'Нет сопоставимых данных предыдущего периода')+(partial?' · Доступная часть периода':'')}>
   <span>{value(total?.[key],type)}</span><small className="ss-history-change">{change?(change.fromZero?'с 0':(change.percent>0?'+':'')+change.percent.toLocaleString('ru-RU',{maximumFractionDigits:1})+'%'):'—'}{partial?' · часть':''}</small>
  </td>;
 };
 return <div className="a-card ss-weekly ss-history" style={{padding:0,marginTop:16}}>
  <div className="a-bar" style={{padding:'12px 14px',gap:12}}><b>История магазинов{category?' · '+category.split(' / ').at(-1):''}</b>
   <div className="a-seg"><button className={mode==='weeks'?'on':''} onClick={()=>setMode('weeks')}>Недели</button><button className={mode==='months'?'on':''} onClick={()=>setMode('months')}>Месяцы</button></div>
   <select className="a-sel" aria-label="Магазины истории" value={selected} onChange={e=>setSelected(e.target.value)}><option value="all">Все магазины</option>{['ozon','wb'].filter(p=>shops.some(s=>s.platform===p)).map(p=><option key={p} value={p}>{p==='ozon'?'Ozon':'WB'}</option>)}{shops.map(s=><option key={s.id} value={s.id}>{s.label||s.shop?.label||s.id}</option>)}</select>
   <details className="ss-metrics" style={{marginLeft:'auto'}}><summary className="a-btn">Показатели · {metrics.length}</summary><div className="ss-metric-options">{WEEK_METRICS.map(([key,label])=><button key={key} className={'a-btn '+(metrics.includes(key)?'on':'ghost')} aria-pressed={metrics.includes(key)} onClick={()=>setMetrics(prev=>prev.includes(key)?prev.length>1?prev.filter(k=>k!==key):prev:[...prev,key])}>{label}</button>)}</div></details>
  </div>
  <div className="ss-history-nav"><button className="a-btn ghost" disabled={loading} onClick={()=>{if(scroll.current?.scrollLeft>30)scroll.current.scrollBy({left:-500,behavior:'smooth'});else if(older)loadRef.current?.load(true);}}>← Раньше</button><span className="a-hint">{!ready?'Загрузка сводки…':loading?'Загрузка истории…':'Календарь сверху влияет только на верхнюю таблицу'}</span><button className="a-btn ghost" aria-label="Прокрутить историю вправо" onClick={()=>scroll.current?.scrollBy({left:500,behavior:'smooth'})}>→</button><button className="a-btn ghost" onClick={()=>{if(scroll.current)scroll.current.scrollLeft=scroll.current.scrollWidth;}}>К текущему периоду</button></div>
  {error&&<div role="alert" style={{padding:12}}>{error} <button className="a-btn" onClick={()=>loadRef.current?.load(false)}>Повторить</button></div>}
  <div className="a-scroll" ref={scroll} onScroll={e=>{if(e.currentTarget.scrollLeft<30&&older&&!loading)loadRef.current?.load(true);}}><table className="a-t ss-week-table no-sh"><thead><tr><th>Показатель</th>{periods.map(p=><th key={p.key} className={p.current?'ss-history-current':''}>{mode==='months'?dayjs(p.start).format('MM.YYYY'):dayjs(p.start).format('DD.MM')+' — '+dayjs(p.end).format('DD.MM')}<small className="ss-sub">{p.current?'неполный · по '+dayjs(p.comparisons.orders?.through||p.comparisons.finance?.through||p.start).format('DD.MM'):mode==='months'?dayjs(p.start).format('DD.MM')+' — '+dayjs(p.end).format('DD.MM'):'пн — вс'}</small></th>)}</tr></thead><tbody>
  {WEEK_METRICS.filter(m=>metrics.includes(m[0])).map(([key,label,type])=><tr key={key}><th>{label}</th>{periods.map(p=>cell(p,key,type))}</tr>)}
  </tbody></table></div>
  {ready&&!loading&&!periods.length&&!error&&<div className="a-hint" style={{padding:14}}>История пока не загружена.</div>}
 </div>;
}
