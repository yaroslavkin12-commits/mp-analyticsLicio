import React, { useState, useEffect, useCallback } from 'react';
import { getTrackedArticles, getTrackedArticlesFeed, addTrackedArticle, removeTrackedArticle } from '../api';

// Вкладка "Уведомления": добавляешь артикул — как только по нему поступает
// новый заказ (WB и/или Ozon), в Telegram приходит сообщение (см. backend
// collectors/trackedArticles.js, вызывается из collectors/wb/orders.js и
// collectors/ozon/orders.js). Пока привязано к кабинету Licio — там же, где
// идёт обычный сбор заказов.

const TABS = [['articles', 'Мои артикулы'], ['feed', 'Лента уведомлений']];

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-di� �', month: '2-di� �', hour: '2-di� �', minute: '2-di� �' });
}

function PlatformBadge({ platform }) {
  return (
    <span style={{
      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 5, color: '#fff', flexShrink: 0,
      background: platform === 'wb' ? 'var(--accent-wb)' : 'var(--accent-oz)',
    }}>
      {platform === 'wb' ? 'WB' : 'OZON'}
    </span>
  );
}

export default function TrackedArticles({ cabinet }) {
  const [tab, setTab] = useState('articles');
  const [items, setItems] = useState([]);
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState('wb');
  const [article, setArticle] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getTrackedArticles(cabinet);
      setItems(data.data || []);
    } finally {
      setLoading(false);
    }
  }, [cabinet]);

  const loadFeed = useCallback(async () => {
    const { data } = await getTrackedArticlesFeed(cabinet);
    setFeed(data.data || []);
  }, [cabinet]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'feed') loadFeed(); }, [tab, loadFeed]);

  async function onAdd(e) {
    e.preventDefault();
    if (!article.trim()) return;
    setSaving(true);
    setError('');
    try {
      await addTrackedArticle(cabinet, platform, article.trim(), label.trim() || null);
      setArticle('');
      setLabel('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || 'Не удалось добавить');
    } finally {
      setSaving(false);
    }
  }

  async function onRemove(id) {
    await removeTrackedArticle(cabinet, id);
    await load();
  }

  return (
    <div>
      <h2 style={{ margin: '0 0 16px', fontSize: 20 }}>Уведомления о заказах</h2>

      <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3, width: 'fit-content', marginBottom: 18 }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{
            padding: '6px 14px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500,
            background: tab === v ? 'var(--accent-wb)' : 'transparent', color: tab === v ? '#fff' : 'var(--text2)',
          }}>{l}</button>
        ))}
      </div>

      {tab === 'articles' && (
        <>
          <form onSubmit={onAdd} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
            <select value={platform} onChange={e => setPlatform(e.target.value)} style={selStyle}>
              <option value="wb">Wildberries</option>
              <option value="ozon">Ozon</option>
            </select>
            <input
              placeholder={platform === 'wb' ? 'Артикул WB или артикул продавца' : 'offer_id или SKU'}
              value={article} onChange={e => setArticle(e.target.value)} style={inpStyle}
            />
            <input placeholder="Название (необязательно)" value={label} onChange={e => setLabel(e.target.value)} style={inpStyle} />
            <button type="submit" disabled={saving} style={btnStyle}>Добавить</button>
          </form>
          {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

          {loading ? (
            <div style={{ color: 'var(--text3)' }}>Загрузка…</div>
          ) : !items.length ? (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>Пока нет отслеживаемых артикулов — добавьте первый выше.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {items.map(it => (
                <div key={it.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
                }}>
                  <PlatformBadge platform={it.platform} />
                  <span style={{ fontWeight: 600 }}>{it.article}</span>
                  {it.label && <span style={{ color: 'var(--text3)' }}>{it.label}</span>}
                  <button onClick={() => onRemove(it.id)} title="Убрать" style={{
                    marginLeft: 'auto', background: 'transparent', border: 'none',
                    color: 'var(--text3)', cursor: 'pointer', fontSize: 17, lineHeight: 1,
                  }}>×</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.6 }}>
            Как только по добавленному артикулу поступит новый заказ, в Telegram придёт уведомление. Для WB можно
            указать как числовой артикул WB, так и свой "Артикул продавца". Для Ozon — offer_id (свой код товара) или SKU.
          </div>
        </>
      )}

      {tab === 'feed' && (
        !feed.length ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>Уведомлений пока не было.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {feed.map(f => (
              <div key={f.id} style={{ padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 13 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <PlatformBadge platform={f.platform} />
                  <b>{f.label || f.article}</b>
                  <span style={{ marginLeft: 'auto', color: 'var(--text3)', fontSize: 12 }}>{fmtDateTime(f.sent_at)}</span>
                </div>
                {f.product_name && <div style={{ color: 'var(--text2)', marginTop: 4 }}>{f.product_name}</div>}
                {f.price != null && Number(f.price) > 0 && (
                  <div style={{ color: 'var(--text3)', marginTop: 2 }}>{Math.round(Number(f.price)).toLocaleString('ru-RU')} ₽</div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

const inpStyle = { padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 180 };
const selStyle = { ...inpStyle, minWidth: 140 };
const btnStyle = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent-wb)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
