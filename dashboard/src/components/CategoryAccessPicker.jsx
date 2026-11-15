import React,{useState,useId} from 'react';
import {ChevronDown,ChevronRight} from 'lucide-react';
import CategoryBranches from './CategoryBranches';
import {toggleCategory,selectionSummary} from '../lib/categorySelection';
export default function CategoryAccessPicker({ value, onChange, options, status }) {
 const limited=!!value,paths=value?.paths||[],[expanded,setExpanded]=useState(true),id=useId();
 const summary=limited?selectionSummary(paths):'Все данные и редактирование';
 return <div className="category-access-picker">
  <button type="button" className="category-picker-summary" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(v=>!v)}>
   {expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<b>Доступ к данным</b><span className="category-picker-selection" title={summary}>{summary}</span>
  </button>
  {expanded&&<div id={id} className="category-picker-body">
   <div className="category-picker-mode" role="group" aria-label="Режим доступа">
    <button type="button" aria-pressed={!limited} onClick={()=>onChange(null)}>Все данные и редактирование</button>
    <button type="button" aria-pressed={limited} onClick={()=>onChange({paths:[],readOnly:true})}>Выбранные категории · просмотр и Excel</button>
   </div>
   {limited&&<>
    <p className="a-hint category-picker-hint">Выбор ветки включает её подкатегории. Остальные данные и редактирование будут недоступны.</p>
    {status&&!status.keyConnected&&<div className="c-msg">Сначала подключите расширение ключом и выполните сбор цен. Это позволит закрыть открытый доступ через старый адрес и безопасно включить ограничения.</div>}
    {status&&!status.legacyReady&&<div className="a-hint">Завершается обновление доступа. Перед сохранением обновите список.</div>}
    <CategoryBranches options={options} paths={paths} onSelect={path=>onChange({paths:toggleCategory(paths,path),readOnly:true})}/>
   </>}
  </div>}
 </div>;
}
