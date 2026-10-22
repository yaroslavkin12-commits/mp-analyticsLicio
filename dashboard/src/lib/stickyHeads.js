// Закреплённые шапки таблиц. Таблицы лежат в областях с горизонтальной
// прокруткой, поэтому CSS position:sticky для шапки там не работает. Вместо
// этого при прокрутке страницы сдвигаем ячейки шапки вниз (transform) ровно
// на столько, чтобы она стояла под закреплённой шапкой страницы, но не ниже
// последней строки таблицы.
const SEL = 'table.a-t, table.a-dt, table.abc-mx';
let raf = 0;

function update() {
  raf = 0;
  const vh = window.innerHeight;
  const tops = new Map();
  // Нижний край закреплённой шапки ТОГО раздела, где лежит таблица (фоном
  // открыты и другие разделы — их шапки не в счёт); нет шапки — верх окна.
  const topOf = t => {
    const root = t.closest('.mpui') || document.body;
    if (tops.has(root)) return tops.get(root);
    const el = root.querySelector('.page-sticky');
    const v = el ? Math.max(0, el.getBoundingClientRect().bottom) : 0;
    tops.set(root, v);
    return v;
  };
  for (const t of document.querySelectorAll(SEL)) {
    const head = t.tHead; if (!head || !t.offsetParent) continue;
    if (t.classList.contains('no-sh')) continue; // своя прокрутка и position:sticky (РНП)
    if (t.checkVisibility && !t.checkVisibility({ visibilityProperty: true })) continue;
    const top = topOf(t);
    const r = t.getBoundingClientRect();
    let off = 0;
    if (r.top < top && r.bottom > top && r.top < vh) {
      const hh = head.getBoundingClientRect().height;
      off = Math.max(0, Math.min(top - r.top, r.height - hh * 2));
    }
    const v = off ? `translateY(${Math.round(off)}px)` : '';
    if (head.dataset.sh === v) continue;
    head.dataset.sh = v;
    head.classList.toggle('sh-on', !!off);
    for (const th of head.querySelectorAll('th')) th.style.transform = v;
  }
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

let started = false;
export function startStickyHeads() {
  if (started) return;
  started = true;
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // Таблицы появляются и меняются после загрузки данных.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
}
