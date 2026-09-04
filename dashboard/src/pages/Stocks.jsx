import React, { useState, useEffect, useMemo } from 'react';
import { getStocksV2 } from '../api';

const PLATFORMS = [['all','Все'],['wb','WB'],['ozon','Ozon']];
const FULFILLMENTS = [['all','FBO+FBS'],['fbo','FBO'],['fbs','FBS']];
const GENDERS = [['all','Все'],['Мужское','Мужское'],['Женское','Женское']];

// FBS — это один физический остаток на общем фулфилменте, который просто
// выгружается сразу на обе площадки (а не два независимых остатка, как
// FBO). Поэтому при platform === 'all' его нельзя складывать как
// wb_fbs + ozon_fbs — это задвоит цифру. Берём максимум из двух значений
// (площадки синкают выгрузку с небольшой задержкой друг относительно друга).
// При выборе конкретной площадки показываем то, что реально видно на ней.
function qtyOf(size, platform, fulfillment) {
  const wantFbo = fulfillment === 'all' || fulfillment === 'fbo';
  const wantFbs = fulfillment === 'all' || fulfillment === 'fbs';
  let v = 0;
  if (platform === 'all') {
    if (wantFbo) v += size.wb_fbo + size.ozon_fbo;
    if (wantFbs) v += Math.max(size.wb_fbs, size.ozon_fbs);
  } else if (platform === 'wb') {
    if (wantFbo) v += size.wb_fbo;
    if (wantFbs) v += size.wb_fbs;
  } else if (platform === 'ozon') {
    if (wantFbo) v += size.ozon_fbo;
    if (wantFbs) v += size.ozon_fbs;
  }
  return v;
}

function badge(qty) {
  if (qty === 0) return { label: '🔴 Нет',   color: 'var(--danger)', bg: 'rgba(239,68,68,.12)' };
  if (qty < 10)  return { label: '🟡 Мало',  color: 'var(--warn)',   bg: 'rgba(245,158,11,.12)' };
  return             { label: '🟢 Норма', color: 'var(--ok)',     bg: 'rgba(16,185,129,.12)' };
}

const SIZE_ORDER = ['XXS','XS','S','M','L','XL','XXL','2XL','3XL','4XL','5XL'];
function sizeRank(s) {
  const i = SIZE_ORDER.indexOf(String(s).toUpperCase());
  if (i !== -1) return i;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? 1000 + n : 2000;
}

function StatTile({ label, value }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', minWidth: 120 }}>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{value.toLocaleString('ru')}</div>
    </div>
  );
}

function Chip({ label, value }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface2)', borderRadius: 7, padding: '5px 10px', fontSize: 12 }}>
      <span style={{ color: 'var(--text2)' }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{value.toLocaleString('ru')}</span>
    </div>
  );
}

export default function Stocks({ platform: platformProp }) {
  const [raw, setRaw] = useState({ products: [], categories: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [platform, setPlatform] = useState(platformProp || 'all');
  const [fulfillment, setFulfillment] = useState('all');
  const [gender, setGender] = useState('all');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Общий переключатель площадки в шапке дашборда тоже должен управлять этой
  // страницей — но локальные кнопки ниже позволяют переопределить его здесь же.
  useEffect(() => { if (platformProp) setPlatform(platformProp); }, [platformProp]);

  useEffect(() => {
    setLoading(true);
    getStocksV2().then(r => setRaw(r.data.data || { products: [], categories: [] }))
      .catch(console.error).finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return raw.products
      .filter(p => category === 'all' || p.category === category)
      .filter(p => gender === 'all' || p.gender === gender)
      .filter(p => !s || p.baseArticle.toLowerCase().includes(s) || (p.subject || '').toLowerCase().includes(s))
      .map(p => {
        const sizes = [...p.sizes].sort((a, b) => sizeRank(a.size) - sizeRank(b.size));
        const total = sizes.reduce((sum, sz) => sum + qtyOf(sz, platform, fulfillment), 0);
        return { ...p, sizes, total };
      });
  }, [raw, search, category, gender, platform, fulfillment]);

  // Сводка по текущему набору строк (учитывает поиск/категорию/пол/площадку,
  // но ФБО и ФБС считаются независимо от переключателя ФБО/ФБС — чтобы всегда
  // было видно соотношение, а не только то, что выбрано в фильтре).
  const stats = useMemo(() => {
    let fbo = 0, fbs = 0;
    const byCategory = new Map();
    const byWarehouse = new Map();
    for (const p of rows) {
      let pFbo = 0, pFbs = 0;
      for (const sz of p.sizes) {
        pFbo += qtyOf(sz, platform, 'fbo');
        pFbs += qtyOf(sz, platform, 'fbs');
      }
      fbo += pFbo; fbs += pFbs;
      byCategory.set(p.category, (byCategory.get(p.category) || 0) + pFbo + pFbs);
      for (const w of p.wbFbsWarehouses) {
        byWarehouse.set(w.warehouse, (byWarehouse.get(w.warehouse) || 0) + w.qty);
      }
    }
    return {
      fbo, fbs, total: fbo + fbs, count: rows.length,
      categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
      warehouses: [...byWarehouse.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [rows, platform]);

  const footerTotal = useMemo(() => rows.reduce((sum, p) => sum + p.total, 0), [rows]);

  const toggle = article => setExpanded(prev => {
    const next = new Set(prev);
    next.has(article) ? next.delete(article) : next.add(article);
    return next;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Остатки</h1>
        <input placeholder="Поиск по артикулу или названию..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 260 }} />
        <select value={category} onChange={e => setCategory(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6 }}>
          <option value="all">Все категории</option>
          {raw.categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {PLATFORMS.map(([v, l]) => (
            <button key={v} onClick={() => setPlatform(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: platform === v ? 'var(--accent-wb)' : 'transparent', color: platform === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {FULFILLMENTS.map(([v, l]) => (
            <button key={v} onClick={() => setFulfillment(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: fulfillment === v ? 'var(--accent-wb)' : 'transparent', color: fulfillment === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
          {GENDERS.map(([v, l]) => (
            <button key={v} onClick={() => setGender(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: gender === v ? 'var(--accent-wb)' : 'transparent', color: gender === v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
      </div>

      {!loading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <StatTile label="Товаров" value={stats.count} />
            <StatTile label="Итого (ФБО+ФБС)" value={stats.total} />
            <StatTile label="ФБО" value={stats.fbo} />
            <StatTile label="ФБС" value={stats.fbs} />
          </div>

          <button
            onClick={() => setShowBreakdown(v => !v)}
            style={{ alignSelf: 'flex-start', border: 'none', background: 'transparent', color: 'var(--text2)', fontSize: 12, padding: '2px 0' }}
          >
            {showBreakdown ? '▾' : '▸'} Разбивка по категориям и складам ФБС
          </button>

          {showBreakdown && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {stats.categories.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {stats.categories.map(([cat, qty]) => <Chip key={cat} label={cat} value={qty} />)}
                </div>
              )}
              {stats.warehouses.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>ФБС по складам:</span>
                  {stats.warehouses.map(([wh, qty]) => <Chip key={wh} label={wh} value={qty} />)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка...</div>
          : rows.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--text2)' }}>Ничего не найдено</div>
          : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['', 'Фото', 'Артикул', 'Категория', 'Размеры', 'Итого', ''].map(h =>
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text2)', fontWeight: 500, fontSize: 12, borderBottom: '1px solid var(--border)' }}>{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const b = badge(p.total);
                const isOpen = expanded.has(p.baseArticle);
                return (
                  <React.Fragment key={p.baseArticle}>
                    <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--border)', cursor: 'pointer' }} onClick={() => toggle(p.baseArticle)}>
                      <td style={{ padding: '8px 12px', width: 20, color: 'var(--text2)' }}>{isOpen ? '▾' : '▸'}</td>
                      <td style={{ padding: '8px 12px' }}>
                        {p.photoUrl
                          ? <img
                              src={p.photoUrl}
                              alt=""
                              style={{ width: 40, height: 52, objectFit: 'cover', borderRadius: 6, background: 'var(--surface2)' }}
                              onError={e => {
                                if (p.photoUrlAlt && e.target.src !== p.photoUrlAlt) {
                                  e.target.src = p.photoUrlAlt;
                                } else {
                                  e.target.style.visibility = 'hidden';
                                }
                              }}
                            />
                          : <div style={{ width: 40, height: 52, borderRadius: 6, background: 'var(--surface2)' }} />}
                      </td>
                      <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                        {p.baseArticle}
                        <div style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 400, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.subject || '—'}{p.gender ? ` · ${p.gender}` : ''}</div>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{p.category || '—'}</td>
                      <td style={{ padding: '8px 12px', color: 'var(--text2)' }}>{p.sizes.length} размер(ов)</td>
                      <td style={{ padding: '8px 12px', fontWeight: 700 }}>{p.total}</td>
                      <td style={{ padding: '8px 12px' }}><span style={{ padding: '2px 8px', borderRadius: 5, fontSize: 11, fontWeight: 600, background: b.bg, color: b.color }}>{b.label}</span></td>
                    </tr>
                    {isOpen && (
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <td></td>
                        <td colSpan={6} style={{ padding: '4px 12px 14px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr style={{ color: 'var(--text2)' }}>
                                <th style={{ textAlign: 'left', padding: '4px 8px', fontWeight: 500 }}>Размер</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>WB FBO</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>WB FBS</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Ozon FBO</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Ozon FBS</th>
                                <th style={{ textAlign: 'right', padding: '4px 8px', fontWeight: 500 }}>Итого</th>
                              </tr>
                            </thead>
                            <tbody>
                              {p.sizes.map(sz => (
                                <tr key={sz.size}>
                                  <td style={{ padding: '3px 8px', fontWeight: 600 }}>{sz.size}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>{sz.wb_fbo}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>
                                    {sz.wb_fbs}
                                    {sz.fbs_mismatch && <span title={`Расхождение с Ozon FBS: ${sz.ozon_fbs}`} style={{ color: 'var(--warn)' }}> ⚠</span>}
                                  </td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>{sz.ozon_fbo}</td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right' }}>
                                    {sz.ozon_fbs}
                                    {sz.fbs_mismatch && <span title={`Расхождение с WB FBS: ${sz.wb_fbs}`} style={{ color: 'var(--warn)' }}> ⚠</span>}
                                  </td>
                                  <td style={{ padding: '3px 8px', textAlign: 'right', fontWeight: 700 }}>{qtyOf(sz, 'all', 'all')}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {p.wbFbsWarehouses.length > 0 && (
                            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text2)' }}>
                              FBS (общий остаток на фулфилменте) по складам: {p.wbFbsWarehouses.map(w => `${w.warehouse} — ${w.qty}`).join(', ')}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: 'var(--text2)', borderTop: '1px solid var(--border)' }}>Итого по фильтру:</td>
                <td style={{ padding: '10px 12px', fontWeight: 700, borderTop: '1px solid var(--border)' }}>{footerTotal.toLocaleString('ru')}</td>
                <td style={{ borderTop: '1px solid var(--border)' }}></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
