import React, { useState } from 'react';
import Sidebar from './components/Sidebar';
import Overview from './pages/Overview';
import SalesAnalytics from './pages/SalesAnalytics';
import Stocks from './pages/Stocks';
import Ads from './pages/Ads';
import Settings from './pages/Settings';
import DateRangePicker from './components/DateRangePicker';
import dayjs from 'dayjs';

const PAGES = { overview: Overview, analytics: SalesAnalytics, stocks: Stocks, ads: Ads, settings: Settings };

// Страницы у которых свой датпикер
const SELF_DATE = ['analytics'];

export default function App() {
  const [page, setPage]     = useState('overview');
  const [platform, setPlatform] = useState('all');
  const [dateFrom, setDateFrom] = useState(dayjs().subtract(30,'day').format('YYYY-MM-DD'));
  const [dateTo,   setDateTo]   = useState(dayjs().format('YYYY-MM-DD'));

  const Page = PAGES[page] || Overview;
  const showTopDate = !SELF_DATE.includes(page);

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar page={page} setPage={setPage}/>
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

          {/* Датпикер только для страниц без своего */}
          {showTopDate && (
            <div style={{ marginLeft:'auto' }}>
              <DateRangePicker
                from={dateFrom} to={dateTo}
                onChange={(f,t) => { setDateFrom(f); setDateTo(t); }}
              />
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
