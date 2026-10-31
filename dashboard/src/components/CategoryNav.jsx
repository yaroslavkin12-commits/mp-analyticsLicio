import React, { useEffect, useRef, useState } from 'react';
import './categoryNav.css';
const SEP=' / ';
export const CATEGORY_ORDER=['Чехлы','Дефлекторы','Утеплители','Аксессуары'];
export const categoryCompare=(a,b)=>{const rank=n=>{const i=CATEGORY_ORDER.indexOf(n);return i<0?100:i;};return rank(a)-rank(b);};
export default function CategoryNav({ tops, value='', onChange, childrenOf, groups, actions, allLabel='Все', allActive=!value }) {
  const strip=useRef(null), [edges,setEdges]=useState({left:false,right:false});
  const measure=()=>{const el=strip.current;if(el)setEdges({left:el.scrollLeft>1,right:el.scrollLeft+el.clientWidth<el.scrollWidth-1});};
  useEffect(()=>{const el=strip.current;if(!el)return;measure();const observer=new ResizeObserver(measure);observer.observe(el);for(const child of el.children)observer.observe(child);return()=>observer.disconnect();},[groups]);
  const scroll=direction=>strip.current?.scrollBy({left:direction*Math.max(180,strip.current.clientWidth*.75),behavior:'smooth'});
  const parts=value?value.split(SEP):[],kids=value?childrenOf(value):[];
  return <nav className="category-nav" aria-label="Категории и группы">
    <div className="category-nav-top"><div className="category-nav-categories"><button type="button" className={allActive?'on':''} aria-pressed={allActive} onClick={()=>onChange('')}>{allLabel}</button>{[...tops].sort(categoryCompare).map(c=><button key={c} type="button" className={parts[0]===c?'on':''} aria-pressed={parts[0]===c} onClick={()=>onChange(c)}>{c}</button>)}</div>{groups&&<div className="category-nav-group-wrap">{(edges.left||edges.right)&&<button type="button" className="category-nav-arrow" aria-label="Предыдущие группы" disabled={!edges.left} onClick={()=>scroll(-1)}>‹</button>}<div ref={strip} onScroll={measure} className="category-nav-groups" aria-label="Мои группы">{groups}</div>{(edges.left||edges.right)&&<button type="button" className="category-nav-arrow" aria-label="Следующие группы" disabled={!edges.right} onClick={()=>scroll(1)}>›</button>}</div>}</div>
    {(value||actions)&&<div className="category-nav-sub"><div className="category-nav-path">{parts.map((p,i)=><React.Fragment key={i}>{i>0&&<span>›</span>}<button type="button" className={i===parts.length-1?'on':''} onClick={()=>onChange(parts.slice(0,i+1).join(SEP))}>{p}</button></React.Fragment>)}</div>{kids.length>0&&<div className="category-nav-children">{kids.map(c=><button type="button" key={c} onClick={()=>onChange(value+SEP+c)}>{c}</button>)}</div>}{actions&&<div className="category-nav-actions">{actions}</div>}</div>}
  </nav>;
}
