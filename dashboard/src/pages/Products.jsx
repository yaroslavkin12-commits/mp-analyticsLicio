import React, { useState, useEffect } from 'react';
import { getProducts } from '../api';

export default function Products({ platform, dateFrom, dateTo }) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('wb');

  useEffect(() => {
    setLoading(true);
    getProducts({ platform, dateFrom, dateTo }).then(r => setData(r.data.data||{})).catch(console.error).finally(() => setLoading(false));
  }, [platform, dateFrom, dateTo]);

  const activeTab = platform !== 'all' ? platform : tab;
  const items = data[activeTab] || [];

  const Th = ({ children }) => <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text2)', fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }}>{children}</th>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 17, fontWeight: 700 }}>Аналитика по товарам</h1>
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>🔴 красный фон — слабые товары (ДРР {'>'} 30% или маржа {'<'} 0)</span>
      </div>

      {platform === 'all' && (
        <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3, width: 'fit-content' }}>
          {[['wb','var(--accent-wb)','Wildberries'],['ozon','var(--accent-oz)','Ozon']].map(([v,c,l]) => (
            <button key={v} onClick={() => setTab(v)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500, background: activeTab===v ? c : 'transparent', color: activeTab===v ? '#fff' : 'var(--text2)' }}>{l}</button>
          ))}
        </div>
      )}

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка...</div>
          : items.length === 0 ? <div style={{ padding: 40, textAlign: 'center', color: 'var(--text2)' }}>Нет данных за выбранный период</div>
          : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  {['Артикул','Товар','Продажи','Выручка','К выплате','Реклама','ДРР','Себест.','Маржа'].map(h => <Th key={h}>{h}</Th>)}
                </tr>
              </thead>
              <tbody>
                {items.map((p, i) => {
                  const revenue = Number(p.revenue||0), payout = Number(p.payout||0);
                  const adSpend = Number(p.ad_spend||0), cost = Number(p.cost_price||0);
                  const drr = revenue > 0 ? adSpend/revenue*100 : 0;
                  const margin = cost > 0 && revenue > 0 ? (payout - cost*Number(p.sales_count||0) - adSpend)/revenue*100 : null;
                  const isWeak = drr > 30 || (margin !== null && margin < 0);
                  const color = activeTab === 'wb' ? 'var(--accent-wb)' : 'var(--accent-oz)';
                  return (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)', background: isWeak ? 'rgba(239,68,68,.05)' : 'transparent' }}>
                      <td style={{ padding: '9px 12px', color, fontWeight: 600 }}>{p.article||p.offer_id}</td>
                      <td style={{ padding: '9px 12px', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.subject||p.product_name}>{p.subject||p.product_name||'—'}</td>
                      <td style={{ padding: '9px 12px', color: 'var(--text2)' }}>{p.sales_count||0}</td>
                      <td style={{ padding: '9px 12px', fontWeight: 500 }}>{Math.round(revenue).toLocaleString('ru')} ₽</td>
                      <td style={{ padding: '9px 12px' }}>{Math.round(payout).toLocaleString('ru')} ₽</td>
                      <td style={{ padding: '9px 12px', color: adSpend > 0 ? 'var(--text)' : 'var(--text3)' }}>{adSpend > 0 ? Math.round(adSpend).toLocaleString('ru')+' ₽' : '—'}</td>
                      <td style={{ padding: '9px 12px', color: drr > 30 ? 'var(--danger)' : drr > 15 ? 'var(--warn)' : 'var(--ok)', fontWeight: 600 }}>{drr.toFixed(1)}%</td>
                      <td style={{ padding: '9px 12px', color: cost > 0 ? 'var(--text)' : 'var(--text3)' }}>{cost > 0 ? Math.round(cost).toLocaleString('ru')+' ₽' : '—'}</td>
                      <td style={{ padding: '9px 12px' }}>
                        {margin !== null
                          ? <span style={{ color: margin < 0 ? 'var(--danger)' : margin < 10 ? 'var(--warn)' : 'var(--ok)', fontWeight: 600 }}>{margin.toFixed(1)}%</span>
                          : <span style={{ color: 'var(--text3)' }}>нет себест.</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
