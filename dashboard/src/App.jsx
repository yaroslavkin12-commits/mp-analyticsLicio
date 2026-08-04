import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Overview from './pages/Overview';
import Products from './pages/Products';
import Stocks from './pages/Stocks';
import Ads from './pages/Ads';
import Settings from './pages/Settings';
import dayjs from 'dayjs';

const PAGES = { overview: Overview, products: Products, stocks: Stocks, ads: Ads, settings: Settings };

export default function App() {
  const [page, setPage] = useState('overview');
  const [platform, setPlatform] = useState('all');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(30, 'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo] = useState(dayjs().format('YYYY-MM-DD'));

  const Page = PAGES[page] || Overview;

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar page={page} setPage={setPage} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Топ-бар */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          {/* Переключатель площадки */}
          <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
            {[['all','Все'], ['wb','WB'], ['ozon','Ozon']].map(([v, l]) => (
              <button key={v} onClick={() => setPlatform(v)} style={{
                padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, transition: 'all .15s',
                background: platform === v ? (v === 'wb' ? 'var(--accent-wb)' : v === 'ozon' ? 'var(--accent-oz)' : '#334155') : 'transparent',
                color: platform === v ? '#fff' : 'var(--text2)',
              }}>{l}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', alignItems: 'center' }}>
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>с</span>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ width: 140 }} />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>по</span>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ width: 140 }} />
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
          <Page platform={platform} dateFrom={dateFrom} dateTo={dateTo} />
        </div>
      </div>
    </div>
  );
}
