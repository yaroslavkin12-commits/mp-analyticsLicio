// ─────────────────────────────────────────────────────────────────────────
// Артикулы по всему сервису: рядом с каждым — едва заметная кнопка «копировать»,
// клик по самому артикулу открывает карточку товара на Ozon.
// Работает без правок страниц: следим за DOM и находим текстовые узлы, которые
// целиком равны известному артикулу кабинета (список и SKU — /api/sales/skus).
// Не трогаем поля ввода, выпадающие подсказки и всё внутри [data-no-art].
// ─────────────────────────────────────────────────────────────────────────
import { getSkus } from '../api';

let skus = new Map(); // артикул → SKU Ozon
let cab = null;
let observer = null;
let pending = false;
const SKIP = 'input,textarea,select,option,button,a,[contenteditable],.as-pop,[data-no-art],.art-cp,svg';

function enhance(root) {
  if (!skus.size || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.trim();
    if (t.length < 3 || t.length > 64 || !skus.has(t)) continue;
    const el = n.parentElement;
    if (!el || el.closest(SKIP)) continue;
    found.push([n, el, t]);
  }
  for (const [n, el, t] of found) {
    if (el.dataset.art === t && n.nextSibling?.classList?.contains('art-cp')) continue;
    el.dataset.art = t;
    el.classList.add('art-link');
    el.title = el.title || `${t} — открыть карточку на Ozon`;
    if (n.nextSibling?.classList?.contains('art-cp')) { n.nextSibling.dataset.copy = t; continue; }
    const b = document.createElement('span');
    b.className = 'art-cp'; b.dataset.copy = t; b.title = 'Скопировать артикул'; b.textContent = '⧉';
    n.parentNode.insertBefore(b, n.nextSibling);
  }
}
function schedule() {
  if (pending) return;
  pending = true;
  (window.requestIdleCallback || (f => setTimeout(f, 120)))(() => { pending = false; enhance(document.body); }, { timeout: 400 });
}

function onClick(e) {
  const cp = e.target.closest?.('.art-cp');
  if (cp) {
    e.preventDefault(); e.stopPropagation();
    const t = cp.dataset.copy;
    const done = () => { cp.textContent = '✓'; cp.classList.add('ok'); setTimeout(() => { cp.textContent = '⧉'; cp.classList.remove('ok'); }, 900); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
    else fallbackCopy(t, done);
    return;
  }
  const el = e.target.closest?.('[data-art]');
  if (!el || e.target !== el) return; // только клик по самому тексту артикула
  const sku = skus.get(el.dataset.art);
  if (!sku) return;
  e.preventDefault(); e.stopPropagation();
  window.open(`https://www.ozon.ru/product/${sku}/`, '_blank', 'noopener');
}
function fallbackCopy(t, done) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (x) { /* ignore */ }
  ta.remove();
}

export function initArtLinks(cabinet) {
  if (cabinet === cab) return;
  cab = cabinet;
  getSkus(cabinet).then(r => {
    if (cab !== cabinet) return;
    skus = new Map(Object.entries(r.data.data || {}));
    schedule();
  }).catch(() => {});
  if (!observer) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', onClick, true);
  }
}
