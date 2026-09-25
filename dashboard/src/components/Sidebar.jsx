import React, { useState, useRef, useEffect } from 'react';

const NAV_BY_CABINET = {
  licio: [['dashboard','📊','Дашборд'],['stocks','🏪','Остатки'],['discounts','💸','Соинвест'],['calculator','🧮','Калькулятор'],['settings','⚙️','Настройки']],
  defly: [['ads','📣','Реклама'],['discounts','💸','Соинвест'],['calculator','🧮','Калькулятор']],
};
const CABINETS = [['licio','Licio'],['defly','Defly']];

export default function Sidebar({ page, setPage, theme, cabinet, setCabinet }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const cabinetLabel = CABINETS.find(([id]) => id === cabinet)?.[1] || cabinet;
  const nav = NAV_BY_CABINET[cabinet] || NAV_BY_CABINET.licio;

  return (
    <div style={{ width:210, background:'var(--surface)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', flexShrink:0 }}>
      <div ref={ref} style={{ padding:'18px 16px 10px', position:'relative' }}>
        <button onClick={() => setOpen(o => !o)} style={{
          display:'flex', alignItems:'center', gap:10, width:'100%', background:'transparent', border:'none',
          padding:0, cursor:'pointer', textAlign:'left',
        }}>
          <img
            src="/logo.png"
            alt="Кабинет"
            style={{ height:26, width:'auto', flexShrink:0, filter: theme === 'dark' ? 'invert(1)' : 'none' }}
          />
          <div style={{ flex:1 }}>
            <div style={{ fontSize:15, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
              {cabinetLabel}
              <span style={{ fontSize:10, color:'var(--text3)' }}>▾</span>
            </div>
            <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>WB + Ozon</div>
          </div>
        </button>

        {open && (
          <div style={{
            position:'absolute', top:'100%', left:16, right:16, marginTop:6, zIndex:20,
            background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10,
            boxShadow:'0 8px 24px rgba(0,0,0,.25)', overflow:'hidden',
          }}>
            {CABINETS.map(([id, label]) => (
              <button key={id} onClick={() => { setCabinet(id); setOpen(false); }} style={{
                display:'block', width:'100%', textAlign:'left', padding:'9px 12px', border:'none',
                background: cabinet===id ? 'var(--surface2)' : 'transparent',
                color: cabinet===id ? 'var(--text)' : 'var(--text2)',
                fontWeight: cabinet===id ? 600 : 400, fontSize:13,
              }}>
                {label}{cabinet===id ? ' ✓' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      <nav style={{ flex:1, padding:'4px 8px' }}>
        {nav.map(([id,icon,label]) => (
          <button key={id} onClick={() => setPage(id)} style={{
            display:'flex', alignItems:'center', gap:9, width:'100%', padding:'9px 12px', borderRadius:8,
            border:'none', marginBottom:2, background:page===id?'var(--surface2)':'transparent',
            color:page===id?'var(--text)':'var(--text2)', fontWeight:page===id?600:400, fontSize:13, textAlign:'left', transition:'all .12s',
          }}>
            <span style={{ fontSize:15 }}>{icon}</span>{label}
            {page===id && <span style={{ marginLeft:'auto', width:3, height:16, borderRadius:2, background:'var(--accent-wb)' }}/>}
          </button>
        ))}
      </nav>
      <div style={{ padding:12, fontSize:11, color:'var(--text3)', borderTop:'1px solid var(--border)' }}>v1.4</div>
    </div>
  );
}
