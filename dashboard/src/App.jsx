import React, { useState, useEffect } from 'react';
import { initArtLinks } from './lib/artLinks';
import { initSearchClear } from './lib/searchClear';
import { whenIdle } from './api';
import { isDeflyLike, shopOf, SHARED_PAGES } from './lib/cabinets';
import Sidebar, { navLabel } from './components/Sidebar';
import { startStickyHeads } from './lib/stickyHeads';
startStickyHeads();
import Dashboard from './pages/Dashboard';
import Stocks from './pages/Stocks';
import AdsStats from './pages/AdsStats2';
import Discounts from './pages/Discounts';
import Calculator from './pages/Calculator';
import Settings from './pages/Settings';
import TrackedArticles from './pages/TrackedArticles';
import SalesAnalytics from './pages/SalesAnalytics';
import Geography from './pages/Geography';
import UnitEconomics from './pages/UnitEconomics';
import PnL from './pages/PnL';
import Buyout from './pages/Buyout';
import Inventory from './pages/Inventory';
import Production from './pages/Production';
import PriceLog from './pages/PriceLog';
import Products from './pages/Products';
import OrdersFeed from './pages/OrdersFeed';
import ShopsSummary from './pages/ShopsSummary';
const RnpPage = props => <SalesAnalytics {...props} view="rnp" />;
import AvgCheck from './pages/AvgCheck';
import Abc from './pages/Abc';
import Recon from './pages/Recon';
import Margin from './pages/Margin';
import PlanFact from './pages/PlanFact';
import SearchPositions from './pages/SearchPositions';
import Season from './pages/Season';

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

const PAGES = { summary: ShopsSummary, sales: SalesAnalytics, rnp: RnpPage, orders: OrdersFeed, geo: Geography, unit: UnitEconomics, pnl: PnL, buyout: Buyout, inventory: Inventory, production: Production, pricelog: PriceLog, check: AvgCheck, abc: Abc, recon: Recon, margin: Margin, plan: PlanFact, search: SearchPositions, season: Season, costs: Products, dashboard: Dashboard, stocks: Stocks, ads: AdsStats, discounts: Discounts, notifications: TrackedArticles, calculator: Calculator, settings: Settings };

// Держим в синхроне с NAV_BY_CABINET в components/Sidebar.jsx — какие
// страницы доступны в каждом кабинете. Аналитика, P&L и юнит-экономика
// используют Ozon-данные выбранного магазина.
// "Калькулятор" — чистый клиентский инструмент, не завязан на кабинет.
// "Уведомления" — отслеживание артикулов + Telegram-алерты о новых заказах,
// пока только для Licio (там же идёт общий сбор заказов WB/Ozon).
const PAGES_BY_CABINET_RAW = {
  licio: ['sales', 'ads', 'unit', 'pnl', 'stocks', 'discounts', 'notifications', 'calculator', 'settings'],
  defly: ['sales', 'summary', 'rnp', 'orders', 'plan', 'ads', 'search', 'inventory', 'production', 'pricelog', 'geo', 'check', 'abc', 'season', 'unit', 'margin', 'pnl', 'recon', 'buyout', 'discounts', 'notifications', 'calculator', 'costs'],
};
// Магазины семейства Defly видят те же разделы.
const PAGES_BY_CABINET = new Proxy(PAGES_BY_CABINET_RAW, { get: (t, k) => t[k] || (isDeflyLike(k) ? t.defly : undefined) });

const THEME_KEY = 'mp-theme';
// Телефон: узкий экран. Все мобильные правки — только при этом условии (и в CSS
// под тем же @media), чтобы компьютерная версия не менялась.
const MOBILE_Q = '(max-width: 760px)';
function useIsMobile() {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia(MOBILE_Q).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_Q);
    const on = () => setM(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', on) : mq.addListener(on);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', on) : mq.removeListener(on));
  }, []);
  return m;
}
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
  const isMobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch(e) { return 'dark'; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch(e) { /* ignore */ }
  }, [theme]);

  // Переход из «Сводки по магазинам»: открыть раздел нужного магазина.
  useEffect(() => {
    const h = e => { const { cabinet: c, page: p } = e.detail || {}; if (c) setCabinet(c); if (p) setTimeout(() => setPage(p), 0); };
    window.addEventListener('mp-open', h);
    return () => window.removeEventListener('mp-open', h);
  }, []);

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
  // Все разделы кабинета открываются в фоне по очереди — переключение между
  // вкладками мгновенное, данные уже загружены.
  // Данные изменились (сохранили себестоимость и т. п.) — остальные разделы
  // перезагружаются в фоне, открытый остаётся как есть.
  const [gen, setGen] = useState(0);
  const pageRef = React.useRef(page); pageRef.current = page;
  const [pageGen, setPageGen] = useState({});
  useEffect(() => {
    const onChange = () => {
      const cur = pageRef.current;
      setPageGen(prev => { const n = { ...prev }; for (const id of allowed) if (id !== cur) n[id] = (n[id] || 0) + 1; return n; });
      setGen(g => g + 1);
    };
    window.addEventListener('mp-data-changed', onChange);
    return () => window.removeEventListener('mp-data-changed', onChange);
  }, [allowed]);
  useEffect(() => {
    setVisited(new Set([pageRef.current]));
    let cancelled = false;
    const timers = [];
    // По одному разделу и только когда сеть свободна: сначала свои данные
    // получает открытая страница, потом фоном — остальные.
    const order = allowed.filter(id => id !== page);
    // На телефоне фоном ничего не грузим — только открытый раздел (память).
    if (window.matchMedia && window.matchMedia(MOBILE_Q).matches) return () => {};
    (async () => {
      await new Promise(r => timers.push(setTimeout(r, 1500)));
      for (const id of order) {
        await whenIdle(800);
        if (cancelled) return;
        setVisited(prev => prev.has(id) ? prev : new Set(prev).add(id));
        await new Promise(r => timers.push(setTimeout(r, 400)));
      }
    })();
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [cabinet, gen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { initArtLinks(cabinet); }, [cabinet]);
  useEffect(() => { initSearchClear(); }, []);
  useEffect(() => { document.title = isDeflyLike(cabinet) ? `${shopOf(cabinet)?.label || cabinet} — аналитика Ozon` : 'Licio — WB + Ozon'; }, [cabinet]);

  // Переключатель WB/Ozon нужен только старым разделам Licio.
  const showPlatform = cabinet === 'licio' && !['ads', 'sales', 'rnp', 'orders', 'costs', 'unit', 'pnl', 'buyout', 'geo', 'inventory', 'production', 'pricelog', 'check', 'abc', 'recon', 'margin', 'plan', 'search', 'season', 'calculator', 'notifications'].includes(page);

  return (
    <div className={`app-root ${isMobile ? 'is-mobile' : ''}`} style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      {isMobile ? (drawer && <>
        <div className="m-drawer-bg" onClick={() => setDrawer(false)} />
        <div className="m-drawer"><Sidebar mobile page={page} setPage={id => { setPage(id); setDrawer(false); }} theme={theme} setTheme={setTheme} cabinet={cabinet} setCabinet={c => { setCabinet(c); setDrawer(false); }}/></div>
      </>) : <Sidebar page={page} setPage={setPage} theme={theme} setTheme={setTheme} cabinet={cabinet} setCabinet={setCabinet}/>}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {isMobile && (
          <div className="m-topbar">
            <button type="button" className="m-burger" onClick={() => setDrawer(true)} aria-label="Меню">☰</button>
            <span className="m-title">{navLabel(cabinet, page)}</span>
          </div>
        )}
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
          {allowed.filter(id => visited.has(id) && PAGES[id] && (!isMobile || id === page)).map(id => {
            const P = PAGES[id];
            const on = id === page;
            return (
              <div key={cabinet + ':' + id + ':' + (pageGen[id] || 0)} aria-hidden={!on} className="app-page" style={{
                position:'absolute', inset:0, overflow:'auto',
                visibility: on ? 'visible' : 'hidden', zIndex: on ? 1 : 0, pointerEvents: on ? 'auto' : 'none',
              }}>
                {cabinet === 'licio' && ['sales', 'unit', 'pnl'].includes(id) && <div style={{padding:'8px 20px 0',fontSize:12,color:'var(--text2)'}}>Ozon · данные кабинета Licio</div>}
                <PageBoundary>
                  <P platform={platform} cabinet={SHARED_PAGES[id] && isDeflyLike(cabinet) ? SHARED_PAGES[id] : cabinet} active={on}/>
                </PageBoundary>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
