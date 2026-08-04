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

  const wb = data?.wb || {}, oz = data?.ozon || {};

  const DrrBar = ({ drr, label, color }) => {
    const v = Math.min(Number(drr||0), 100);
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
          <span style={{ color: 'var(--text2)' }}>{label}</span>
          <span style={{ fontWeight: 700, color: v > 20 ? 'var(--danger)' : 'var(--ok)' }}>{v.toFixed(1)}%</span>
        </div>
        <div style={{ height: 8, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${v}%`, background: v > 20 ? 'var(--danger)' : color, borderRadius: 4, transition: 'width .5s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3, fontSize: 11, color: 'var(--text3)' }}>
          <span>0%</span><span>20% (норма)</span><span>40%+</span>
        </div>
      </div>
    );
  };

  const Section = ({ p, d, color, label }) => d.drr == null ? null : (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10 }}>
        <MetricCard label="Расход" value={Math.round(d.adSpend||0)} suffix=" ₽" color={color} />
        <MetricCard label="Показы" value={Number(d.adViews||0)} color={color} />
        <MetricCard label="Клики" value={Number(d.adClicks||0)} color={color} />
        <MetricCard label="Заказов с рекламы" value={Number(d.adOrders||0)} color={color} />
        <MetricCard label="CTR" value={d.adViews > 0 ? (d.adClicks/d.adViews*100).toFixed(2) : 0} suffix="%" color={color} />
        <MetricCard label="ДРР" value={Number(d.drr||0)} suffix="%" color={Number(d.drr) > 20 ? 'var(--danger)' : 'var(--ok)'} sub={Number(d.drr) > 20 ? '⚠️ Выше нормы' : '✅ В норме'} />
      </div>
    </div>
  );

  if (loading) return <div style={{ padding: 60, textAlign: 'center', color: 'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={{ fontSize: 17, fontWeight: 700 }}>Реклама</h1>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
        <div style={{ fontWeight: 600, marginBottom: 16 }}>ДРР — доля рекламных расходов в выручке</div>
        {(platform==='all'||platform==='wb') && <DrrBar drr={wb.drr} label="Wildberries" color="var(--accent-wb)" />}
        {(platform==='all'||platform==='ozon') && <DrrBar drr={oz.drr} label="Ozon" color="var(--accent-oz)" />}
      </div>
      {(platform==='all'||platform==='wb') && <Section d={wb} color="var(--accent-wb)" label="Wildberries" />}
      {(platform==='all'||platform==='ozon') && <Section d={oz} color="var(--accent-oz)" label="Ozon" />}
    </div>
  );
}
