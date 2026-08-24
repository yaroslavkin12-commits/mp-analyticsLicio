import React, { useState, useRef, useEffect } from 'react';
import dayjs from 'dayjs';
import 'dayjs/locale/ru';
dayjs.locale('ru');

const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const DAYS   = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function CalendarMonth({ year, month, start, end, hovered, onDay, onHover }) {
  const firstDay = dayjs(`${year}-${String(month+1).padStart(2,'0')}-01`);
  const daysInMonth = firstDay.daysInMonth();
  const startDow = (firstDay.day() + 6) % 7; // 0=Пн

  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const toDate = d => d ? dayjs(`${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`) : null;
  const rangeEnd = end || hovered;

  return (
    <div style={{ minWidth: 230 }}>
      <div style={{ textAlign:'center', fontWeight:700, marginBottom:10, fontSize:13 }}>
        {MONTHS[month]} {year}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2, marginBottom:6 }}>
        {DAYS.map(d => <div key={d} style={{ textAlign:'center', fontSize:11, color:'var(--text3)', fontWeight:600 }}>{d}</div>)}
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:2 }}>
        {cells.map((d, i) => {
          const date = toDate(d);
          if (!d) return <div key={i} />;

          const isStart     = start && date.isSame(start, 'day');
          const isEnd       = rangeEnd && date.isSame(rangeEnd, 'day');
          const inRange     = start && rangeEnd && date.isAfter(start.subtract(1,'day')) && date.isBefore(rangeEnd.add(1,'day'));
          const isEdge      = isStart || isEnd;

          return (
            <div key={i}
              onMouseEnter={() => onHover(date)}
              onClick={() => onDay(date)}
              style={{
                padding:'5px 0', textAlign:'center', cursor:'pointer', borderRadius: isEdge ? 6 : 0,
                fontSize: 12, fontWeight: isEdge ? 700 : 400,
                background: isEdge ? 'var(--accent-oz)' : inRange ? 'rgba(0,91,255,0.12)' : 'transparent',
                color: isEdge ? '#fff' : 'var(--text)',
                transition: 'background .1s',
              }}>
              {d}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangePicker({ from, to, onChange }) {
  const [open, setOpen]       = useState(false);
  const [picking, setPicking] = useState(null); // null | 'start' started
  const [tempStart, setTempStart] = useState(null);
  const [hovered, setHovered] = useState(null);
  const [viewYear, setViewYear] = useState(dayjs(from || undefined).year());
  const [viewMonth, setViewMonth] = useState(dayjs(from || undefined).month());
  const ref = useRef();

  // Закрыть при клике вне
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y-1); setViewMonth(11); }
    else setViewMonth(m => m-1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y+1); setViewMonth(0); }
    else setViewMonth(m => m+1);
  }

  // Следующий месяц для второго календаря
  const month2 = viewMonth === 11 ? 0 : viewMonth+1;
  const year2  = viewMonth === 11 ? viewYear+1 : viewYear;

  function handleDay(date) {
    if (!tempStart) {
      // Первый клик — выбираем начало
      setTempStart(date);
    } else {
      // Второй клик — выбираем конец
      let s = tempStart, e = date;
      if (e.isBefore(s)) { [s, e] = [e, s]; }
      onChange(s.format('YYYY-MM-DD'), e.format('YYYY-MM-DD'));
      setTempStart(null);
      setHovered(null);
      setOpen(false);
    }
  }

  const start = tempStart || (from ? dayjs(from) : null);
  const end   = !tempStart && to ? dayjs(to) : null;

  const fmtDisplay = d => d ? dayjs(d).format('DD.MM.YYYY') : '—';

  // Быстрые периоды
  const QUICK = [
    { label:'Сегодня',    f:() => [dayjs(),                               dayjs()]                              },
    { label:'Вчера',      f:() => [dayjs().subtract(1,'day'),              dayjs().subtract(1,'day')]            },
    { label:'7 дней',     f:() => [dayjs().subtract(6,'day'),              dayjs()]                              },
    { label:'30 дней',    f:() => [dayjs().subtract(29,'day'),             dayjs()]                              },
    { label:'Этот месяц', f:() => [dayjs().startOf('month'),               dayjs()]                              },
    { label:'Прошл. мес', f:() => [dayjs().subtract(1,'month').startOf('month'), dayjs().subtract(1,'month').endOf('month')] },
  ];

  return (
    <div ref={ref} style={{ position:'relative' }}>
      {/* Trigger */}
      <button onClick={() => setOpen(o => !o)} style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 14px', border:'1px solid var(--border)', borderRadius:8,
        background: open ? 'var(--surface2)' : 'var(--surface)',
        color:'var(--text)', cursor:'pointer', fontSize:13, fontWeight:500,
        whiteSpace:'nowrap',
      }}>
        <span style={{ fontSize:15 }}>📅</span>
        {fmtDisplay(from)} — {fmtDisplay(to)}
        <span style={{ color:'var(--text3)', fontSize:10 }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Popup */}
      {open && (
        <div style={{
          position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:1000,
          background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12,
          padding:20, boxShadow:'0 8px 32px rgba(0,0,0,0.4)',
          display:'flex', flexDirection:'column', gap:16, minWidth:520,
        }}>
          {/* Быстрые периоды */}
          <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
            {QUICK.map(q => (
              <button key={q.label} onClick={() => {
                const [s,e] = q.f();
                onChange(s.format('YYYY-MM-DD'), e.format('YYYY-MM-DD'));
                setTempStart(null); setOpen(false);
              }} style={{
                padding:'4px 10px', border:'1px solid var(--border)', borderRadius:6,
                background:'var(--surface2)', color:'var(--text2)', cursor:'pointer', fontSize:12,
              }}>{q.label}</button>
            ))}
          </div>

          {/* Подсказка */}
          <div style={{ fontSize:12, color:'var(--text3)', textAlign:'center' }}>
            {tempStart
              ? `Начало: ${tempStart.format('DD.MM.YYYY')} — выберите конечную дату`
              : 'Нажмите на начальную дату'}
          </div>

          {/* Двойной календарь */}
          <div style={{ display:'flex', gap:24 }}>
            {/* Навигация */}
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', width:230 }}>
                <button onClick={prevMonth} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--text2)', fontSize:16, padding:'2px 6px' }}>‹</button>
                <div />
                <button onClick={nextMonth} style={{ border:'none', background:'transparent', cursor:'pointer', color:'var(--text2)', fontSize:16, padding:'2px 6px' }}>›</button>
              </div>
              <CalendarMonth year={viewYear} month={viewMonth} start={start} end={end} hovered={hovered}
                onDay={handleDay} onHover={d => tempStart && setHovered(d)} />
            </div>
            <CalendarMonth year={year2} month={month2} start={start} end={end} hovered={hovered}
              onDay={handleDay} onHover={d => tempStart && setHovered(d)} />
          </div>
        </div>
      )}
    </div>
  );
}
