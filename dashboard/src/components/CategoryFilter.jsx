import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';

export default function CategoryFilter({ dateFrom, dateTo, onFilter }) {
  const [categories, setCategories]   = useState([]);
  const [selCategory, setSelCategory] = useState('');
  const [selColor, setSelColor]       = useState('');
  const [selArticle, setSelArticle]   = useState('');
  const [open, setOpen]               = useState(false);
  const ref = useRef();

  useEffect(() => {
    axios.get('/api/analytics/ozon/categories', { params: { dateFrom, dateTo } })
      .then(r => setCategories(r.data.data || []))
      .catch(() => {});
  }, [dateFrom, dateTo]);

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const curCat    = categories.find(c => c.name === selCategory);
  const curColors = curCat?.colors || [];
  const curColor  = curColors.find(c => c.name === selColor);
  const curItems  = curColor?.items || [];

  function handleApply() {
    if (selArticle) {
      onFilter({ type: 'article', value: selArticle });
    } else if (selColor && curItems.length) {
      onFilter({ type: 'articles', value: curItems.map(i => i.offer_id).join(',') });
    } else if (selCategory && curCat) {
      const allIds = curCat.colors.flatMap(c => c.items.map(i => i.offer_id)).join(',');
      onFilter({ type: 'category', value: allIds, label: selCategory });
    } else {
      onFilter(null);
    }
    setOpen(false);
  }

  function reset() {
    setSelCategory(''); setSelColor(''); setSelArticle('');
    onFilter(null);
  }

  const label = selArticle ? `Артикул: ${selArticle}`
    : selColor   ? `${selCategory} / ${selColor}`
    : selCategory ? selCategory
    : 'Весь кабинет';

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <button onClick={() => setOpen(o=>!o)} style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 14px', border:'1px solid var(--border)', borderRadius:8,
        background: (selCategory||selColor||selArticle) ? 'rgba(0,91,255,0.15)' : 'var(--surface)',
        color: (selCategory||selColor||selArticle) ? 'var(--accent-oz)' : 'var(--text)',
        cursor:'pointer', fontSize:13, fontWeight:500, whiteSpace:'nowrap',
      }}>
        <span>🗂</span> {label} <span style={{ fontSize:10, color:'var(--text3)' }}>{open?'▲':'▼'}</span>
      </button>

      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:1000,
          background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12,
          padding:16, boxShadow:'0 8px 32px rgba(0,0,0,0.4)', minWidth:420,
        }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12 }}>
            {/* Категории */}
            <div>
              <div style={{ fontSize:11, color:'var(--text3)', fontWeight:600, marginBottom:8, textTransform:'uppercase' }}>Категория</div>
              <div style={{ display:'flex', flexDirection:'column', gap:3, maxHeight:240, overflowY:'auto' }}>
                <button onClick={() => { setSelCategory(''); setSelColor(''); setSelArticle(''); }}
                  style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                    background: !selCategory ? 'var(--accent-oz)' : 'var(--surface2)',
                    color: !selCategory ? '#fff' : 'var(--text2)', fontSize:12 }}>
                  Весь кабинет
                </button>
                {categories.map(c => (
                  <button key={c.name} onClick={() => { setSelCategory(c.name); setSelColor(''); setSelArticle(''); }}
                    style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                      background: selCategory===c.name ? 'var(--accent-oz)' : 'var(--surface2)',
                      color: selCategory===c.name ? '#fff' : 'var(--text2)', fontSize:12 }}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>

            {/* Цвета */}
            <div>
              <div style={{ fontSize:11, color:'var(--text3)', fontWeight:600, marginBottom:8, textTransform:'uppercase' }}>Цвет</div>
              {!selCategory ? (
                <div style={{ fontSize:12, color:'var(--text3)' }}>Сначала выберите категорию</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:3, maxHeight:240, overflowY:'auto' }}>
                  <button onClick={() => { setSelColor(''); setSelArticle(''); }}
                    style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                      background: !selColor ? 'var(--accent-oz)' : 'var(--surface2)',
                      color: !selColor ? '#fff' : 'var(--text2)', fontSize:12 }}>
                    Все цвета
                  </button>
                  {curColors.map(c => (
                    <button key={c.name} onClick={() => { setSelColor(c.name); setSelArticle(''); }}
                      style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                        background: selColor===c.name ? 'var(--accent-oz)' : 'var(--surface2)',
                        color: selColor===c.name ? '#fff' : 'var(--text2)', fontSize:12 }}>
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Артикулы */}
            <div>
              <div style={{ fontSize:11, color:'var(--text3)', fontWeight:600, marginBottom:8, textTransform:'uppercase' }}>Артикул (размер)</div>
              {!selColor ? (
                <div style={{ fontSize:12, color:'var(--text3)' }}>Сначала выберите цвет</div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:3, maxHeight:240, overflowY:'auto' }}>
                  <button onClick={() => setSelArticle('')}
                    style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                      background: !selArticle ? 'var(--accent-oz)' : 'var(--surface2)',
                      color: !selArticle ? '#fff' : 'var(--text2)', fontSize:12 }}>
                    Все размеры
                  </button>
                  {curItems.map(item => (
                    <button key={item.offer_id} onClick={() => setSelArticle(item.offer_id)}
                      style={{ textAlign:'left', padding:'5px 8px', border:'none', borderRadius:6, cursor:'pointer',
                        background: selArticle===item.offer_id ? 'var(--accent-oz)' : 'var(--surface2)',
                        color: selArticle===item.offer_id ? '#fff' : 'var(--text2)', fontSize:12 }}>
                      {item.offer_id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={{ display:'flex', gap:8, marginTop:14, justifyContent:'flex-end' }}>
            <button onClick={reset} style={{ padding:'6px 14px', border:'1px solid var(--border)', borderRadius:7, background:'transparent', color:'var(--text2)', cursor:'pointer', fontSize:13 }}>
              Сбросить
            </button>
            <button onClick={handleApply} style={{ padding:'6px 14px', border:'none', borderRadius:7, background:'var(--accent-oz)', color:'#fff', cursor:'pointer', fontSize:13, fontWeight:600 }}>
              Применить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
