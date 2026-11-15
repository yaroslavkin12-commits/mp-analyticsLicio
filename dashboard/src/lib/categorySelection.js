const SEP=' / ';
const ROOTS=['Чехлы','Дефлекторы','Утеплители','Аксессуары','Одежда'];
export function categoryBranches(options=[]){
 const paths=[...new Set(options.filter(Boolean))],roots=[...new Set(paths.map(p=>p.split(SEP)[0]))];
 const rank=r=>ROOTS.indexOf(r)<0?100:ROOTS.indexOf(r);
 return roots.sort((a,b)=>rank(a)-rank(b)||a.localeCompare(b,'ru')).map(root=>({root,paths:paths.filter(p=>p===root||p.startsWith(root+SEP)).sort((a,b)=>a.localeCompare(b,'ru'))}));
}
export function categorySelection(paths,path){
 const checked=paths.includes(path),inherited=paths.some(p=>path.startsWith(p+SEP));
 return {checked:checked||inherited,inherited,partial:!checked&&!inherited&&paths.some(p=>p.startsWith(path+SEP))};
}
export function toggleCategory(paths,path){
 if(categorySelection(paths,path).inherited)return paths;
 return paths.includes(path)?paths.filter(p=>p!==path):[...paths.filter(p=>!p.startsWith(path+SEP)),path];
}
export function selectionSummary(paths){return paths.length?paths.map(p=>p.split(SEP).join(' › ')).join(' · '):'Категории не выбраны';}
