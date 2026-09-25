import React, { useState, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import {
  getDiscounts, getDiscountsSummary, getDiscountsFeed, getDiscountSettings, saveDiscountSettings,
} from '../api';

// Соинвест Ozon (аналог СПП на Wildberries) — маркетплейс сам доплачивает
// часть скидки покупателю за счёт своей комиссии. Разница между ценой
// продавца и ценой на витрине — это и есть размер Соинвеста. Сюда попадают
// только реальные ИЗМЕНЕНИЯ этого процента (см. backend
// collectors/ads/ozonDiscounts.js) — история копится с момента первого
// сбора, задача проверяет изменения каждые ~20 минут, а при значимом сдвиге
// уходит уведомление в Telegram.
//
// Вкладки "Уведомления" и "Настройки" — по образцу СПП-монитора TrueStats:
// общая лента изменений по всем артикулам, ежедневный дайджест, порог
// срабатывания и тихие часы (backend: routes/ads.js /discounts/feed и
// /discounts/settings, collectors/ads/discountSettings.js).

const DAYS_OPTIONS = [['1', '1 д'], ['7', '7 д'], ['30', '30 д'], ['90', '90 д']];
const TABS = [['articles', 'Мои артикулы'], ['feed', 'Уведомления'], ['settings', 'Настройки']];

function fmtPct(v) { return `${v > 0 ? v.toFixed(1) : '0.0'}%`; }
function fmtMoney(v) { return `${Math.round(v).toLocaleString('ru-RU')} ₽`; }
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ChangeBadge({ value }) {
  if (!value) return <span style={{ color: 'var(--text3)' }}>—</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? 'var(--ok, #10b981)' : 'var(--danger, #ef4444)', fontWeight: 600 }}>
      {up ? '▲' : '▼'} {Math.abs(value).toFixed(1)} п.п.
    </span>
  );
}

function SummaryTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{new Date(label).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}</div>
      <div style={{ fontWeight: 600 }}>{p.avgPct.toFixed(1)}% средняя скидка</div>
      <div style={{ color: 'var(--text3)' }}>{p.articles} артикулов</div>
    </div>
  );
}

function DaysSwitch({ days, setDays }) {
  return (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3 }}>
      {DAYS_OPTIONS.map(([v, l]) => (
        <button key={v} onClick={() => setDays(v)} style={{
          padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 12.5, fontWeight: 500,
          background: days === v ? 'var(--accent-oz)' : 'transparent', color: days === v ? '#fff' : 'var(--text2)',
        }}>{l}</button>
      ))}
    </div>
  );
}

function ArticleHistory({ history }) {
  const last20 = [...history].reverse().slice(0, 20);
  return (
    <div style={{ marginTop: 8, padding: '10px 14px', background: 'var(--surface2)', borderRadius: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6 }}>История изменений (последние {last20.length})</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ color: 'var(--text3)', textAlign: 'left' }}>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Когда</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Соинвест</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Цена продавца</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>Цена на сайте</th>
            <th style={{ padding: '3px 8px', fontWeight: 500 }}>С Ozon Картой</th>
          </tr>
        </thead>
        <tbody>
          {last20.map((h, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtDateTime(h.at)}{h.source && h.source !== 'public_page' ? ' *' : ''}</td>
              <td style={{ padding: '4px 8px', fontWeight: 600 }}>{fmtPct(h.pct)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtMoney(h.price)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{fmtMoney(h.marketingPrice)}</td>
              <td style={{ padding: '4px 8px', color: 'var(--text2)' }}>{h.ozonCardPrice ? fmtMoney(h.ozonCardPrice) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryChart({ summary, loading }) {
  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text2)' }}>Загрузка…</div>;
  const series = summary?.series || [];
  if (!series.length) return <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>Нет данных за выбранный период</div>;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="day" tickFormatter={d => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
          stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
        <YAxis stroke="var(--text3)" fontSize={11} tickLine={false} axisLine={false} width={40}
          tickFormatter={v => `${v}%`} domain={['dataMin - 2', 'dataMax + 2']} />
        <Tooltip content={<SummaryTooltip />} cursor={{ fill: 'var(--surface2)' }} />
        <Bar dataKey="avgPct" radius={[4, 4, 0, 0]}>
          {series.map((s, i) => <Cell key={i} fill={s.day === today ? 'var(--accent-oz-light, #93c5fd)' : 'var(--accent-oz)'} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ArticlesTab({ cabinet, days, setDays }) {
  const [data, setData] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    setLoading(true); setSummaryLoading(true);
    getDiscounts(cabinet, days).then(r => { setData(r.data.data); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
    getDiscountsSummary(cabinet, days).then(r => setSummary(r.data.data))
      .catch(() => setSummary(null))
      .finally(() => setSummaryLoading(false));
  }, [cabinet, days]);

  useEffect(() => { load(); }, [load]);

  const articles = (data?.articles || []).filter(a =>
    !search || a.offerId.toLowerCase().includes(search.toLowerCase()) ||
    (a.productName || '').toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <DaysSwitch days={days} setDays={setDays} />
        <input
          value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по артикулу…"
          style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 200 }}
        />
        <button onClick={load} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)',
          background: 'var(--surface2)', color: 'var(--text2)', fontSize: 12.5 }}>Обновить</button>
      </div>

      {/* Сводные метрики + график средней скидки по дням — как в СПП-мониторе TrueStats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
        {[
          ['На мониторинге', summary ? summary.totalArticles : '—'],
          ['Средняя скидка', summary ? fmtPct(summary.currentAvgPct) : '—'],
          ['Изменений за 24ч', summary ? summary.changes24h : '—'],
          ['Артикулов с данными', data ? data.articles.length : '—'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '12px 16px' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 10 }}>Средняя скидка покупателя</div>
        <SummaryChart summary={summary} loading={summaryLoading} />
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.5 }}>
        Соинвест — доля скидки, которую Ozon покрывает сам за счёт своей комиссии (аналог СПП на Wildberries).
        Разница между ценой продавца и ценой на витрине для покупателя. Показаны только реальные изменения
        процента — таблица обновляется примерно раз в 20 минут; при резком сдвиге приходит уведомление в Telegram.
        Значок «≈» — не удалось получить цену с публичной страницы товара, показана приблизительная оценка без реальной цены на сайте.
      </div>

      {loading && !data && <div style={{ color: 'var(--text3)' }}>Загрузка…</div>}
      {error && <div style={{ color: 'var(--danger, #ef4444)' }}>Ошибка: {error}</div>}

      {data && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--surface2)', textAlign: 'left', color: 'var(--text3)', fontSize: 11.5 }}>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Артикул</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Текущий Соинвест</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>За 24ч</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Мин / Макс за период</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Цена покупателя</th>
                <th style={{ padding: '8px 14px', fontWeight: 500 }}>Изменений</th>
              </tr>
            </thead>
            <tbody>
              {articles.map(a => (
                <React.Fragment key={a.offerId}>
                  <tr
                    onClick={() => setExpanded(e => e === a.offerId ? null : a.offerId)}
                    style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                  >
                    <td style={{ padding: '9px 14px' }}>
                      <div style={{ fontWeight: 600 }}>{a.offerId}</div>
                      {a.productName && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>{a.productName.slice(0, 60)}</div>}
                    </td>
                    <td style={{ padding: '9px 14px', fontWeight: 700, fontSize: 14 }}>
                      {a.current ? fmtPct(a.current.pct) : '—'}
                      {a.isEstimate && <span title="Не удалось получить цену с публичной страницы товара — это приблизительная оценка без реальной цены на сайте" style={{ marginLeft: 4, fontSize: 11, fontWeight: 400, color: 'var(--text3)' }}>≈</span>}
                    </td>
                    <td style={{ padding: '9px 14px' }}><ChangeBadge value={a.changes24h} /></td>
                    <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{fmtPct(a.minPct)} / {fmtPct(a.maxPct)}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--text2)' }}>{a.current ? fmtMoney(a.current.marketingPrice) : '—'}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--text3)' }}>{a.changesCount}</td>
                  </tr>
                  {expanded === a.offerId && (
                    <tr>
                      <td colSpan={6} style={{ padding: '0 14px 12px' }}>
                        <ArticleHistory history={a.history} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {!articles.length && (
                <tr><td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>
                  Пока нет данных — сборщик Соинвеста ещё не успел собрать первую историю (или ничего не изменилось за выбранный период).
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FeedTab({ cabinet, days, setDays }) {
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    getDiscountsFeed(cabinet, days).then(r => { setFeed(r.data.data.feed); setError(null); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [cabinet, days]);

  // Группируем по дате для читаемости, как в ленте TrueStats.
  const groups = [];
  for (const item of feed || []) {
    const day = new Date(item.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    let g = groups.find(g => g.day === day);
    if (!g) { g = { day, items: [] }; groups.push(g); }
    g.items.push(item);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <DaysSwitch days={days} setDays={setDays} />
      </div>

      {loading && <div style={{ color: 'var(--text3)' }}>Загрузка…</div>}
      {error && <div style={{ color: 'var(--danger, #ef4444)' }}>Ошибка: {error}</div>}

      {!loading && !groups.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12 }}>
          Пока нет изменений за выбранный период.
        </div>
      )}

      {groups.map(g => (
        <div key={g.day} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.4 }}>{g.day}</div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            {g.items.map((it, i) => {
              const up = it.pct > it.prevPct;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', fontSize: 13,
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}>
                  <div style={{ color: 'var(--text3)', fontSize: 12, width: 44, flexShrink: 0 }}>
                    {new Date(it.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {it.productName ? `${it.offerId} · ${it.productName}` : it.offerId}
                    </div>
                  </div>
                  <div style={{ color: up ? 'var(--ok, #10b981)' : 'var(--danger, #ef4444)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmtPct(it.prevPct)} → {fmtPct(it.pct)} {up ? '▲' : '▼'}
                  </div>
                  <div style={{ color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                    витрина {fmtMoney(it.marketingPrice)}{it.ozonCardPrice ? `, с картой ${fmtMoney(it.ozonCardPrice)}` : ''}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <button onClick={() => onChange(!value)} style={{
      width: 40, height: 22, borderRadius: 11, border: 'none', position: 'relative', flexShrink: 0,
      background: value ? 'var(--accent-oz)' : 'var(--surface2)', transition: 'background .15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: value ? 20 : 2, width: 18, height: 18, borderRadius: '50%',
        background: '#fff', transition: 'left .15s',
      }} />
    </button>
  );
}

function SettingsTab({ cabinet }) {
  const [settings, setSettingsState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getDiscountSettings(cabinet).then(r => setSettingsState(r.data.data)).catch(() => {});
  }, [cabinet]);

  function patch(p) { setSettingsState(s => ({ ...s, ...p })); setSaved(false); }

  function save() {
    setSaving(true);
    saveDiscountSettings(cabinet, settings)
      .then(r => { setSettingsState(r.data.data); setSaved(true); })
      .finally(() => setSaving(false));
  }

  if (!settings) return <div style={{ color: 'var(--text3)' }}>Загрузка…</div>;

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 14, maxWidth: 520 };
  const label = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const hint = { fontSize: 11.5, color: 'var(--text3)', marginTop: 6, lineHeight: 1.4 };

  return (
    <div>
      <div style={card}>
        <div style={label}>Порог изменения Соинвеста</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="range" min={0.5} max={10} step={0.5} value={settings.thresholdPct}
            onChange={e => patch({ thresholdPct: Number(e.target.value) })} style={{ flex: 1 }} />
          <div style={{ fontWeight: 700, width: 56, textAlign: 'right' }}>{settings.thresholdPct.toFixed(1)} п.п.</div>
        </div>
        <div style={hint}>Уведомление придёт, если Соинвест изменится на этот порог и больше.</div>
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Toggle value={settings.quietEnabled} onChange={v => patch({ quietEnabled: v })} />
          <div style={label}>Тихий режим</div>
        </div>
        <div style={hint}>Ночью уведомления по конкретным изменениям не приходят — их подберёт утренний дайджест (если включён).</div>
        {settings.quietEnabled && (
          <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>С</div>
              <input type="time" value={settings.quietStart} onChange={e => patch({ quietStart: e.target.value })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
            </div>
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>До</div>
              <input type="time" value={settings.quietEnd} onChange={e => patch({ quietEnd: e.target.value })}
                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
            </div>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Toggle value={settings.digestEnabled} onChange={v => patch({ digestEnabled: v })} />
          <div style={label}>Ежедневный дайджест</div>
        </div>
        <div style={hint}>Топ-3 изменения за сутки одним сообщением в Telegram, во сколько удобно.</div>
        {settings.digestEnabled && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>Время</div>
            <input type="time" value={settings.digestTime} onChange={e => patch({ digestTime: e.target.value })}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }} />
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>Таймзона</div>
          <select value={settings.timezone} onChange={e => patch({ timezone: e.target.value })}
            style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)' }}>
            <option value="Europe/Moscow">Europe/Moscow</option>
            <option value="Europe/Kaliningrad">Europe/Kaliningrad</option>
            <option value="Asia/Yekaterinburg">Asia/Yekaterinburg</option>
            <option value="Asia/Novosibirsk">Asia/Novosibirsk</option>
            <option value="Asia/Vladivostok">Asia/Vladivostok</option>
          </select>
          <div style={hint}>Влияет на тихий режим и время дайджеста.</div>
        </div>
      </div>

      <button onClick={save} disabled={saving} style={{
        padding: '9px 18px', borderRadius: 8, border: 'none', background: 'var(--accent-oz)', color: '#fff',
        fontSize: 13.5, fontWeight: 600, opacity: saving ? 0.6 : 1,
      }}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
      {saved && <span style={{ marginLeft: 10, color: 'var(--ok, #10b981)', fontSize: 13 }}>Сохранено ✓</span>}
    </div>
  );
}

export default function Discounts({ cabinet }) {
  const [tab, setTab] = useState('articles');
  const [days, setDays] = useState('30');

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Соинвест Ozon</h2>
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              padding: '6px 4px', border: 'none', background: 'transparent', fontSize: 13.5,
              fontWeight: tab === id ? 600 : 400, color: tab === id ? 'var(--text)' : 'var(--text2)',
              borderBottom: tab === id ? '2px solid var(--accent-oz)' : '2px solid transparent',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'articles' && <ArticlesTab cabinet={cabinet} days={days} setDays={setDays} />}
      {tab === 'feed' && <FeedTab cabinet={cabinet} days={days} setDays={setDays} />}
      {tab === 'settings' && <SettingsTab cabinet={cabinet} />}
    </div>
  );
}
