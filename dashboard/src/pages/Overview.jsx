import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import MetricCard from '../components/MetricCard';
import { getOverview, getChart } from '../api';
import dayjs from 'dayjs';

const fmtRub = n => Math.round(Number(n||0)).toLocaleString('ru') + ' ₽';

export default function Overview({ platform, dateFrom, dateTo }) {
  const [data, setData] = useState(null);
  const [chart, setChart] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      getOverview({ platform, dateFrom, dateTo }),
      getChart({ platform, dateFrom, dateTo }),
    ]).then(([ov, ch]) => {
      setData(ov.data.data);
      const wbMap = {}, ozMap = {};
      (ch.data.data.wb||[]).forEach(r => wbMap[r.date] = { wb: Number(r.revenue||0) });
      (ch.data.data.ozon||[]).forEach(r => ozMap[r.date] = { oz: Number(r.revenue||0) });
      const dates = [...new Set([...Object.keys(wbMap), ...Object.keys(ozMap)])].sort();
      setChart(dates.map(d => ({
        date: dayjs(d).format('DD.MM'),
        ...(wbMap[d]||{}), ...(ozMap[d]||{}),
        total: (wbMap[d]?.wb||0) + (ozMap[d]?.oz||0),
      })));
    }).catch(console.error).finally(() => setLoading(false));
  }, [platform, dateFrom, dateTo]);

  const wb = data?.wb || {}, oz = data?.ozon || {};
  const G = ({ children }) => <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(170px, 1fr))', gap:10 }}>{children}</div>;
  const Section = ({ label, color }) => <div style={{ fontSize:11, fontWeight:700, color, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>{label}</div>;

  if (loading) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <h1 style={{ fontSize:17, fontWeight:700 }}>Обзор продаж</h1>
      {(platform==='all'||platform==='wb') && (
        <div>
          <Section label="Wildberries" color="var(--accent-wb)"/>
          <G>
            <MetricCard label="Выручка" value={Math.round(wb.revenue||0)} suffix=" ₽" color="var(--accent-wb)"/>
            <MetricCard label="К выплате" value={Math.round(wb.payout||0)} suffix=" ₽" color="var(--accent-wb)"/>
            <MetricCard label="Заказы" value={wb.orders||0} color="var(--accent-wb)"/>
            <MetricCard label="Продажи (выкуп)" value={wb.sales||0} color="var(--accent-wb)"/>
            <MetricCard label="% выкупа" value={Number(wb.redemptionRate||0)} suffix="%" color="var(--accent-wb)"/>
            <MetricCard label="Расход реклама" value={Math.round(wb.adSpend||0)} suffix=" ₽" color="var(--accent-wb)"/>
            <MetricCard label="ДРР" value={Number(wb.drr||0)} suffix="%" color={Number(wb.drr)>20?'var(--danger)':'var(--ok)'} sub={Number(wb.drr)>20?'⚠️ Выше нормы':'✅ В норме'}/>
          </G>
        </div>
      )}
      {(platform==='all'||platform==='ozon') && (
        <div>
          <Section label="Ozon" color="var(--accent-oz)"/>
          <G>
            <MetricCard label="Выручка" value={Math.round(oz.revenue||0)} suffix=" ₽" color="var(--accent-oz)"/>
            <MetricCard label="К выплате" value={Math.round(oz.payout||0)} suffix=" ₽" color="var(--accent-oz)"/>
            <MetricCard label="Заказы" value={oz.sales||0} color="var(--accent-oz)"/>
            <MetricCard label="Единиц товара" value={oz.units||0} color="var(--accent-oz)"/>
            <MetricCard label="Расход реклама" value={Math.round(oz.adSpend||0)} suffix=" ₽" color="var(--accent-oz)"/>
            <MetricCard label="ДРР" value={Number(oz.drr||0)} suffix="%" color={Number(oz.drr)>20?'var(--danger)':'var(--ok)'} sub={Number(oz.drr)>20?'⚠️ Выше нормы':'✅ В норме'}/>
          </G>
        </div>
      )}
      {chart.length > 0 ? (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:20 }}>
          <div style={{ fontWeight:600, marginBottom:14 }}>Динамика выручки</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{ fill:'var(--text2)', fontSize:11 }}/>
              <YAxis tick={{ fill:'var(--text2)', fontSize:11 }} tickFormatter={v => (v/1000).toFixed(0)+'k'}/>
              <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8 }} formatter={(v,n) => [fmtRub(v),n]}/>
              <Legend wrapperStyle={{ fontSize:12 }}/>
              {(platform==='all'||platform==='wb') && <Line dataKey="wb" name="WB" stroke="var(--accent-wb)" strokeWidth={2} dot={false}/>}
              {(platform==='all'||platform==='ozon') && <Line dataKey="oz" name="Ozon" stroke="var(--accent-oz)" strokeWidth={2} dot={false}/>}
              {platform==='all' && <Line dataKey="total" name="Итого" stroke="var(--ok)" strokeWidth={2} dot={false} strokeDasharray="4 2"/>}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:48, textAlign:'center', color:'var(--text2)' }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📭</div>
          <div style={{ fontWeight:600, marginBottom:6 }}>Данных пока нет</div>
          <div style={{ fontSize:12, color:'var(--text3)' }}>Перейди в Настройки → нажми «Обновить все»</div>
        </div>
      )}
    </div>
  );
}
