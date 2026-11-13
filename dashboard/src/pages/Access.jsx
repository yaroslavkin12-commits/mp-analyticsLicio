import React, { useEffect, useState, useCallback } from 'react';
import dayjs from 'dayjs';
import { getMe, authLogout, changePassword, getAuthUsers, saveAuthUser, deleteAuthUser, getAuthKeys, createAuthKey, deleteAuthKey } from '../api';
import './ads2.css';

// «Доступ»: пользователи сервиса, ключи для расширения и смена своего пароля.
const err = e => e.response?.data?.error || e.message;
const when = v => (v ? dayjs(v).format('DD.MM.YYYY HH:mm') : '—');

export default function Access() {
  const [me, setMe] = useState(undefined);
  const [users, setUsers] = useState([]), [keys, setKeys] = useState([]);
  const [msg, setMsg] = useState(''), [bad, setBad] = useState('');
  const [nu, setNu] = useState({ login: '', name: '', password: '', role: 'user' });
  const [newKey, setNewKey] = useState(null), [keyName, setKeyName] = useState('Расширение «Соинвест»');
  const [pw, setPw] = useState({ current: '', next: '' });
  const say = (t, isBad) => { setMsg(isBad ? '' : t); setBad(isBad ? t : ''); };
  const load = useCallback(async () => {
    const m = (await getMe()).data.data; setMe(m);
    if (m?.role === 'admin' && m.auth) {
      const [u, k] = await Promise.all([getAuthUsers(), getAuthKeys()]);
      setUsers(u.data.data); setKeys(k.data.data);
    }
  }, []);
  useEffect(() => { load().catch(e => say(err(e), true)); }, [load]);
  const act = fn => async () => { try { await fn(); await load(); } catch (e) { say(err(e), true); } };

  if (me === undefined) return <div className="mpui"><div className="a-card" style={{ padding: 16 }}>Загрузка…</div></div>;
  if (!me?.auth) return <div className="mpui"><div className="a-top"><h1>Доступ</h1></div><div className="a-card" style={{ padding: 16 }}>На этом сервере вход по паролю выключен — сервис открыт всем, у кого есть ссылка. Вход включится на новом сервере.</div></div>;
  const admin = me.role === 'admin';
  return (
    <div className="mpui">
      <div className="page-sticky"><div className="a-top"><h1>Доступ</h1>
        <span className="a-hint">Вы вошли как <b>{me.name || me.login}</b>{admin ? ' · администратор' : ''}</span>
        <button className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={async () => { await authLogout().catch(() => {}); window.location.href = '/login'; }}>Выйти</button>
      </div></div>
      {msg && <div className="c-msg" role="status">{msg}</div>}{bad && <div className="c-msg bad" role="alert">{bad}</div>}

      {admin && <div className="a-card" style={{ padding: 16, marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Пользователи</b>
        <div className="a-hint" style={{ margin: '4px 0 10px' }}>Администратор управляет пользователями и ключами. Обычный пользователь видит и меняет данные сервиса, но не доступы.</div>
        <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Логин</th><th>Имя</th><th>Роль</th><th>Последний вход</th><th>Статус</th><th /></tr></thead><tbody>
          {users.map(u => <tr key={u.id}>
            <td><b>{u.login}</b></td><td>{u.name}</td>
            <td><select className="a-input" value={u.role} onChange={e => act(() => saveAuthUser({ id: u.id, role: e.target.value, disabled: u.disabled }))()}><option value="user">пользователь</option><option value="admin">администратор</option></select></td>
            <td>{when(u.last_login)}</td>
            <td>{u.disabled ? <span className="s-down">отключён</span> : 'активен'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="a-btn ghost" onClick={act(async () => { const p = window.prompt(`Новый пароль для ${u.login} (не короче 8 символов)`); if (!p) return; await saveAuthUser({ id: u.id, role: u.role, disabled: u.disabled, password: p }); say(`Пароль ${u.login} изменён, его сессии закрыты`); })}>Сменить пароль</button>
              <button className="a-btn ghost" onClick={act(() => saveAuthUser({ id: u.id, role: u.role, disabled: !u.disabled }))}>{u.disabled ? 'Включить' : 'Отключить'}</button>
              <button className="a-btn ghost" onClick={act(async () => { if (window.confirm(`Удалить пользователя ${u.login}?`)) await deleteAuthUser(u.id); })}>Удалить</button>
            </td></tr>)}
        </tbody></table></div>
        <div className="a-bar" style={{ marginTop: 10 }}>
          <input className="a-input" placeholder="логин (латиница)" value={nu.login} onChange={e => setNu({ ...nu, login: e.target.value })} />
          <input className="a-input" placeholder="имя" value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} />
          <input className="a-input" type="password" placeholder="пароль, от 8 символов" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} />
          <select className="a-input" value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}><option value="user">пользователь</option><option value="admin">администратор</option></select>
          <button className="a-btn" onClick={act(async () => { await saveAuthUser(nu); say(`Пользователь ${nu.login} добавлен`); setNu({ login: '', name: '', password: '', role: 'user' }); })}>Добавить</button>
        </div>
      </div>}

      {admin && <div className="a-card" style={{ padding: 16, marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Ключи доступа</b>
        <div className="a-hint" style={{ margin: '4px 0 10px' }}>Для расширения «Соинвест» и других программ, которые сами отправляют данные в сервис. Ключ показывается один раз — вставьте его в настройках расширения. Удалённый ключ сразу перестаёт работать.</div>
        {newKey && <div className="c-msg" style={{ wordBreak: 'break-all' }}>Новый ключ: <code>{newKey}</code> <button className="a-btn ghost" onClick={() => navigator.clipboard?.writeText(newKey)}>Скопировать</button><div className="a-hint">Сохраните его сейчас — потом увидеть ключ будет нельзя.</div></div>}
        <table className="a-t no-sh"><thead><tr><th>Название</th><th>Начало ключа</th><th>Создан</th><th>Последнее использование</th><th /></tr></thead><tbody>
          {keys.map(k => <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td>{when(k.created_at)}</td><td>{when(k.last_used)}</td>
            <td><button className="a-btn ghost" onClick={act(async () => { if (window.confirm(`Удалить ключ «${k.name}»? Программа с ним перестанет отправлять данные.`)) await deleteAuthKey(k.id); })}>Удалить</button></td></tr>)}
          {!keys.length && <tr><td colSpan={5} className="muted">Ключей пока нет</td></tr>}
        </tbody></table>
        <div className="a-bar" style={{ marginTop: 10 }}>
          <input className="a-input" value={keyName} onChange={e => setKeyName(e.target.value)} style={{ minWidth: 240 }} />
          <button className="a-btn" onClick={act(async () => { const r = await createAuthKey(keyName); setNewKey(r.data.data.key); })}>Создать ключ</button>
        </div>
      </div>}

      <div className="a-card" style={{ padding: 16 }}>
        <b style={{ fontSize: 15 }}>Мой пароль</b>
        <div className="a-bar" style={{ marginTop: 10 }}>
          <input className="a-input" type="password" placeholder="текущий пароль" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} />
          <input className="a-input" type="password" placeholder="новый пароль, от 8 символов" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} />
          <button className="a-btn" onClick={act(async () => { await changePassword(pw.current, pw.next); setPw({ current: '', next: '' }); say('Пароль изменён'); })}>Сменить</button>
        </div>
      </div>
    </div>
  );
}
