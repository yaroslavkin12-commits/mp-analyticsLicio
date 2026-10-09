import React, { useState, useEffect, useCallback } from 'react';
import {
  getTrackedArticles, getTrackedArticlesFeed, addTrackedArticle, removeTrackedArticle,
  moveTrackedArticle, getTrackedGroups, addTrackedGroup, removeTrackedGroup,
  getNotificationsHealth, testTelegram,
} from '../api';

// Строка состояния: настроен ли Telegram, приходят ли заказы из
// Google-таблицы (вкладка Orders, её обновляет скрипт каждые 5 минут) и
// когда их последний раз проверяли. Плюс кнопка пробного сообщения.
function HealthBar({ cabinet }) {
  const [h, setH] = useState(null);
  const [testMsg, setTestMsg] = useState('');
  useEffect(() => {
    getNotificationsHealth(cabinet).then(r => setH(r.data.data)).catch(() => setH(null));
  }, [cabinet]);
  async function onTest() {
    setTestMsg('Отправляю…');
    try {
      const r = await testTelegram();
      setTestMsg(r.data.data.sent ? 'Отправлено — проверьте Telegram' : 'Telegram не настроен на сервере');
    } catch (e) { setTestMsg(`Ошибка: ${e.response?.data?.error || e.message}`); }
  }
  if (!h) return null;
  const ok = c => ({ color: c ? 'var(--ok)' : 'var(--danger)' });
  const sheetOk = h.ordersSheet.rows !== null && !h.ordersSheet.error;
  const last = h.lastCheck?.last_success_at;
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, color: 'var(--text2)',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16 }}>
      <span style={ok(h.telegramConfigured)}>● Telegram {h.telegramConfigured ? 'подключён' : 'не настроен (нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID на сервере)'}</span>
      <span style={ok(sheetOk && h.ordersSheet.rows > 0)}>
        ● Заказы Ozon из таблицы: {h.ordersSheet.error ? `ошибка (${h.ordersSheet.error})` : h.ordersSheet.rows === null ? 'вкладки Orders ещё нет — обновите Google-скрипт и выполните setupTriggers'
          : h.ordersSheet.rows === 0 ? 'пока пусто — обновите Google-скрипт и выполните setupTriggers' : `${h.ordersSheet.rows} строк, последний заказ ${h.ordersSheet.newestOrderAt ? fmtDateTime(h.ordersSheet.newestOrderAt) : '—'}`}
      </span>
      <span>Проверка заказов: {last ? fmtDateTime(last) : 'ещё не было'}</span>
      <button onClick={onTest} style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 12.5 }}>
        Проверить Telegram
      </button>
      {testMsg && <span>{testMsg}</span>}
    </div>
  );
}

// Вкладка "Уведомления": добавляешь артикул — как только по нему поступает
// новый заказ (WB и/или Ozon), в Telegram приходит сообщение (см. backend
// collectors/trackedArticles.js, вызывается из collectors/wb/orders.js,
// collectors/ozon/orders.js — кабинет Licio — и collectors/trackedOrdersPoll.js
// — кабинеты без общего сбора заказов, сейчас Defly).
//
// Тестируемые группы — опциональная группировка артикулов (например
// "Чехлы"): сверху — сводка по группе целиком (сколько заказов по всем
// артикулам группы), ниже — каждый артикул отдельно со своим счётчиком.

const TABS = [['articles', 'Мои артикулы'], ['feed', 'Лента уведомлений']];

function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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

function OrderCountBadge({ count }) {
  const n = Number(count) || 0;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12,
      background: n > 0 ? 'rgba(124,92,255,.15)' : 'var(--surface2)',
      color: n > 0 ? 'var(--accent-wb)' : 'var(--text3)', flexShrink: 0,
    }}>
      {n} {n === 1 ? 'заказ' : n >= 2 && n <= 4 ? 'заказа' : 'заказов'}
    </span>
  );
}

function ArticleRow({ it, groups, onRemove, onMove }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <PlatformBadge platform={it.platform} />
      <span style={{ fontWeight: 600 }}>{it.article}</span>
      {it.label && <span style={{ color: 'var(--text3)' }}>{it.label}</span>}
      <OrderCountBadge count={it.order_count} />
      <select
        value={it.group_id || ''}
        onChange={e => onMove(it.id, e.target.value || null)}
        title="Перенести в группу"
        style={{ marginLeft: 'auto', ...miniSelStyle }}
      >
        <option value="">Без группы</option>
        {groups.map(g => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
      <button onClick={() => onRemove(it.id)} title="Убрать" style={{
        background: 'transparent', border: 'none',
        color: 'var(--text3)', cursor: 'pointer', fontSize: 17, lineHeight: 1,
      }}>×</button>
    </div>
  );
}

export default function TrackedArticles({ cabinet }) {
  const [tab, setTab] = useState('articles');
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState([]);
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState('wb');
  const [article, setArticle] = useState('');
  const [label, setLabel] = useState('');
  const [groupId, setGroupId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupSaving, setGroupSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: itemsRes }, { data: groupsRes }] = await Promise.all([
        getTrackedArticles(cabinet),
        getTrackedGroups(cabinet),
      ]);
      setItems(itemsRes.data || []);
      setGroups(groupsRes.data || []);
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
      await addTrackedArticle(cabinet, platform, article.trim(), label.trim() || null, groupId || null);
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

  async function onMove(id, newGroupId) {
    await moveTrackedArticle(cabinet, id, newGroupId);
    await load();
  }

  async function onAddGroup(e) {
    e.preventDefault();
    if (!groupName.trim()) return;
    setGroupSaving(true);
    try {
      await addTrackedGroup(cabinet, groupName.trim());
      setGroupName('');
      setShowGroupForm(false);
      await load();
    } finally {
      setGroupSaving(false);
    }
  }

  async function onRemoveGroup(id) {
    await removeTrackedGroup(cabinet, id);
    await load();
  }

  const grouped = groups.map(g => ({
    ...g,
    members: items.filter(it => String(it.group_id) === String(g.id)),
  }));
  const ungrouped = items.filter(it => !it.group_id);

  return (
    <div>
      <div className="page-sticky"><h2 style={{ margin: 0, fontSize: 20 }}>Уведомления о заказах</h2></div>
      <HealthBar cabinet={cabinet} />

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--text3)' }}>Тестируемые группы объединяют несколько артикулов в одну сводку.</span>
            <button onClick={() => setShowGroupForm(s => !s)} style={ghostBtnStyle}>
              {showGroupForm ? 'Отмена' : '+ Группа'}
            </button>
          </div>

          {showGroupForm && (
            <form onSubmit={onAddGroup} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                placeholder="Название группы, например «Чехлы»"
                value={groupName} onChange={e => setGroupName(e.target.value)}
                style={{ ...inpStyle, minWidth: 260 }} autoFocus
              />
              <button type="submit" disabled={groupSaving} style={btnStyle}>Создать</button>
            </form>
          )}

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
            <select value={groupId} onChange={e => setGroupId(e.target.value)} style={selStyle}>
              <option value="">Без группы</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <button type="submit" disabled={saving} style={btnStyle}>Добавить</button>
          </form>
          {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

          {loading ? (
            <div style={{ color: 'var(--text3)' }}>Загрузка…</div>
          ) : !items.length ? (
            <div style={{ color: 'var(--text3)', fontSize: 13 }}>Пока нет отслеживаемых артикулов — добавьте первый выше.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {grouped.map(g => (
                <div key={g.id}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6,
                    background: 'var(--surface2)', borderRadius: 8,
                  }}>
                    <span style={{ fontWeight: 700 }}>{g.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text3)' }}>{g.articles_count} артикулов</span>
                    <OrderCountBadge count={g.total_orders} />
                    <button onClick={() => onRemoveGroup(g.id)} title="Удалить группу (артикулы останутся)" style={{
                      marginLeft: 'auto', background: 'transparent', border: 'none',
                      color: 'var(--text3)', cursor: 'pointer', fontSize: 17, lineHeight: 1,
                    }}>×</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 14 }}>
                    {g.members.length
                      ? g.members.map(it => (
                          <ArticleRow key={it.id} it={it} groups={groups} onRemove={onRemove} onMove={onMove} />
                        ))
                      : <div style={{ color: 'var(--text3)', fontSize: 12.5 }}>В группе пока нет артикулов.</div>}
                  </div>
                </div>
              ))}

              {ungrouped.length > 0 && (
                <div>
                  {groups.length > 0 && (
                    <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 6, padding: '0 12px' }}>Без группы</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {ungrouped.map(it => (
                      <ArticleRow key={it.id} it={it} groups={groups} onRemove={onRemove} onMove={onMove} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 18, fontSize: 12.5, color: 'var(--text3)', lineHeight: 1.6 }}>
            Как только по добавленному артикулу поступит новый заказ, в Telegram придёт уведомление. Для WB можно
            указать как числовой артикул WB, так и свой "Артикул продавца". Для Ozon — offer_id (свой код товара) или SKU.
            Счётчик "заказов" у артикула и у группы — это количество уже поступивших заказов, которые были сопоставлены
            и привели к отправке уведомления.
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
const miniSelStyle = { ...inpStyle, minWidth: 130, padding: '5px 8px', fontSize: 12 };
const btnStyle = { padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--accent-wb)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtnStyle = { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
