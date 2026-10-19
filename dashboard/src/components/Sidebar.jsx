import React, { useState, useRef, useEffect } from 'react';
import { SHOPS, shopOf, isDeflyLike } from '../lib/cabinets';
import { getAdsCabinets } from '../api';

const NAV_BY_CABINET = {
  licio: [['dashboard','📊','Дашборд'],['ads','📣','Реклама'],['stocks','🏪','Остатки'],['discounts','💸','Соинвест'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['settings','⚙️','Настройки']],
  // Разделы меню Defly: заголовок раздела — ['__h', 'Название'].
  defly: [
    ['__h','Продажи'],['sales','📈','Аналитика продаж'],['plan','🎯','План / факт'],['check','🧾','Средний чек'],['abc','🔤','ABC-анализ'],['season','🍂','Сезонность'],['geo','🗺️','География продаж'],
    ['__h','Реклама и поиск'],['ads','📣','Реклама'],['search','🔍','Позиции в поиске'],['discounts','💸','Соинвест'],
    ['__h','Склад'],['inventory','🏬','Остатки'],['production','🧵','Производство'],['buyout','📦','% выкупа'],
    ['__h','Деньги'],['unit','🧩','Юнит-экономика'],['margin','🏷️','Цены и маржа'],['pricelog','📝','Журнал цен'],['pnl','💰','P&L'],['recon','🔎','Сверка с Ozon'],
    ['__h','Инструменты'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['costs','🧾','Себестоимость'],
  ],
};
const navOf = c => NAV_BY_CABINET[c] || (isDeflyLike(c) ? NAV_BY_CABINET.defly : NAV_BY_CABINET.licio);
export const navLabel = (cabinet, page) => (navOf(cabinet).find(([id]) => id === page) || [])[2] || '';

export default function Sidebar({ page, setPage, theme, setTheme, cabinet, setCabinet, mobile }) {
  const [open, setOpen] = useState(false);
  // Свёрнутое меню — только значки (помнится в браузере).
  const [miniPref, setMini] = useState(() => { try { return localStorage.getItem('mp-side-mini') === '1'; } catch (e) { return false; } });
  const mini = miniPref && !mobile; // в мобильном меню всегда с подписями
  useEffect(() => { try { localStorage.setItem('mp-side-mini', miniPref ? '1' : '0'); } catch (e) { /* ignore */ } }, [miniPref]);
  const ref = useRef(null);

  useEffect(() => {
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const shop = shopOf(cabinet);
  const cabinetLabel = shop?.label || cabinet;
  const nav = navOf(cabinet);
  // Какие магазины уже подключены (есть своя Google-таблица на сервере).
  const [conn, setConn] = useState(null);
  useEffect(() => { if (open && !conn) getAdsCabinets().then(r => setConn(Object.fromEntries((r.data.data || []).map(c => [c.id, c.connected !== false])))).catch(() => setConn({})); }, [open, conn]);
  const dot = (c, size = 8) => <span style={{ width:size, height:size, borderRadius:'50%', background:c, flexShrink:0, display:'inline-block' }} />;
  const head = t => <div style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text3)', padding:'9px 12px 3px' }}>{t}</div>;
  const item = (sh, disabled, note) => (
    <button key={sh.id} disabled={disabled} onClick={() => { setCabinet(sh.id); setOpen(false); }} title={disabled ? note : undefined} style={{
      display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left', padding:'7px 12px', border:'none',
      background: cabinet===sh.id ? 'var(--surface2)' : 'transparent', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1,
      color: cabinet===sh.id ? 'var(--text)' : 'var(--text2)', fontWeight: cabinet===sh.id ? 600 : 400, fontSize:13,
    }}>
      {dot(sh.color)}<span style={{ flex:1, whiteSpace:'nowrap' }}>{sh.label}</span>
      {note && <small style={{ fontSize:10.5, color:'var(--text3)', whiteSpace:'nowrap' }}>{note}</small>}
      {cabinet===sh.id && <span>✓</span>}
    </button>
  );

  return (
    <div style={{ width: mobile ? '100%' : mini ? 58 : 210, height: mobile ? '100%' : undefined, transition:'width .15s', background:'var(--surface)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', flexShrink:0 }}>
      <div ref={ref} style={{ padding: mini ? '16px 8px 10px' : '18px 16px 10px', position:'relative' }}>
        <button onClick={() => setOpen(o => !o)} style={{
          display:'flex', alignItems:'center', gap:10, width:'100%', background:'transparent', border:'none',
          padding:0, cursor:'pointer', textAlign:'left', color:'var(--text)',
        }}>
          {isDeflyLike(cabinet) && cabinet !== 'defly' ? (
            <>
              {dot(shop?.color || 'var(--text3)', mini ? 12 : 10)}
              {!mini && <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>{cabinetLabel}<span style={{ fontSize:10, color:'var(--text3)' }}>▾</span></div>
                <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>Ozon</div>
              </div>}
            </>
          ) : cabinet === 'defly' ? (
            <>
              <img src="/defly-logo.png" alt="Defly" style={{ height: mini ? 24 : 32, width: mini ? 42 : 'auto', objectFit: mini ? 'cover' : undefined, objectPosition:'left center', maxWidth:110, borderRadius:5, flexShrink:0, display:'block' }} />
              {!mini && <span style={{ fontSize:10, color:'var(--text3)', marginLeft:'auto' }}>▾</span>}
            </>
          ) : (
            <>
              <img
                src="/logo.png"
                alt="Кабинет"
                style={{ height:26, width:'auto', flexShrink:0, filter: theme === 'dark' ? 'invert(1)' : 'none' }}
              />
              {!mini && <div style={{ flex:1 }}>
                <div style={{ fontSize:15, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
                  {cabinetLabel}
                  <span style={{ fontSize:10, color:'var(--text3)' }}>▾</span>
                </div>
                <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>WB + Ozon</div>
              </div>}
            </>
          )}
        </button>

        {open && (
          <div style={{
            position:'absolute', top:'100%', left: mini ? 8 : 16, right: mini ? 'auto' : 16, minWidth: 190, marginTop:6, zIndex:20,
            background:'var(--surface)', border:'1px solid var(--border)', borderRadius:10,
            boxShadow:'0 8px 24px rgba(0,0,0,.25)', overflow:'hidden',
          }}>
            {head('Ozon')}
            {SHOPS.filter(x => x.platform === 'ozon').map(x => {
              const off = x.id !== 'defly' && conn && conn[x.id] === false;
              return item(x, off, off ? 'не подключён' : null);
            })}
            {head('WB')}
            <div style={{ padding:'5px 12px 8px', fontSize:12, color:'var(--text3)' }}>скоро</div>
            <div style={{ height:1, background:'var(--border)' }} />
            {item(shopOf('licio'), false, 'WB + Ozon')}
          </div>
        )}
      </div>
      <nav style={{ flex:1, padding: mini ? '4px 6px' : '4px 8px', overflowY:'auto', overflowX:'hidden' }}>
        {nav.map(([id,icon,label]) => id === '__h' ? (
          mini ? <div key={'h' + icon} style={{ height:1, background:'var(--border)', margin:'8px 6px' }} title={icon} />
            : <div key={'h' + icon} style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text3)', padding:'10px 12px 4px' }}>{icon}</div>
        ) : (
          <button key={id} onClick={() => setPage(id)} title={mini ? label : undefined} style={{
            display:'flex', alignItems:'center', justifyContent: mini ? 'center' : 'flex-start', gap:9, width:'100%', padding: mini ? '7px 0' : '7px 12px', borderRadius:8,
            border:'none', marginBottom:2, background:page===id?'var(--surface2)':'transparent', position:'relative',
            color:page===id?'var(--text)':'var(--text2)', fontWeight:page===id?600:400, fontSize:13, textAlign:'left', transition:'all .12s', whiteSpace:'nowrap',
          }}>
            <span style={{ fontSize: mini ? 17 : 15 }}>{icon}</span>{!mini && label}
            {page===id && <span style={{ marginLeft:'auto', width:3, height:16, borderRadius:2, background:'var(--accent-wb)', ...(mini ? { position:'absolute', right:2 } : {}) }}/>}
          </button>
        ))}
      </nav>
      <div style={{ padding: mini ? '10px 6px' : '10px 12px', borderTop:'1px solid var(--border)', display:'flex', flexDirection: mini ? 'column' : 'row', alignItems:'center', gap:8 }}>
        <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Переключить тему" style={{
          display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:8, border:'1px solid var(--border)',
          background:'var(--surface2)', color:'var(--text2)', fontSize:12.5, cursor:'pointer',
        }}>
          <span style={{ fontSize:14 }}>{theme === 'dark' ? '☀️' : '🌙'}</span>{!mini && (theme === 'dark' ? 'Светлая тема' : 'Тёмная тема')}
        </button>
        {!mobile && <button onClick={() => setMini(m => !m)} title={mini ? 'Развернуть меню' : 'Свернуть меню — оставить только значки'} style={{
          marginLeft: mini ? 0 : 'auto', padding:'6px 8px', borderRadius:8, border:'1px solid var(--border)', background:'transparent',
          color:'var(--text2)', fontSize:13, cursor:'pointer', lineHeight:1,
        }}>{mini ? '»' : '«'}</button>}
      </div>
    </div>
  );
}
