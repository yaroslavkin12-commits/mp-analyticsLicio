import React from 'react';
export default function SetMark({ on, onClick, title }) {
  return (
    <button type="button" className={`tb-mark ${on ? 'on' : ''}`} onClick={onClick}
      title={title || (on ? 'В наборе для выгрузки (внизу) — нажмите, чтобы убрать' : 'Добавить в набор для выгрузки (внизу)')}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">{on
        ? <path d="M4 8.2l2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        : <path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}</svg>
    </button>
  );
}

