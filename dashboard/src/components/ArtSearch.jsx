import React, { useState, useMemo, useRef, useEffect } from 'react';
import './ArtSearch.css';

// ─────────────────────────────────────────────────────────────────────────
// Поиск по артикулу.
// • Если введённый текст в точности совпадает с артикулом (без учёта
//   регистра) — показываем аналитику только по нему: «Hv4-2k» не цепляет
//   «Hv4-2kr», «Hv4-2KR» не цепляет «ZHv4-2kr».
// • Иначе — как раньше: всё, где текст встречается в артикуле или названии.
// • Под полем — подсказки: все артикулы, которые продолжают введённый текст;
//   клик выбирает конкретный.
// ─────────────────────────────────────────────────────────────────────────

const lc = s => String(s ?? '').trim().toLowerCase();

// Все известные артикулы (регистрирует useCats и страницы со своим списком).
const KNOWN = new Set();
export function registerArts(codes) { for (const c of codes) { const k = lc(c); if (k) KNOWN.add(k); } }
export const isExactArt = q => !!q && KNOWN.has(lc(q));

// Совпадение одной строки: code — артикул, name — название (необязательно).
export function artMatch(code, name, q) {
  const s = lc(q);
  if (!s) return true;
  if (KNOWN.has(s)) return lc(code) === s;
  return lc(code).includes(s) || lc(name).includes(s);
}

// Отфильтровать список целиком (точное совпадение ищется в самом списке).
export function artFilter(items, q, getCode, getName = () => '') {
  const s = lc(q);
  if (!s) return items;
  if (items.some(it => lc(getCode(it)) === s)) return items.filter(it => lc(getCode(it)) === s);
  return items.filter(it => lc(getCode(it)).includes(s) || lc(getName(it)).includes(s));
}

// Поле поиска с подсказками. options: [{ o: артикул, n: название }].
export default function ArtSearch({ value, onChange, options = [], placeholder = 'Артикул или название', style, inputStyle, className = 'a-input' }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef(null);
  useEffect(() => { registerArts(options.map(a => a.o)); }, [options]);
  useEffect(() => {
    const h = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const s = lc(value);
  const sugg = useMemo(() => {
    if (s.length < 2) return [];
    const seen = new Set(), out = [];
    for (const a of options) {
      const k = lc(a.o); if (!k || seen.has(k)) continue;
      const pos = k.indexOf(s);
      if (pos >= 0 || lc(a.n).includes(s)) { seen.add(k); out.push([pos === 0 ? 0 : pos > 0 ? 1 : 2, a]); }
    }
    out.sort((x, y) => x[0] - y[0] || String(x[1].o).localeCompare(String(y[1].o), 'ru', { numeric: true }));
    return out.slice(0, 14).map(x => x[1]);
  }, [options, s]);
  const exact = sugg.some(a => lc(a.o) === s);
  const show = open && sugg.length > 0 && !(exact && sugg.length === 1);
  const pick = a => { onChange(String(a.o)); setOpen(false); };
  return (
    <span ref={box} className="as-wrap" style={style}>
      <input className={className} value={value} placeholder={placeholder} style={{ width: '100%', ...inputStyle }}
        onFocus={() => setOpen(true)}
        onChange={e => { onChange(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={e => {
          if (!show) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(sugg.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(sugg[hi] || sugg[0]); }
          else if (e.key === 'Escape') setOpen(false);
        }} />
      {value && <button type="button" className="as-x" title="Очистить" onClick={() => { onChange(''); setOpen(false); }}>×</button>}
      {show && (
        <div className="as-pop">
          <div className="as-note">{exact ? 'Показана аналитика только по этому артикулу. Похожие:' : 'Выберите артикул — или оставьте как есть, чтобы видеть всё совпадающее'}</div>
          {sugg.map((a, i) => (
            <button type="button" key={a.o} className={`as-it ${i === hi ? 'hi' : ''} ${lc(a.o) === s ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => pick(a)}>
              <b>{a.o}</b>{a.n ? <span>{a.n}</span> : null}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
