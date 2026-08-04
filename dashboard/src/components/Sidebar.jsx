import React from 'react';
const NAV = [['overview','📊','Обзор'],['products','📦','Товары'],['stocks','🏪','Остатки'],['ads','📢','Реклама'],['settings','⚙️','Настройки']];

export default function Sidebar({ page, setPage }) {
  return (
    <div style={{ width: 210, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '20px 16px 10px' }}>
        <div style={{ fontSize: 15, fontWeight: 700 }}>MP Analytics</div>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>WB + Ozon</div>
      </div>
      <nav style={{ flex: 1, padding: '4px 8px' }}>
        {NAV.map(([id, icon, label]) => (
          <button key={id} onClick={() => setPage(id)} style={{
            display: 'flex', alignItems: 'center', gap: 9, width: '100%',
            padding: '9px 12px', borderRadius: 8, border: 'none', marginBottom: 2,
            background: page === id ? 'var(--surface2)' : 'transparent',
            color: page === id ? 'var(--text)' : 'var(--text2)',
            fontWeight: page === id ? 600 : 400, fontSize: 13, textAlign: 'left', transition: 'all .12s',
          }}>
            <span style={{ fontSize: 16 }}>{icon}</span>{label}
            {page === id && <span style={{ marginLeft: 'auto', width: 3, height: 16, borderRadius: 2, background: 'var(--accent-wb)' }} />}
          </button>
        ))}
      </nav>
      <div style={{ padding: 12, fontSize: 11, color: 'var(--text3)', borderTop: '1px solid var(--border)' }}>v1.0</div>
    </div>
  );
}
