import React, { useState, useEffect } from 'react';
import Sidebar from './components/Sidebar';
// Страницы грузятся по требованию (отдельными файлами): при открытии
// сервиса браузер качает только код текущей страницы, а не всех сразу.
const lazyPage = f => { const C = React.lazy(f); C.preload = f; return C; };
const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const Stocks = lazyPage(() => import('./pages/Stocks'));
const AdsStats = lazyPage(() => import('./pages/AdsStats2'));
const Discounts = lazyPage(() => import('./pages/Discounts'));
const Calculator = lazyPage(() => import('./pages/Calculator'));
const Settings = lazyPage(() => import('./pages/Settings'));
const TrackedArticles = lazyPage(() => import('./pages/TrackedArticles'));
const SalesAnalytics = lazyPage(() => import('./pages/SalesAnalytics'));
const Costs = lazyPage(() => import('./pages/Costs'));
const Geography = lazyPage(() => import('./pages/Geography'));
const UnitEconomics = lazyPage(() => import('./pages/UnitEconomics'));
const PnL = lazyPage(() => import('./pages/PnL'));
const Buyout = lazyPage(() => import('./pages/Buyout'));
const Inventory = lazyPage(() => import('./pages/Inventory'));
const AvgCheck = lazyPage(() => import('./pages/AvgCheck'));
const Abc = lazyPage(() => import('./pages/Abc'));
const Recon = lazyPage(() => import('./pages/Recon'));
const Margin = lazyPage(() => import('./pages/Margin'));
const PlanFact = lazyPage(() => import('./pages/PlanFact'));
const SearchPositions = lazyPage(() => import('./pages/SearchPositions'));
const Season = lazyPage(() => import('./pages/Season'));

// Если страница упала с ошибкой — показываем её текст и кнопку «Обновить
// раздел» вместо белого экрана (остальные разделы продолжают работать).
class PageBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null, key: 0 }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[Страница упала]', err, info?.componentStack); }
  render() {
    if (this.state.err) return (
      <div style={{ padding: 40, maxWidth: 720 }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>В этом разделе произошла ошибка</div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, opacity: 0.7, marginBottom: 14, whiteSpace: 'pre-wrap' }}>{String(this.state.err?.message || this.state.err)}</div>
        <button className="a-btn" onClick={() => this.setState(s => ({ err: null, key: s.key + 1 }))}>Обновить раздел</button>
        <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.6 }}>Если повторяется — пришлите текст ошибки Claude.</span>
      </div>
    );
    return <React.Fragment key={this.state.key}>{this.props.children}</React.Fragment>;
  }
}

const PAGES = { sales: SalesAnalytics, geo: Geography, unit: UnitEconomics, pnl: PnL, buyout: Buyout, inventory: Inventory, check: AvgCheck, abc: Abc, recon: Recon, margin: Margin, plan: PlanFact, search: SearchPositions, season: Season, costs: Costs, dashboard: Dashboard, stocks: Stocks, ads: AdsStats, discounts: Discounts, notifications: TrackedArticles, calculator: Calculator, settings: Settings };

// Держим в синхроне с NAV_BY_CABINET в components/Sidebar.jsx — какие
// страницы вообще доступны в каждом кабинете (Defly пока видит только
// вкладку "Реклама"). "Соинвест" — общий Seller API Ozon, доступен обоим.
// "Калькулятор" — чистый клиентский инструмент, не завязан на кабинет.
// "Уведомления" — отслеживание артикулов + Telegram-алерты о новых заказах,
// пока только для Licio (там же идёт общий сбор заказов WB/Ozon).
const PAGES_BY_CABINET = {
  licio: ['dashboard', 'ads', 'stocks', 'discounts', 'notifications', 'calculator', 'settings'],
  defly: ['sales', 'plan', 'ads', 'search', 'inventory', 'geo', 'check', 'abc', 'season', 'unit', 'margin', 'pnl', 'recon', 'buyout', 'discounts', 'notifications', 'calculator', 'costs'],
};

const THEME_KEY = 'mp-theme';
const CABINET_KEY = 'mp-cabinet';

export default function App() {
  const [page, setPage]     = useState(() => {
    let cab = 'licio';
    try { cab = localStorage.getItem(CABINET_KEY) || 'licio'; } catch (e) { /* ignore */ }
    return (PAGES_BY_CABINET[cab] || PAGES_BY_CABINET.licio)[0];
  });
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
  // Раньше в фоне по очереди открывались ВСЕ разделы кабинета — каждый со
  // своими тяжёлыми запросами, и при первом открытии сервер и браузер были
  // заняты десятком загрузок сразу. Теперь в фоне подгружается только код
  // страниц (без данных), данные — когда раздел открыт.
  useEffect(() => {
    setVisited(new Set([page]));
    const t = setTimeout(() => { allowed.forEach(id => { try { PAGES[id]?.preload?.(); } catch (e) { /* ignore */ } }); }, 4000);
    return () => clearTimeout(t);
  }, [cabinet]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { document.title = cabinet === 'defly' ? 'Defly — аналитика Ozon' : 'Licio — WB + Ozon'; }, [cabinet]);

  // Переключатель WB/Ozon нужен только старым разделам Licio.
  const showPlatform = cabinet === 'licio' && !['ads', 'sales', 'costs', 'unit', 'pnl', 'buyout', 'geo', 'inventory', 'check', 'abc', 'recon', 'margin', 'plan', 'search', 'season', 'calculator', 'notifications'].includes(page);

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
                <PageBoundary>
                  <React.Suspense fallback={<div style={{ padding: 40, color: 'var(--a-ink3, #888)' }}>Загрузка…</div>}>
                    <P platform={platform} cabinet={cabinet} active={on}/>
                  </React.Suspense>
                </PageBoundary>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
