import React, { useState, useEffect } from 'react';
import MetricCard from '../components/MetricCard';
import { getOverview } from '../api';

export default function Ads({ platform, dateFrom, dateTo }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getOverview({ platform, dateFrom, dateTo }).then(r => setData(r.data.data)).catch(console.error).finally(() => setLoading(false));
  }, [platform, dateFrom, dateTo]);

  const wb = data?.wb||{}, oz = data?.ozon||{};

  const DrrBar = ({ drr, label, color }) => {
    const v = Math.min(Number(drr||0), 100);
    return (
      <div style={{ marginBottom:16 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
          <span style={{ color:'var(--text2)' }}>{label}</span>
          <span style={{ fontWeight:700, color:v>20?'var(--danger)':'var(--ok)' }}>{v.toFixed(1)}%</span>
        </div>
        <div style={{ height:8, background:'var(--surface2)', borderRadius:4, overflow:'hidden' }}>
          <div style={{ height:'100%', width:`${v}%`, background:v>20?'var(--danger)':color, borderRadius:4, transition:'width .5s' }}/>
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', marginTop:3, fontSize:11, color:'var(--text3)' }}>
          <span>0%</span><span>20% (норма)</span><span>40%+</span>
        </div>
      </div>
    );
  };

  if (loading) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <h1 style={{ fontSize:17, fontWeight:700 }}>Реклама</h1>
      <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:20 }}>
        <div style={{ fontWeight:600, marginBottom:16 }}>ДРР — доля рекламных расходов в выручке</div>
        {(platform==='all'||platform==='wb') && <DrrBar drr={wb.drr} label="Wildberries" color="var(--accent-wb)"/>}
        {(platform==='all'||platform==='ozon') && <DrrBar drr={oz.drr} label="Ozon" color="var(--accent-oz)"/>}
      </div>
      {(platform==='all'||platform==='wb') && (
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--accent-wb)', textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Wildberries</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:10 }}>
            <MetricCard label="Расход" value={Math.round(wb.adSpend||0)} suffix=" ₽" color="var(--accent-wb)"/>
            <MetricCard label="Показы" value={Number(wb.adViews||0)} color="var(--accent-wb)"/>
            <MetricCard label="Клики" value={Number(wb.adClicks||0)} color="var(--accent-wb)"/>
            <MetricCard label="Заказов с рекламы" value={Number(wb.adOrders||0)} color="var(--accent-wb)"/>
            <MetricCard label="CTR" value={wb.adViews>0?(wb.adClicks/wb.adViews*100).toFixed(2):0} suffix="%" color="var(--accent-wb)"/>
            <MetricCard label="ДРР" value={Number(wb.drr||0)} suffix="%" color={Number(wb.drr)>20?'var(--danger)':'var(--ok)'} sub={Number(wb.drr)>20?'⚠️ Выше нормы':'✅ В норме'}/>
          </div>
        </div>
      )}
      {(platform==='all'||platform==='ozon') && (
        <div>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--accent-oz)', textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>Ozon</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:10 }}>
            <MetricCard label="Расход" value={Math.round(oz.adSpend||0)} suffix=" ₽" color="var(--accent-oz)"/>
            <MetricCard label="Показы" value={Number(oz.adViews||0)} color="var(--accent-oz)"/>
            <MetricCard label="Клики" value={Number(oz.adClicks||0)} color="var(--accent-oz)"/>
            <MetricCard label="Заказов с рекламы" value={Number(oz.adOrders||0)} color="var(--accent-oz)"/>
            <MetricCard label="CTR" value={oz.adViews>0?(oz.adClicks/oz.adViews*100).toFixed(2):0} suffix="%" color="var(--accent-oz)"/>
            <MetricCard label="ДРР" value={Number(oz.drr||0)} suffix="%" color={Number(oz.drr)>20?'var(--danger)':'var(--ok)'} sub={Number(oz.drr)>20?'⚠️ Выше нормы':'✅ В норме'}/>
          </div>
        </div>
      )}
    </div>
  );
}
