import React, { useState } from 'react';
import dayjs from 'dayjs';
import './quickPeriods.css';
export default function QuickPeriods({ from, to, onChange, periods = [7,14,30] }) {
  const [picked,setPicked]=useState('30');
  const today=dayjs(), end=today.format('YYYY-MM-DD');
  const options=[{key:'week',label:'Эта неделя',from:today.subtract((today.day()+6)%7,'day').format('YYYY-MM-DD')},...periods.map(n=>({key:String(n),label:`${n} дн`,from:today.subtract(n-1,'day').format('YYYY-MM-DD')}))];
  const matches=o=>o.from===from && to===end;
  const active=options.find(o=>o.key===picked&&matches(o))?.key || options.find(matches)?.key;
  return <span className="a-seg quick-periods" aria-label="Быстрые периоды">{options.map(o=><button key={o.key} type="button" className={active===o.key?'on':''} aria-pressed={active===o.key} onClick={()=>{setPicked(o.key);onChange(o.from,end);}}>{o.label}</button>)}</span>;
}
