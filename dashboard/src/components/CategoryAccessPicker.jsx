import React from 'react';
const SEP=' / ';
export default function CategoryAccessPicker({ value, onChange, options, status }) {
  const limited=!!value, paths=value?.paths || [];
  const toggle=path=>{
    const next=paths.includes(path)?paths.filter(p=>p!==path):[...paths.filter(p=>!p.startsWith(path+SEP)),path];
    onChange({paths:next,readOnly:true});
  };
  return <div style={{margin:'10px 0',padding:12,border:'1px solid var(--border)',borderRadius:10}}>
    <b>Доступ к данным</b>
    <div className="a-bar" style={{marginTop:8,gap:8}}>
      <label><input type="radio" checked={!limited} onChange={()=>onChange(null)}/> Все данные и редактирование</label>
      <label><input type="radio" checked={limited} onChange={()=>onChange({paths:[],readOnly:true})}/> Выбранные категории · только просмотр и Excel</label>
    </div>
    {limited && <>
      <p className="a-hint">Выбор категории включает её подкатегории. Можно отметить несколько веток. Остальные товары, общие отчёты и изменение данных будут недоступны.</p>
      {status && !status.keyConnected && <div className="c-msg">Сначала подключите расширение ключом и выполните сбор цен. Это позволит закрыть открытый доступ через старый адрес и безопасно включить ограничения.</div>}
      {status && !status.legacyReady && <div className="a-hint">Завершается обновление доступа. Перед сохранением обновите список.</div>}
      <div style={{maxHeight:280,overflowY:'auto',display:'flex',flexDirection:'column',gap:5}}>
        {(options || []).map(path=>{
          const parent=paths.some(p=>path.startsWith(p+SEP));
          return <label key={path} style={{paddingLeft:(path.split(SEP).length-1)*18,opacity:parent ? 0.55 : 1}}>
            <input type="checkbox" checked={parent || paths.includes(path)} disabled={parent} onChange={()=>toggle(path)}/> {path.split(SEP).at(-1)}
          </label>;
        })}
        {!options?.length && <span className="a-hint">Список категорий загружается…</span>}
      </div>
    </>}
  </div>;
}
