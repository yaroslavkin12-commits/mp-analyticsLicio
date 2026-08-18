import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Overview from './pages/Overview';
import SalesAnalytics from './pages/SalesAnalytics';
import Stocks from './pages/Stocks';
import Ads from './pages/Ads';
import Settings from './pages/Settings';
import dayjs from 'dayjs';

const PAGES = { overview: Overview, analytics: SalesAnalytics, stocks: Stocks, ads: Ads, settings: Settings };

export default function App() {
  const [page, setPage]       = useState('overview');
  const [platform, setPlatform] = useState('all');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(30,'day').format('YYYY-MM-DD'));
  const [dateTo, setDateTo]     = useState(dayjs().format('YYYY-MM-DD'));

  const Page = PAGES[page] || Overview;

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar page={page} setPage={setPage}/>
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'11px 18px', borderBottom:'1px solid var(--border)', background:'var(--surface)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:3, background:'var(--surface2)', borderRadius:8, padding:3 }}>
            {[['all','Все'],['wb','WB'],['ozon','Ozon']].map(([v,l]) => (
              <button key={v} onClick={() => setPlatform(v)} style={{
                padding:'5px 14px', borderRadius:6, border:'none', fontSize:13, fontWeight:500, transition:'all .15s',
                background: platform===v ? (v==='wb'?'var(--accent-wb)':v==='ozon'?'var(--accent-oz)':'#334155') : 'transparent',
                color: platform===v ? '#fff' : 'var(--text2)',
              }}>{l}</button>
            ))}
          </div>
          {page !== 'analytics' && (
            <div style={{ display:'flex', gap:8, marginLeft:'auto', alignItems:'center' }}>
              <span style={{ color:'var(--text3)', fontSize:12 }}>с</span>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ width:140 }}/>
              <span style={{ color:'var(--text3)', fontSize:12 }}>по</span>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ width:140 }}/>
            </div>
          )}
        </div>
        <div style={{ flex:1, overflow:'auto', padding:18 }}>
          <Page platform={platform} dateFrom={dateFrom} dateTo={dateTo}/>
        </div>
      </div>
    </div>
  );
}
