import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import Stocks from './pages/Stocks';
import Settings from './pages/Settings';

const PAGES = { stocks: Stocks, settings: Settings };

const THEME_KEY = 'mp-theme';

export default function App() {
  const [page, setPage]     = useState('stocks');
  const [platform, setPlatform] = useState('all');
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch(e) { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) { /* ignore */ }
  }, [theme]);

  const Page = PAGES[page] || Stocks;

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar page={page} setPage={setPage} theme={theme}/>
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Топ-бар */}
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 18px',
          borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
          {/* Переключатель площадок */}
          <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3 }}>
            {[['all','Все'],['wb','WB'],['ozon','Ozon']].map(([v,l])=>(
              <button key={v} onClick={()=>setPlatform(v)} style={{
                padding:'5px 14px', borderRadius:6, border:'none', fontSize:13, fontWeight:500, transition:'all .15s',
                background: platform===v ? (v==='wb'?'var(--accent-wb)':v==='ozon'?'var(--accent-oz)':'#334155') : 'transparent',
                color: platform===v ? '#fff' : 'var(--text2)',
              }}>{l}</button>
            ))}
          </div>

          <button
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            style={{ marginLeft:'auto', display:'flex', alignItems:'center', justifyContent:'center',
              width:32, height:32, borderRadius:8, border:'1px solid var(--border)', background:'var(--surface2)', fontSize:15 }}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>

        <div style={{ flex:1, overflow:'auto', padding:18 }}>
          <Page platform={platform}/>
        </div>
      </div>
    </div>
  );
}
