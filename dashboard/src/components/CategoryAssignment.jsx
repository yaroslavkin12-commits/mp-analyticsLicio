import React,{useState,useId} from 'react';
import {ChevronDown,ChevronRight} from 'lucide-react';
import CategoryBranches from './CategoryBranches';
export default function CategoryAssignment({item,options,onSave,onCancel,busy}){
 const [path,setPath]=useState(item.category),[expanded,setExpanded]=useState(true),id=useId();
 return <section className="category-assignment" aria-label={'Категория товара '+item.offerId}>
  <button type="button" className="category-picker-summary" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(v=>!v)}>{expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}<b>{item.offerId}</b><span className="category-picker-selection" title={path}>{path.split(' / ').join(' › ')}</span></button>
  {expanded&&<div className="category-picker-body"><p className="a-hint category-picker-hint">Выберите категорию товара. Назначение будет использоваться во всех разделах этого кабинета.</p>
   <CategoryBranches options={options} paths={[path]} single onSelect={setPath} disabled={busy}/>
   <div className="category-assignment-actions"><button type="button" className="a-btn" disabled={busy||path===item.category} onClick={()=>onSave(path)}>{busy?'Сохраняем…':'Сохранить категорию'}</button><button type="button" className="a-btn ghost" disabled={busy} onClick={()=>onSave(null)}>Автоопределение</button><button type="button" className="a-btn ghost" disabled={busy} onClick={onCancel}>Отмена</button></div>
  </div>}
 </section>;
}
