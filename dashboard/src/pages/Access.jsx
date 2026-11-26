import { Eye,EyeOff } from 'lucide-react';
import {getUserPassword} from '../api';
import React, { useEffect, useState, useCallback } from 'react';
import dayjs from 'dayjs';
import { getMe, authLogout, changePassword, getAuthUsers, saveAuthUser, deleteAuthUser, getAuthKeys, createAuthKey, deleteAuthKey } from '../api';
import './ads2.css';
import AccessActivity from './AccessActivity';
import CategoryAccessPicker from '../components/CategoryAccessPicker';
import { getCategoryAccessOptions } from '../api';

// «Доступ»: пользователи сервиса, ключи для расширения и смена своего пароля.
const err = e => e.response?.data?.error || e.message;
const when = v => (v ? dayjs(v).format('DD.MM.YYYY HH:mm') : '—');

export default function Access() {
  const [me, setMe] = useState(undefined);
  const [users, setUsers] = useState([]), [keys, setKeys] = useState([]);
  const [msg, setMsg] = useState(''), [bad, setBad] = useState('');
  const [nu, setNu] = useState({ login: '', name: '', password: '', role: 'user' });
  const [newKey, setNewKey] = useState(null), [keyName, setKeyName] = useState('Расширение «Соинвест»');
  const [options,setOptions] = useState([]), [cabinets,setCabinets] = useState([]), [accessStatus,setAccessStatus] = useState(null);
  const [editing,setEditing] = useState(null);
  const [vaultReady,setVaultReady]=useState(false);
  const [revealed,setRevealed]=useState(null);
  useEffect(()=>{if(!revealed)return;const hide=()=>setRevealed(null);const timer=setTimeout(hide,30000);window.addEventListener('blur',hide);return()=>{clearTimeout(timer);window.removeEventListener('blur',hide);};},[revealed]);
  const [creating,setCreating]=useState(false);
  const emptyUser=()=>({login:'',name:'',password:'',role:'user',accessScope:{paths:[],readOnly:true}});
  const [pw, setPw] = useState({ current: '', next: '' });
  const say = (t, isBad) => { setMsg(isBad ? '' : t); setBad(isBad ? t : ''); };
  const load = useCallback(async () => {
    const m = (await getMe()).data.data; setMe(m);
    if (['owner', 'admin'].includes(m?.role) && m.auth) {
      const u = await getAuthUsers(); setUsers(u.data.data);setVaultReady(!!u.data.passwordVaultConfigured);
      const categories = await getCategoryAccessOptions(); setOptions(categories.data.data.paths); setCabinets(categories.data.data.cabinets || []); setAccessStatus(categories.data.data.accessStatus);
      if (m.role === 'owner') { const k = await getAuthKeys(); setKeys(k.data.data); }
      else setKeys([]);
    }
  }, []);
  useEffect(() => { load().catch(e => say(err(e), true)); }, [load]);
  const act = fn => async () => { try { await fn(); await load(); } catch (e) { say(err(e), true); } };

  if (me === undefined) return <div className="mpui"><div className="a-card" style={{ padding: 16 }}>Загрузка…</div></div>;
  if (!me?.auth) return <div className="mpui"><div className="a-top"><h1>Доступ</h1></div><div className="a-card" style={{ padding: 16 }}>На этом сервере вход по паролю выключен — сервис открыт всем, у кого есть ссылка. Вход включится на новом сервере.</div></div>;
  const owner = me.role === 'owner' && me.login === 'evgeniy';
  const admin = owner || me.role === 'admin';
  return (
    <div className="mpui">
      <div className="page-sticky"><div className="a-top"><h1>Доступ</h1>
        <span className="a-hint">Вы вошли как <b>{me.name || me.login}</b>{owner ? ' · главный администратор' : admin ? ' · администратор пользователей' : ''}</span>
        <button className="a-btn ghost" style={{ marginLeft: 'auto' }} onClick={async () => { await authLogout().catch(() => {}); window.location.href = '/login'; }}>Выйти</button>
      </div></div>
      {msg && <div className="c-msg" role="status">{msg}</div>}{bad && <div className="c-msg bad" role="alert">{bad}</div>}

      {owner && <AccessActivity />}
      {admin && <div className="a-card" style={{ padding: 16, marginBottom: 14 }}>
        <b style={{ fontSize: 15 }}>Пользователи</b>
        <div className="a-hint" style={{ margin: '4px 0 10px' }}>{owner ? 'Вы управляете ролями, пользователями и ключами. Журнал посещений доступен только вам.' : 'Вы можете добавлять и удалять обычных пользователей. История входов и активность вам недоступны.'}</div>
        <div className="a-scroll"><table className="a-t no-sh"><thead><tr><th>Логин</th><th>Имя</th>{owner && <th>Пароль</th>}<th>Роль</th><th>Категории</th><th>Кабинеты</th>{owner && <th>Последний вход</th>}<th>Статус</th><th /></tr></thead><tbody>
          {users.map(u => <tr key={u.id}>
            <td><b>{u.login}</b></td><td>{u.name}</td>
            {owner && <td style={{whiteSpace:'nowrap'}}>{u.password_saved ? <span style={{display:'inline-flex',gap:8,alignItems:'center'}}><code>{revealed?.id===u.id?revealed.password:'••••••••'}</code><button type="button" className="a-btn ghost" aria-label={`${revealed?.id===u.id?'Скрыть':'Показать'} пароль ${u.login}`} onClick={async()=>{if(revealed?.id===u.id)return setRevealed(null);try{const r=await getUserPassword(u.id);if(r.data.data.password)setRevealed({id:u.id,password:r.data.data.password});else say('Пароль не сохранён. Задайте пользователю новый пароль',true);}catch(e){say(err(e),true);}}}>{revealed?.id===u.id?<EyeOff size={15}/>:<Eye size={15}/>}</button></span>:<span className="a-hint" title="Пароль задан до включения показа либо изменён самим пользователем">Не сохранён</span>}</td>}
            <td>{owner && u.role !== 'owner' ? <select className="a-input" value={u.role} onChange={e => act(() => saveAuthUser({ id: u.id, role: e.target.value, disabled: u.disabled }))()}><option value="user">пользователь</option><option value="admin">администратор пользователей</option></select> : u.role === 'owner' ? 'Главный администратор' : 'Пользователь'}</td>
            <td>{u.access_scope && !u.access_scope.allCategories ? u.access_scope.paths?.join(' · ') || 'Нет доступа' : 'Все категории'}</td>
            <td>{u.access_scope?.cabinetIds
              ? u.access_scope.cabinetIds.map(id=>cabinets.find(c=>c.id===id)?.label || id).join(' · ')
              : u.access_scope ? 'Все по категориям' : 'Все кабинеты'}</td>
            {owner && <td>{when(u.last_login)}</td>}
            <td>{u.disabled ? <span className="s-down">отключён</span> : 'активен'}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              {owner && u.role === 'user' && <button className="a-btn ghost" onClick={()=>{setCreating(false);setEditing({id:u.id,scope:u.access_scope || null,login:u.login});}}>Категории и кабинеты</button>}
              {owner && u.role !== 'owner' && <><button className="a-btn ghost" disabled={!vaultReady} onClick={act(async () => { const p = window.prompt(`Новый пароль для ${u.login} (не короче 8 символов)`); if (!p) return; await saveAuthUser({ id: u.id, role: u.role, disabled: u.disabled, password: p }); say(`Пароль ${u.login} изменён, его сессии закрыты`); })}>Сменить пароль</button>
              <button className="a-btn ghost" onClick={act(() => saveAuthUser({ id: u.id, role: u.role, disabled: !u.disabled }))}>{u.disabled ? 'Включить' : 'Отключить'}</button></>}
              {u.role !== 'owner' && <button className="a-btn ghost" onClick={act(async () => { if (window.confirm(`Удалить пользователя ${u.login}?`)) await deleteAuthUser(u.id); })}>Удалить</button>}
            </td></tr>)}
        </tbody></table></div>
        {editing && <div style={{marginTop:12}}><b>Доступ пользователя {editing.login}</b>
          <CategoryAccessPicker value={editing.scope} onChange={scope=>setEditing({...editing,scope})} options={options} cabinets={cabinets} status={accessStatus}/>
          <button className="a-btn" onClick={act(async()=>{await saveAuthUser({id:editing.id,accessScope:editing.scope});setEditing(null);say('Доступ к категориям и кабинетам сохранён');})}>Сохранить доступ</button>
          <button className="a-btn ghost" onClick={()=>setEditing(null)}>Отмена</button>
        </div>}
        {!creating && !editing && <button className="a-btn" onClick={()=>{setNu(emptyUser());setCreating(true);}}>Добавить пользователя</button>}
        {creating && <>
        {nu.role === 'user' && <CategoryAccessPicker value={nu.accessScope} onChange={accessScope=>setNu({...nu,accessScope})} options={options} cabinets={cabinets} status={accessStatus}/>}
        <div className="a-bar" style={{ marginTop: 10 }}>
          <input className="a-input" name="new-user-login" autoComplete="off" placeholder="логин (латиница)" value={nu.login} onChange={e => setNu({ ...nu, login: e.target.value })} />
          <input className="a-input" name="new-user-display-name" autoComplete="off" placeholder="имя" value={nu.name} onChange={e => setNu({ ...nu, name: e.target.value })} />
          <input className="a-input" type="password" name="new-user-password" autoComplete="new-password" placeholder="пароль, от 8 символов" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} />
          {owner && <select className="a-input" value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value, accessScope: e.target.value === 'admin' ? null : (nu.accessScope || emptyUser().accessScope) })}><option value="user">пользователь</option><option value="admin">администратор пользователей</option></select>}
          <button className="a-btn" disabled={!vaultReady} title={!vaultReady?'Готовится защищённое хранение паролей. Обновите страницу через минуту':undefined} onClick={act(async () => { await saveAuthUser(nu); say(`Пользователь ${nu.login} добавлен`); setNu(emptyUser());setCreating(false); })}>Добавить</button>
          <button className="a-btn ghost" onClick={()=>{setCreating(false);setNu(emptyUser());}}>Отмена</button>
        </div></>}
      </div>}

      {owner && <div className="a-card" style={{ padding: 16, marginBottom: 14 }}>
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
