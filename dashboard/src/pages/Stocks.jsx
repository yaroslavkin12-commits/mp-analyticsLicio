import React, { useState, useEffect } from 'react';
import { getStocks } from '../api';

export default function Stocks({ platform }) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('wb');
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    getStocks({ platform }).then(r => setData(r.data.data||{})).catch(console.error).finally(() => setLoading(false));
  }, [platform]);

  const activeTab = platform !== 'all' ? platform : tab;
  const all = data[activeTab] || [];
  const items = search ? all.filter(p => {
    const s = search.toLowerCase();
    return (p.article||p.offer_id||'').toLowerCase().includes(s) || (p.subject||p.product_name||'').toLowerCase().includes(s);
  }) : all;

  const badge = qty => {
    const n = Number(qty||0);
    if (n===0) return { label:'🔴 Нет',   color:'var(--danger)', bg:'rgba(239,68,68,.12)' };
    if (n<10)  return { label:'🟡 Мало',  color:'var(--warn)',   bg:'rgba(245,158,11,.12)' };
    return             { label:'🟢 Норма', color:'var(--ok)',     bg:'rgba(16,185,129,.12)' };
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
        <h1 style={{ fontSize:17, fontWeight:700 }}>Остатки</h1>
        <input placeholder="Поиск..." value={search} onChange={e => setSearch(e.target.value)} style={{ width:260 }}/>
      </div>
      {platform==='all' && (
        <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3, width:'fit-content' }}>
          {[['wb','var(--accent-wb)','WB'],['ozon','var(--accent-oz)','Ozon']].map(([v,c,l]) => (
            <button key={v} onClick={() => setTab(v)} style={{ padding:'5px 14px', borderRadius:6, border:'none', fontSize:13, fontWeight:500, background:activeTab===v?c:'transparent', color:activeTab===v?'#fff':'var(--text2)' }}>{l}</button>
          ))}
        </div>
      )}
      <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
        {loading ? <div style={{ padding:32, textAlign:'center', color:'var(--text2)' }}>Загрузка...</div>
          : items.length===0 ? <div style={{ padding:40, textAlign:'center', color:'var(--text2)' }}>{search?'Ничего не найдено':'Нет данных об остатках'}</div>
          : (
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
            <thead>
              <tr>{['Артикул','Наименование',activeTab==='wb'?'Остаток':'FBO',activeTab==='ozon'?'FBS':null,'Итого','Статус'].filter(Boolean).map(h =>
                <th key={h} style={{ padding:'8px 12px', textAlign:'left', color:'var(--text2)', fontWeight:500, fontSize:12, borderBottom:'1px solid var(--border)' }}>{h}</th>
              )}</tr>
            </thead>
            <tbody>
              {items.map((p,i) => {
                const qty = Number(activeTab==='wb' ? p.total_quantity : p.total_qty || 0);
                const b = badge(qty);
                const color = activeTab==='wb' ? 'var(--accent-wb)' : 'var(--accent-oz)';
                return (
                  <tr key={i} style={{ borderBottom:'1px solid var(--border)' }}>
                    <td style={{ padding:'9px 12px', color, fontWeight:600 }}>{p.article||p.offer_id}</td>
                    <td style={{ padding:'9px 12px', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.subject||p.product_name||'—'}</td>
                    {activeTab==='wb'
                      ? <td style={{ padding:'9px 12px', fontWeight:700, color:b.color }}>{qty}</td>
                      : <><td style={{ padding:'9px 12px' }}>{p.fbo_qty||0}</td><td style={{ padding:'9px 12px' }}>{p.fbs_qty||0}</td></>}
                    {activeTab==='ozon' && <td style={{ padding:'9px 12px', fontWeight:700, color:b.color }}>{qty}</td>}
                    <td style={{ padding:'9px 12px' }}><span style={{ padding:'2px 8px', borderRadius:5, fontSize:11, fontWeight:600, background:b.bg, color:b.color }}>{b.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
