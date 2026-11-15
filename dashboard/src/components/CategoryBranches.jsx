import React,{useMemo} from 'react';
import {Check,Minus} from 'lucide-react';
import {categoryBranches,categorySelection} from '../lib/categorySelection';
import './categoryBranches.css';
export default function CategoryBranches({options,paths,onSelect,single=false,disabled=false}){
 const branches=useMemo(()=>categoryBranches(options),[options]);
 return <div className="category-branches" role={single?'radiogroup':'group'} aria-label={single?'Назначение категории':'Доступные категории'}>
  {branches.map(({root,paths:branch})=>{
   const count=paths.filter(p=>p===root||p.startsWith(root+' / ')).length;
   const button=(path,isRoot=false)=>{const state=single?{checked:paths.includes(path)}:categorySelection(paths,path);return <button key={path} type="button" role={single?'radio':'checkbox'} aria-checked={state.partial?'mixed':state.checked} disabled={disabled||state.inherited} className={'category-branch-option'+(isRoot?' category-branch-root':'')+(state.checked?' selected':'')+(state.partial?' partial':'')} style={!isRoot?{'--category-depth':Math.max(0,path.split(' / ').length-2)}:undefined} onClick={()=>onSelect(path)}>
    <span className="category-branch-mark" aria-hidden="true">{state.checked?<Check size={13}/>:state.partial?<Minus size={13}/>:null}</span><span>{isRoot?root:path.split(' / ').at(-1)}</span>{isRoot&&count>0&&<small>{count}</small>}
   </button>;};
   return <section className="category-branch" key={root} aria-label={root}>{button(root,true)}<div className="category-branch-children">{branch.filter(p=>p!==root).map(path=>button(path))}</div></section>;
  })}
  {!branches.length&&<span className="a-hint">Список категорий загружается…</span>}
 </div>;
}
