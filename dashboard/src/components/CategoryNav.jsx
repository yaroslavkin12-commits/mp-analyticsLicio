import React from 'react';
import './categoryNav.css';
const SEP=' / ';
export const CATEGORY_ORDER=['Чехлы','Дефлекторы','Утеплители','Аксессуары'];
export const categoryCompare=(a,b)=>{const rank=n=>{const i=CATEGORY_ORDER.indexOf(n);return i<0?100:i;};return rank(a)-rank(b);};
export default function CategoryNav({ tops, value='', onChange, childrenOf, groups, allLabel='Все', allActive=!value }) {
  const parts=value?value.split(SEP):[],kids=value?childrenOf(value):[];
  return <nav className="category-nav" aria-label="Категории и группы">
    <div className="category-nav-top"><div className="category-nav-categories"><button type="button" className={allActive?'on':''} aria-pressed={allActive} onClick={()=>onChange('')}>{allLabel}</button>{[...tops].sort(categoryCompare).map(c=><button key={c} type="button" className={parts[0]===c?'on':''} aria-pressed={parts[0]===c} onClick={()=>onChange(c)}>{c}</button>)}</div>{groups&&<div className="category-nav-groups" aria-label="Мои группы">{groups}</div>}</div>
    {value&&<div className="category-nav-sub"><div className="category-nav-path">{parts.map((p,i)=><React.Fragment key={i}>{i>0&&<span>›</span>}<button type="button" className={i===parts.length-1?'on':''} onClick={()=>onChange(parts.slice(0,i+1).join(SEP))}>{p}</button></React.Fragment>)}</div>{kids.length>0&&<div className="category-nav-children">{kids.map(c=><button type="button" key={c} onClick={()=>onChange(value+SEP+c)}>{c}</button>)}</div>}</div>}
  </nav>;
}
