const dayjs=require('dayjs');
function historyRange(q,now=new Date()){
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(now);
 const valid=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&dayjs(s).isValid()&&dayjs(s).format('YYYY-MM-DD')===s;
 let from,to;
 if(q.dateFrom!==undefined||q.dateTo!==undefined){
  from=q.dateFrom;to=q.dateTo;
  if(!valid(from)||!valid(to)||from>to||dayjs(to).diff(from,'day')>3660)throw Object.assign(Error('Выберите корректный период не длиннее десяти лет'),{status:400});
 }else{const days=Math.max(2,Math.min(90,parseInt(q.days,10)||30));to=today;from=dayjs(to).subtract(days-1,'day').format('YYYY-MM-DD');}
 const dates=[];for(let d=dayjs(from);d.format('YYYY-MM-DD')<=to;d=d.add(1,'day'))dates.push(d.format('YYYY-MM-DD'));
 return {from,to,dates};
}
module.exports={historyRange};
