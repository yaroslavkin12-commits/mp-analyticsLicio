// Коэффициенты юнит-экономики по артикулу (средние за 30 дней с подстраховкой
// «товар → категория → родитель → кабинет») и прогноз прибыли от заказов.
// Общие для «Юнит-экономики», «Рекламы» и «Цен и маржи».
const SEP = ' / ';
export const C = { sale: 1, saleQty: 2, comm: 3, logi: 4, acq: 5, storage: 6, promo: 7, other: 8, ord: 9, del: 10, canc: 11, pctFbo: 12, acqItem: 13, price: 14, cost: 15, pctFbs: 16, ordFbs: 17, ads: 18, commFbs: 19, saleFbs: 20, commFbo: 21, saleFbo: 22 };

export function unitCoefs(coefs, arts) {
    const byOffer = new Map(coefs.coefs.map(c => [coefs.articles[c[0]].o, c]));
    const W = 23;
    const groups = new Map(); // path → суммы
    const add = (key, c) => { let g = groups.get(key); if (!g) { g = new Float64Array(W); groups.set(key, g); } for (let i = 1; i < W; i++) if (i !== C.pctFbo && i !== C.pctFbs && i !== C.acqItem && i !== C.price && i !== C.cost) g[i] += c[i] || 0; };
    for (const a of arts) {
      const c = byOffer.get(a.o); if (!c) continue;
      add('', c);
      for (let d = 1; d <= a.parts.length; d++) add(a.parts.slice(0, d).join(SEP), c);
    }
    const noSkuOther = Object.entries(coefs.noSku || {}).filter(([b]) => !['sale', 'return', 'ads'].includes(b)).reduce((s, [, v]) => s + v, 0);
    const generalRate = coefs.totalSale > 0 ? Math.max(0, -noSkuOther / coefs.totalSale) : 0;
    const chain = a => [byOffer.get(a.o), ...a.parts.map((_, d) => groups.get(a.parts.slice(0, a.parts.length - d).join(SEP))), groups.get('')].filter(Boolean);
    const pick = (list, ok, val) => { for (const g of list) if (ok(g)) return val(g); return null; };
    return arts.map(a => {
      const L = chain(a), own = byOffer.get(a.o);
      const buyout = pick(L, g => g[C.del] + g[C.canc] >= 10, g => g[C.del] / (g[C.del] + g[C.canc])) ?? 0.8;
      // Комиссия — точная из карточки товара, отдельно для FBO и FBS; доля
      // FBS берётся по заказам дня (ниже), без них — по 30 дням.
      const factComm = pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3 && g[C.comm] < 0, g => -g[C.comm] / g[C.sale]);
      const pFbo = own && own[C.pctFbo] ? own[C.pctFbo] / 100 : null, pFbs = own && own[C.pctFbs] ? own[C.pctFbs] / 100 : null;
      // FBS: ставка зависит от скорости отгрузки (44 / 45 / 47%) — берём
      // фактическую среднюю FBS из финансов (товар → категория → кабинет).
      const factFbs = pick(L, g => g[C.saleFbs] > 0 && g[C.commFbs] < 0, g => -g[C.commFbs] / g[C.saleFbs]);
      const commFbo = pFbo ?? pFbs ?? factComm ?? 0.2, commFbs = factFbs ?? pFbs ?? pFbo ?? factComm ?? 0.2;
      const fbs30 = pick(L, g => g[C.ord] >= 5, g => g[C.ordFbs] / g[C.ord]) ?? 0;
      const commCard = pFbo !== null || pFbs !== null;
      const logi = pick(L, g => g[C.ord] >= 5 && g[C.logi] < 0, g => -g[C.logi] / g[C.ord]) ?? 0;
      const acq = pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -g[C.acq] / g[C.sale])) ?? 0.015;
      const other = (pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -(g[C.storage] + g[C.promo] + g[C.other]) / g[C.sale])) ?? 0) + generalRate;
      const ownLevel = own && own[C.del] + own[C.canc] >= 10;
      return { buyout, commFbo, commFbs, fbs30, commCard, comm: commFbo * (1 - fbs30) + commFbs * fbs30, logi, acq, other, cost: own && own[C.cost] ? own[C.cost] : null, ownLevel };
    });
}

// Прогноз по заказам: ordRub, ordQty, ads (расход на рекламу), fbs — доля FBS (по умолчанию из 30 дней).
export function unitProfit(k, { ordRub, ordQty, ads = 0, fbs }, taxPct = 6) {
  const sh = fbs === undefined || fbs === null ? k.fbs30 : fbs;
  const expRev = ordRub * k.buyout, expQty = ordQty * k.buyout;
  const comm = expRev * (k.commFbo * (1 - sh) + k.commFbs * sh);
  const logi = ordQty * k.logi, acq = expRev * k.acq, other = expRev * k.other;
  const cost = k.cost ? expQty * k.cost : 0, tax = expRev * taxPct / 100;
  const profit = expRev - comm - logi - acq - other - cost - tax - ads;
  return { expRev, expQty, comm, logi, acq, other, cost, tax, ads, profit, margin: expRev > 0 ? profit / expRev * 100 : null, noCost: !k.cost };
}
