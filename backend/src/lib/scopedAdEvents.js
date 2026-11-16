// Событие привязано к разрешённому товару, но свободный текст может содержать
// название другого товара или общий бюджет смешанной кампании.
const labels = { camp_on:'Рекламная кампания включена', camp_off:'Рекламная кампания выключена', budget:'Изменён бюджет рекламной кампании', bid_cpc:'Ставка за клик', bid_cpo:'Ставка за заказ', cpo_on:'Оплата за заказ включена', cpo_off:'Оплата за заказ выключена', restock:'Пополнение остатка', stock_in:'Товар снова в наличии', stock_out:'Остаток закончился', stock:'Изменился остаток', price_up:'Цена клиента выросла', price_down:'Цена клиента снизилась', price:'Цена клиента изменилась' };
const number = v => v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null;
function scopedAdEvents(events, allowed) {
  return (events || []).filter(e => e.offerId && allowed.has(String(e.offerId))).map(e => {
    const out = { id:e.id, offerId:e.offerId, date:e.date, kind:e.kind, auto:!!e.auto, createdAt:e.createdAt, price:!!e.price };
    out.text = e.auto ? (labels[e.kind] || 'Изменение рекламы товара') : (e.kind === 'note' ? String(e.text || '') : 'Заметка по товару');
    if (e.auto && ['bid_cpc','bid_cpo','restock','stock'].includes(e.kind)) {
      const a=number(e.oldValue), b=number(e.newValue);
      if(a !== null && b !== null) { out.oldValue=a; out.newValue=b; out.text+=`: ${a} → ${b}${e.kind==='bid_cpc'?' ₽':e.kind==='bid_cpo'?'%':' шт'}`; }
    }
    // Из ценового события берём только строгий числовой фрагмент, без произвольного текста.
    if(e.auto && e.price) {
      const price = String(e.text || '').match(/^Цена клиента ([\d\s.,]+) → ([\d\s.,]+) ₽/);
      if(price) out.text=`Цена клиента ${price[1]} → ${price[2]} ₽`;
    }
    return out;
  });
}
module.exports = { scopedAdEvents };
