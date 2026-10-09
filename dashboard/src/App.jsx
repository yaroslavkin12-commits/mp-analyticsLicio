import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Stocks from './pages/Stocks';
import AdsStats from './pages/AdsStats2';
import Discounts from './pages/Discounts';
import Calculator from './pages/Calculator';
import Settings from './pages/Settings';
import TrackedArticles from './pages/TrackedArticles';
import SalesAnalytics from './pages/SalesAnalytics';
import Costs from './pages/Costs';

const PAGES = { sales: SalesAnalytics, costs: Costs, dashboard: Dashboard, stocks: Stocks, ads: AdsStats, discounts: Discounts, notifications: TrackedArticles, calculator: Calculator, settings: Settings };

// Держим в синхроне с NAV_BY_CABINET в components/Sidebar.jsx — какие
// страницы вообще доступны в каждом кабинете (Defly пока видит только
// вкладку "Реклама"). "Соинвест" — общий Seller API Ozon, доступен обоим.
// "Калькулятор" — чистый клиентский инструмент, не завязан на кабинет.
// "Уведомления" — отслеживание артикулов + Telegram-алерты о новых заказах,
// пока только для Licio (там же идёт общий сбор заказов WB/Ozon).
const PAGES_BY_CABINET = {
  licio: ['sales', 'dashboard', 'stocks', 'discounts', 'notifications', 'calculator', 'settings', 'costs'],
  defly: ['sales', 'ads', 'discounts', 'notifications', 'calculator', 'costs'],
};

const THEME_KEY = 'mp-theme';
const CABINET_KEY = 'mp-cabinet';

export default function App() {
  const [page, setPage]     = useState('sales');
  const [platform, setPlatform] = useState('all');
  const [cabinet, setCabinet] = useState(() => {
    try { return localStorage.getItem(CABINET_KEY) || 'licio'; } catch(e) { return 'licio'; }
  });
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch(e) { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    try { localStorage.setItem(CABINET_KEY, cabinet); } catch(e) { /* ignore */ }
    const allowed = PAGES_BY_CABINET[cabinet] || PAGES_BY_CABINET.licio;
    if (!allowed.includes(page)) setPage(allowed[0]);
  }, [cabinet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Страницы не размонтируются при переключении: открытая один раз страница
  // остаётся в памяти со своими данными и прокруткой, поэтому возврат на неё
  // мгновенный. Остальные разделы кабинета подгружаются в фоне по очереди.
  const allowed = PAGES_BY_CABINET[cabinet] || PAGES_BY_CABINET.licio;
  const [visited, setVisited] = useState(() => new Set([page]));
  useEffect(() => { setVisited(prev => prev.has(page) ? prev : new Set(prev).add(page)); }, [page]);
  useEffect(() => {
    setVisited(new Set([page]));
    let cancelled = false;
    const timers = [];
    const order = allowed.filter(id => id !== page);
    order.forEach((id, i) => {
      timers.push(setTimeout(() => {
        if (cancelled) return;
        setVisited(prev => prev.has(id) ? prev : new Set(prev).add(id));
      }, 2500 + i * 1500));
    });
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [cabinet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Переключатель WB/Ozon нужен только старым разделам Licio.
  const showPlatform = cabinet === 'licio' && !['ads', 'sales', 'costs', 'calculator', 'notifications'].includes(page);

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar page={page} setPage={setPage} theme={theme} setTheme={setTheme} cabinet={cabinet} setCabinet={setCabinet}/>
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {showPlatform && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 18px',
            borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
            <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3 }}>
              {[['all','Все'],['wb','WB'],['ozon','Ozon']].map(([v,l])=>(
                <button key={v} onClick={()=>setPlatform(v)} style={{
                  padding:'5px 14px', borderRadius:6, border:'none', fontSize:13, fontWeight:500, transition:'all .15s',
                  background: platform===v ? (v==='wb'?'var(--accent-wb)':v==='ozon'?'var(--accent-oz)':'#334155') : 'transparent',
                  color: platform===v ? '#fff' : 'var(--text2)',
                }}>{l}</button>
              ))}
            </div>
          </div>
        )}

        <div style={{ flex:1, position:'relative', minHeight:0 }}>
          {allowed.filter(id => visited.has(id) && PAGES[id]).map(id => {
            const P = PAGES[id];
            const on = id === page;
            return (
              <div key={cabinet + ':' + id} aria-hidden={!on} style={{
                position:'absolute', inset:0, overflow:'auto', padding:18,
                visibility: on ? 'visible' : 'hidden', zIndex: on ? 1 : 0, pointerEvents: on ? 'auto' : 'none',
              }}>
                <P platform={platform} cabinet={cabinet} active={on}/>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
