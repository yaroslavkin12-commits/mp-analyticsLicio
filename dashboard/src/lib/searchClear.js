// Крестик «стереть» во всех полях поиска (артикул, название, категория…).
// Не правим каждую страницу: такие поля превращаем в type="search" — браузер
// сам рисует кнопку очистки, а её нажатие даёт обычное событие ввода, которое
// React видит как стирание текста. У поиска артикула (ArtSearch) крестик свой.
const RX = /артикул|поиск|назван|категор|модел|марк/i;
let pending = false;
function scan() {
  pending = false;
  for (const el of document.querySelectorAll('input:not([type]), input[type="text"]')) {
    if (el.dataset.sc || !RX.test(el.placeholder || '') || el.closest('.as-wrap')) continue;
    el.dataset.sc = '1';
    el.type = 'search';
    el.classList.add('sc-input');
  }
}
export function initSearchClear() {
  scan();
  new MutationObserver(() => { if (!pending) { pending = true; setTimeout(scan, 150); } }).observe(document.body, { childList: true, subtree: true });
}
