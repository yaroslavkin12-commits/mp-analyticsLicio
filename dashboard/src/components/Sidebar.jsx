import React, { useState, useRef, useEffect } from 'react';
import { SHOPS, shopOf, isDeflyLike } from '../lib/cabinets';
import { getAdsCabinets } from '../api';
import { Store, TrendingUp, Activity, ShoppingCart, Target, Receipt, ChartColumn, CalendarRange, Map as MapIcon, Megaphone, Search, BadgePercent,
  Warehouse, Scissors, PackageCheck, Layers, Tag, NotebookPen, Wallet, ScanSearch, Bell, Calculator, Boxes, Sun, Moon, ChevronsLeft, ChevronsRight } from 'lucide-react';

// Значки разделов меню (Lucide — один стиль, перекрашиваются вместе с темой). Licio — как было, эмодзи.
const ICONS = { summary: Store, sales: TrendingUp, rnp: Activity, orders: ShoppingCart, plan: Target, check: Receipt, abc: ChartColumn,
  season: CalendarRange, geo: MapIcon, ads: Megaphone, search: Search, discounts: BadgePercent, inventory: Warehouse, production: Scissors,
  buyout: PackageCheck, unit: Layers, margin: Tag, pricelog: NotebookPen, pnl: Wallet, recon: ScanSearch, notifications: Bell, calculator: Calculator, costs: Boxes };

const NAV_BY_CABINET = {
  licio: [['sales','📊','Аналитика продаж'],['ads','📣','Реклама'],['unit','📐','Юнит-экономика'],['pnl','💰','P&L'],['stocks','🏪','Остатки'],['discounts','💸','Соинвест'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['settings','⚙️','Настройки']],
  // Разделы меню Defly: заголовок раздела — ['__h', 'Название'].
  defly: [
    ['__h','Продажи'],['summary','🏬','Сводка по магазинам'],['sales','📈','Аналитика продаж'],['rnp','🩺','РНП'],['orders','🛒','Лента заказов'],['plan','🎯','План / факт'],['check','🧾','Средний чек'],['abc','🔤','ABC-анализ'],['season','🍂','Сезонность'],['geo','🗺️','География продаж'],
    ['__h','Реклама и поиск'],['ads','📣','Реклама'],['search','🔍','Позиции в поиске'],['discounts','💸','Соинвест'],
    ['__h','Склад'],['inventory','🏬','Остатки'],['production','🧵','Производство'],['buyout','📦','% выкупа'],
    ['__h','Деньги'],['unit','🧩','Юнит-экономика'],['margin','🏷️','Цены и маржа'],['pricelog','📝','Журнал цен'],['pnl','💰','P&L'],['recon','🔎','Сверка с Ozon'],
    ['__h','Инструменты'],['notifications','🔔','Уведомления'],['calculator','🧮','Калькулятор'],['costs','🧾','Товары'],
  ],
};
const navOf = c => NAV_BY_CABINET[c] || (isDeflyLike(c) ? NAV_BY_CABINET.defly : NAV_BY_CABINET.licio);
export const navLabel = (cabinet, page) => (navOf(cabinet).find(([id]) => id === page) || [])[2] || '';

// Значок магазина: логотип /logos/<id>.png (квадратный), пока его нет — цветной круг с буквой.
function ShopMark({ shop, size = 28 }) {
  const [bad, setBad] = useState(false);
  if (!shop) return null;
  if (!bad) return <img src={`/logos/${shop.id}.png`} alt="" onError={() => setBad(true)} style={{ width:size, height:size, borderRadius:7, objectFit:'cover', flexShrink:0, display:'block' }} />;
  return <span style={{ width:size, height:size, borderRadius:7, background:shop.color, color:'#fff', fontWeight:700, fontSize:Math.round(size * .55), display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>{shop.label[0]}</span>;
}

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
  const lucide = isDeflyLike(cabinet);
  // Какие магазины уже подключены (есть своя Google-таблица на сервере).
  const [conn, setConn] = useState(null);
  useEffect(() => { if (open && !conn) getAdsCabinets().then(r => setConn(Object.fromEntries((r.data.data || []).map(c => [c.id, c.connected !== false])))).catch(() => setConn({})); }, [open, conn]);
  const head = t => <div style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:'var(--text3)', padding:'9px 12px 3px' }}>{t}</div>;
  const item = (sh, disabled, note) => (
    <button key={sh.id} disabled={disabled} onClick={() => { setCabinet(sh.id); setOpen(false); }} title={disabled ? note : undefined} style={{
      display:'flex', alignItems:'center', gap:8, width:'100%', textAlign:'left', padding:'7px 12px', border:'none',
      background: cabinet===sh.id ? 'var(--surface2)' : 'transparent', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? .5 : 1,
      color: cabinet===sh.id ? 'var(--text)' : 'var(--text2)', fontWeight: cabinet===sh.id ? 600 : 400, fontSize:13,
    }}>
      <ShopMark shop={sh} size={18} /><span style={{ flex:1, whiteSpace:'nowrap' }}>{sh.label}</span>
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
          {isDeflyLike(cabinet) ? (
            <>
              <ShopMark key={cabinet} shop={shop} size={mini ? 30 : 28} />
              {!mini && <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:15, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>{cabinetLabel}<span style={{ fontSize:10, color:'var(--text3)' }}>▾</span></div>
                <div style={{ fontSize:11, color:'var(--text3)', marginTop:2 }}>Ozon</div>
              </div>}
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
            {lucide && ICONS[id]
              ? (() => { const I = ICONS[id]; return <I size={mini ? 18 : 16} strokeWidth={1.75} style={{ flexShrink:0, color: page===id ? 'var(--accent-wb)' : 'var(--text3)' }} />; })()
              : <span style={{ fontSize: mini ? 17 : 15 }}>{icon}</span>}{!mini && label}
            {page===id && <span style={{ marginLeft:'auto', width:3, height:16, borderRadius:2, background:'var(--accent-wb)', ...(mini ? { position:'absolute', right:2 } : {}) }}/>}
          </button>
        ))}
      </nav>
      <div style={{ padding: mini ? '10px 6px' : '10px 12px', borderTop:'1px solid var(--border)', display:'flex', flexDirection: mini ? 'column' : 'row', alignItems:'center', gap:8 }}>
        <button onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Переключить тему" style={{
          display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:8, border:'1px solid var(--border)',
          background:'var(--surface2)', color:'var(--text2)', fontSize:12.5, cursor:'pointer',
        }}>
          {lucide ? (theme === 'dark' ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />) : <span style={{ fontSize:14 }}>{theme === 'dark' ? '☀️' : '🌙'}</span>}{!mini && (theme === 'dark' ? 'Светлая тема' : 'Тёмная тема')}
        </button>
        {!mobile && <button onClick={() => setMini(m => !m)} title={mini ? 'Развернуть меню' : 'Свернуть меню — оставить только значки'} style={{
          marginLeft: mini ? 0 : 'auto', padding:'6px 8px', borderRadius:8, border:'1px solid var(--border)', background:'transparent',
          color:'var(--text2)', fontSize:13, cursor:'pointer', lineHeight:1, display:'flex', alignItems:'center',
        }}>{lucide ? (mini ? <ChevronsRight size={15} strokeWidth={1.75} /> : <ChevronsLeft size={15} strokeWidth={1.75} />) : (mini ? '»' : '«')}</button>}
      </div>
    </div>
  );
}
