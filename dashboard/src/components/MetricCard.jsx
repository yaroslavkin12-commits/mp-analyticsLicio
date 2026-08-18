import React from 'react';
export default function MetricCard({ label, value, suffix='', color, sub }) {
  return (
    <div style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:'var(--radius)', padding:'16px 18px', borderLeft:color?`3px solid ${color}`:undefined }}>
      <div style={{ fontSize:11, color:'var(--text2)', marginBottom:6, fontWeight:500, textTransform:'uppercase', letterSpacing:.5 }}>{label}</div>
      <div style={{ fontSize:22, fontWeight:700, letterSpacing:'-0.5px' }}>
        {typeof value==='number' ? value.toLocaleString('ru-RU') : (value??'—')}{suffix}
      </div>
      {sub && <div style={{ fontSize:11, color:'var(--text3)', marginTop:4 }}>{sub}</div>}
    </div>
  );
}
