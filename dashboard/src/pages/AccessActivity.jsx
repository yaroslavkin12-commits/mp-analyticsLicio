import React, { useEffect, useState, useCallback } from 'react';
import dayjs from 'dayjs';
import { getAccessActivity } from '../api';
import { navLabel } from '../lib/navigation';
import { shopOf } from '../lib/cabinets';
const when = value => value ? dayjs(value).format('DD.MM.YYYY HH:mm:ss') : '—';
const duration = value => {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  const h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = n % 60;
  return h ? `${h} ч ${m} мин` : m ? `${m} мин ${s} с` : `${s} с`;
};
export default function AccessActivity() {
  const [days, setDays] = useState(7), [login, setLogin] = useState('');
  const [data, setData] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [tab, setTab] = useState('visits');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await getAccessActivity({ from: dayjs().startOf('day').subtract(days - 1, 'day').toISOString(), to: dayjs().startOf('day').add(1, 'day').toISOString() });
      setData(r.data.data); setError('');
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  }, [days]);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  const filtered = name => (data?.[name] || []).filter(u => !login || u.login === login);
  const allLogins = [...new Set([...(data?.summary || []).map(u => u.login), ...(data?.logins || []).map(u => u.login)])].sort();
  return <section className="a-card" style={{ padding: 16, marginBottom: 14 }}>
    <div className="a-bar" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
      <b style={{ fontSize: 16 }}>Посещения и активность</b><span className="a-hint">Доступно только вам · evgeniy</span>
      <div className="a-seg">{[[1, 'Сегодня'], [7, '7 дней'], [30, '30 дней']].map(([n, title]) => <button key={n} className={days === n ? 'on' : ''} onClick={() => setDays(n)}>{title}</button>)}</div>
      <select className="a-input" aria-label="Пользователь в журнале" value={login} onChange={e => setLogin(e.target.value)}><option value="">Все пользователи</option>{allLogins.map(l => <option key={l} value={l}>{l}</option>)}</select>
      <button className="a-btn ghost" onClick={load} disabled={loading}>{loading ? 'Обновление…' : 'Обновить'}</button>
    </div>
    <p className="a-hint">Активное время учитывает видимую вкладку и действия пользователя. После 5 минут без действий счётчик останавливается. Пересекающиеся интервалы нескольких вкладок объединяются в итогах пользователя. Это оценка активности, а не подтверждение рабочего времени.</p>
    {error && <div className="c-msg bad" role="alert">{error}</div>}{!data && !error && <p className="a-hint">Загружаем журнал…</p>}
    {data && <>
      <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Пользователь</th><th>Посещения</th><th>Активное время</th><th>Последняя связь</th><th>Сейчас</th></tr></thead><tbody>
        {filtered('summary').map(u => <tr key={u.login}><td><b>{u.name || u.login}</b><div className="a-hint">{u.login}</div></td><td>{u.visits}</td><td>{duration(u.active_seconds)}</td><td>{when(u.last_seen)}</td><td>{u.online ? <span className="s-up">Активен</span> : '—'}</td></tr>)}
        {!filtered('summary').length && <tr><td colSpan={5} className="muted">За этот период посещений нет.</td></tr>}
      </tbody></table></div>
      <div className="a-seg" style={{ margin: '16px 0 10px' }}><button className={tab === 'visits' ? 'on' : ''} onClick={() => setTab('visits')}>Посещения</button><button className={tab === 'logins' ? 'on' : ''} onClick={() => setTab('logins')}>Входы по паролю</button></div>
      {tab === 'visits' ? <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Пользователь</th><th>Открытие</th><th>Последняя связь</th><th>Вкладка открыта</th><th>Активно</th><th>Последний раздел</th><th>Состояние</th></tr></thead><tbody>
        {filtered('visits').map(v => <tr key={v.id}><td>{v.login}</td><td>{when(v.started_at)}</td><td>{when(v.last_seen_at)}</td><td>{duration(v.duration_seconds)}</td><td>{duration(v.active_seconds)}</td><td>{shopOf(v.cabinet)?.label || v.cabinet || '—'} · {navLabel(v.cabinet, v.page) || v.page || '—'}</td><td>{v.ended_at ? 'Завершено' : v.online ? (v.was_active ? 'Активен' : 'Без активности') : 'Нет связи'}</td></tr>)}
        {!filtered('visits').length && <tr><td colSpan={7} className="muted">Посещений пока нет.</td></tr>}
      </tbody></table></div> : <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Пользователь</th><th>Вход по паролю</th><th>Выход из аккаунта</th><th>Тип входа</th></tr></thead><tbody>
        {filtered('logins').map(v => <tr key={v.id}><td>{v.login}</td><td>{when(v.logged_in_at)}</td><td>{when(v.logged_out_at)}</td><td>{v.source === 'service-check' ? 'Служебная проверка' : 'Пользователь'}</td></tr>)}
        {!filtered('logins').length && <tr><td colSpan={4} className="muted">Входов по паролю за период нет. Сохранённая сессия позволяет открывать сервис без повторного ввода пароля.</td></tr>}
      </tbody></table></div>}
      <div className="a-hint" style={{ marginTop: 8 }}>В подробностях показаны последние {data.limit} записей; итоги считают весь выбранный период. История собирается с момента включения журнала.</div>
    </>}
  </section>;
}
