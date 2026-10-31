import React, { useEffect, useRef, useState } from 'react';
import './columnPicker.css';

export default function ColumnPicker({ columns, value, onChange }) {
  const [open, setOpen] = useState(false), [dragging, setDragging] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const escape = e => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  const known = new Map(columns), selected = value.filter(k => known.has(k));
  const move = (key, target) => {
    if (key === target || !selected.includes(key) || !selected.includes(target)) return;
    const next = selected.filter(k => k !== key); next.splice(next.indexOf(target), 0, key); onChange(next);
  };
  return <div className="column-picker" ref={ref}>
    <button type="button" className="a-btn ghost" aria-label="Настроить колонки таблицы" aria-expanded={open} onClick={() => setOpen(v => !v)}>⚙ Колонки</button>
    {open && <div className="column-picker-panel" role="region" aria-label="Колонки таблицы">
      <div className="column-picker-title"><b>Колонки таблицы</b><button type="button" className="a-btn ghost" aria-label="Закрыть колонки" onClick={() => setOpen(false)}>×</button></div>
      <small>Перетащите строку, чтобы изменить порядок.</small>
      <div className="column-picker-lists"><section><b>В таблице · {selected.length}</b><div className="column-picker-list">{selected.map((key, i) => <div key={key} className={`column-picker-row ${dragging === key ? 'dragging' : ''}`} draggable onDragStart={e => { setDragging(key); e.dataTransfer.setData('text/plain', key); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragging(null)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); move(e.dataTransfer.getData('text/plain'), key); setDragging(null); }}>
        <span aria-hidden="true">⠿</span><label><input type="checkbox" checked onChange={() => onChange(selected.filter(k => k !== key))} />{known.get(key)}</label>
        <button type="button" disabled={!i} aria-label={`Выше: ${known.get(key)}`} onClick={() => move(key, selected[i - 1])}>↑</button><button type="button" disabled={i === selected.length - 1} aria-label={`Ниже: ${known.get(key)}`} onClick={() => { const next = [...selected]; [next[i], next[i + 1]] = [next[i + 1], next[i]]; onChange(next); }}>↓</button>
      </div>)}</div></section><section><b>Можно добавить</b><div className="column-picker-list">{columns.filter(([key]) => !selected.includes(key)).map(([key, label]) => <label className="column-picker-row" key={key}><input type="checkbox" checked={false} onChange={() => onChange([...selected, key])} />{label}</label>)}</div></section></div>
    </div>}
  </div>;
}
