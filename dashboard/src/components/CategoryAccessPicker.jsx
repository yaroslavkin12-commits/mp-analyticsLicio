import React,{useState,useId} from 'react';
import {ChevronDown,ChevronRight} from 'lucide-react';
import CategoryBranches from './CategoryBranches';
import {toggleCategory,selectionSummary} from '../lib/categorySelection';

export default function CategoryAccessPicker({value,onChange,options,status,cabinets=[]}) {
  const limited=!!value, paths=value?.paths||[], allCategories=value?.allCategories===true;
  const selected=value?.cabinetIds ?? null;
  const [expanded,setExpanded]=useState(true), id=useId();
  const change=patch=>onChange({...value,paths,readOnly:true,...patch});
  const cabinetLabel=selected===null?'Все кабинеты по категориям':selected.length?'Кабинетов: '+selected.length:'Кабинеты не выбраны';
  const summary=limited? (allCategories?'Все категории':selectionSummary(paths))+' · '+cabinetLabel:'Все данные и редактирование';
  const available=cabinets.filter(c=>{
    if(allCategories||!paths.length)return true;
    return paths.some(path=>(path.split(' / ')[0]==='Одежда')===(c.id==='licio'));
  });
  const groups=[['ozon','Ozon'],['wb','Wildberries'],['other','Licio']];
  const switchSelection=c=>change({cabinetIds:selected.includes(c)?selected.filter(id=>id!==c):[...selected,c]});

  return <div className="category-access-picker">
    <button type="button" className="category-picker-summary" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(v=>!v)}>
      {expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<b>Доступ к данным</b><span className="category-picker-selection" title={summary}>{summary}</span>
    </button>
    {expanded&&<div id={id} className="category-picker-body">
      <div className="category-picker-mode" role="group" aria-label="Режим доступа">
        <button type="button" aria-pressed={!limited} onClick={()=>onChange(null)}>Все данные и редактирование</button>
        <button type="button" aria-pressed={limited} onClick={()=>{if(!limited)onChange({paths:[],readOnly:true});}}>Настроить доступ · просмотр и Excel</button>
      </div>
      {limited&&<>
        {status&&!status.keyConnected&&<div className="c-msg">Сначала подключите расширение ключом и выполните сбор цен. Это позволит закрыть открытый доступ через старый адрес и безопасно включить ограничения.</div>}
        {status&&!status.legacyReady&&<div className="a-hint">Завершается обновление доступа. Перед сохранением обновите список.</div>}
        <b className="access-picker-heading">Категории</b>
        <div className="category-picker-mode" role="group" aria-label="Доступные категории">
          <button type="button" aria-pressed={!allCategories} onClick={()=>{if(allCategories)change({allCategories:false});}}>Выбранные категории</button>
          <button type="button" aria-pressed={allCategories} onClick={()=>change({cabinetIds:selected,allCategories:true})}>Все категории</button>
        </div>
        {!allCategories&&<CategoryBranches options={options} paths={paths} onSelect={path=>change({paths:toggleCategory(paths,path)})}/>}
        <b className="access-picker-heading">Кабинеты</b>
        <div className="category-picker-mode" role="group" aria-label="Доступные кабинеты">
          <button type="button" aria-pressed={selected===null} onClick={()=>change({cabinetIds:null})}>Все по категориям</button>
          <button type="button" aria-pressed={selected!==null} onClick={()=>{if(selected===null)change({cabinetIds:available.filter(c=>c.connected).map(c=>c.id)});}}>Выбранные кабинеты</button>
        </div>
        {selected!==null&&<div className="access-cabinet-groups">
          {groups.map(([key,label])=>{
            const items=cabinets.filter(c=>(c.platform||'other')===key);
            if(!items.length)return null;
            return <fieldset key={key} className="access-cabinet-group">
              <legend>{label}</legend>
              {items.map(c=>{
                const match=available.includes(c), checked=selected.includes(c.id);
                return <label key={c.id} title={match?undefined:'Выберите подходящую категорию'}>
                  <input type="checkbox" checked={checked} disabled={!checked&&!match} onChange={()=>switchSelection(c.id)}/>
                  <span>{c.label}{c.connected===false?' · не подключён':''}</span>
                </label>;
              })}
            </fieldset>;
          })}
        </div>}
        {selected?.some(id=>!available.some(c=>c.id===id))&&<div className="a-hint" role="status">Снимите отметки с кабинетов, которые не подходят к выбранным категориям.</div>}
      </>}
    </div>}
  </div>;
}
