import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { getOverview, getChart } from '../api';
import dayjs from 'dayjs';

const fmt  = n => Number(n||0).toLocaleString('ru-RU');
const fmtR = n => fmt(Math.round(n||0)) + ' ₽';

function Card({ label, value, sub, color, warn }) {
  return (
    <div style={{
      background:'var(--surface)', border:'1px solid var(--border)',
      borderRadius:'var(--radius)', padding:'14px 16px',
      borderLeft: color ? `3px solid ${color}` : undefined,
    }}>
      <div style={{ fontSize:10, color:'var(--text2)', marginBottom:5, fontWeight:600, textTransform:'uppercase', letterSpacing:.5 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:700, letterSpacing:'-0.5px', color: warn ? 'var(--danger)' : 'inherit' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:'var(--text3)', marginTop:3 }}>{sub}</div>}
    </div>
  );
}

function MetricRow({ data, color, label }) {
  if (!data) return null;
  const drr = Number(data.drr||0);
  return (
    <div>
      <div style={{ fontSize:11, fontWeight:700, color, textTransform:'uppercase', letterSpacing:1, marginBottom:8 }}>{label}</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))', gap:10 }}>
        <Card label="Сумма заказов" value={fmtR(data.orders_sum)}     color={color} />
        <Card label="Заказы"        value={fmt(data.orders_qty)}       color={color} />
        <Card label="Выручка"       value={fmtR(data.revenue)}         color={color} />
        <Card label="Продажи"       value={fmt(data.sales_qty)}        color={color} />
        <Card label="% выкупа"      value={`${data.redemption_rate}%`} color={color}
          warn={Number(data.redemption_rate) < 40}
          sub={Number(data.redemption_rate) < 40 ? '⚠️ Низкий' : '✅ Норма'} />
        <Card label="Расход рекламы" value={fmtR(data.ad_spend)}      color={color} />
        <Card label="ДРР"           value={`${data.drr}%`}
          color={drr > 20 ? 'var(--danger)' : 'var(--ok)'}
          sub={drr > 20 ? '⚠️ Выше нормы' : '✅ В норме'} />
      </div>
    </div>
  );
}

export default function Overview({ platform, dateFrom, dateTo }) {
  const [data,  setData]  = useState(null);
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
      (ch.data.data.wb   ||[]).forEach(r => wbMap[r.date] = Number(r.orders_sum||0));
      (ch.data.data.ozon ||[]).forEach(r => ozMap[r.date] = Number(r.orders_sum||0));
      const dates = [...new Set([...Object.keys(wbMap), ...Object.keys(ozMap)])].sort();
      setChart(dates.map(d => ({
        date: dayjs(d).format('DD.MM'),
        wb:    wbMap[d]||0,
        oz:    ozMap[d]||0,
        total: (wbMap[d]||0) + (ozMap[d]||0),
      })));
    }).catch(console.error).finally(() => setLoading(false));
  }, [platform, dateFrom, dateTo]);

  if (loading) return <div style={{ padding:60, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
      <h1 style={{ fontSize:17, fontWeight:700 }}>Обзор продаж</h1>

      {(platform==='all'||platform==='wb')  && <MetricRow data={data?.wb}   color="var(--accent-wb)" label="Wildberries"/>}
      {(platform==='all'||platform==='ozon') && <MetricRow data={data?.ozon} color="var(--accent-oz)" label="Ozon"/>}

      {chart.length > 0 ? (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:20 }}>
          <div style={{ fontWeight:600, marginBottom:14 }}>Динамика суммы заказов</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chart}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)"/>
              <XAxis dataKey="date" tick={{ fill:'var(--text2)', fontSize:11 }}/>
              <YAxis tick={{ fill:'var(--text2)', fontSize:11 }} tickFormatter={v => (v/1000).toFixed(0)+'k'}/>
              <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:8 }}
                formatter={(v,n) => [fmtR(v), n==='wb'?'WB':n==='oz'?'Ozon':'Итого']}/>
              <Legend wrapperStyle={{ fontSize:12 }} formatter={n => n==='wb'?'WB':n==='oz'?'Ozon':'Итого'}/>
              {(platform==='all'||platform==='wb')  && <Line dataKey="wb"    name="wb"    stroke="var(--accent-wb)" strokeWidth={2} dot={false}/>}
              {(platform==='all'||platform==='ozon') && <Line dataKey="oz"   name="oz"    stroke="var(--accent-oz)" strokeWidth={2} dot={false}/>}
              {platform==='all' && <Line dataKey="total" name="total" stroke="var(--ok)" strokeWidth={2} dot={false} strokeDasharray="4 2"/>}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:48, textAlign:'center', color:'var(--text2)' }}>
          <div style={{ fontSize:36, marginBottom:12 }}>📭</div>
          <div style={{ fontWeight:600, marginBottom:6 }}>Данных пока нет</div>
          <div style={{ fontSize:12, color:'var(--text3)' }}>Перейди в Настройки → Обновить все</div>
        </div>
      )}
    </div>
  );
}
