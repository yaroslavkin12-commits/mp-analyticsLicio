// ЕДИНАЯ модель прибыли: коэффициенты юнит-экономики по артикулу (средние за
// 30 дней с подстраховкой «товар → категория → родитель → кабинет») и прогноз
// прибыли от заказов. Одна и та же для «Юнит-экономики», «Рекламы», «Аналитики
// продаж», ABC, «План / факт», «Цен и маржи» и калькулятора:
//   выкуп — за 90 дней без последней недели; логистика — прямая на отправку и
//   обратная на возврат (с учётом невыкупов); комиссия — FBO из карточки / FBS
//   по факту в доле отгрузок; эквайринг и прочее — % от продаж; налог — от цены
//   клиента (СПП с сайта; нет — по отчёту «Начисления»).
const SEP = ' / ';
export const C = { sale: 1, saleQty: 2, comm: 3, logi: 4, acq: 5, storage: 6, promo: 7, other: 8, ord: 9, del: 10, canc: 11, pctFbo: 12, acqItem: 13, price: 14, cost: 15, pctFbs: 16, ordFbs: 17, ads: 18, commFbs: 19, saleFbs: 20, commFbo: 21, saleFbo: 22, dSum: 23, dTrips: 24, rSum: 25, rTrips: 26, spp: 27 };

// shareOf(o, parts) — доля цены, которую платит покупатель (база налога); без неё — 1.
export function unitCoefs(coefs, arts, shareOf) {
    const byOffer = new Map(coefs.coefs.map(c => [coefs.articles[c[0]].o, c]));
    const W = 27;
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
    // Источник значения: товар / категория / кабинет — для подписей.
    const srcOf = (L, own, ok) => { for (let i = 0; i < L.length; i++) if (ok(L[i])) return L[i] === own ? 'own' : i === L.length - 1 ? 'all' : 'cat'; return 'def'; };
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
      // Логистика: прямая на одну отправку и обратная на один возврат (факт списаний).
      // На заказ = прямая + обратная × (1 − выкуп); на проданную штуку — то же / выкуп.
      const direct = pick(L, g => g[C.dTrips] >= 3 && g[C.dSum] < 0, g => -g[C.dSum] / g[C.dTrips]);
      const ret = pick(L, g => g[C.rTrips] >= 2 && g[C.rSum] < 0, g => -g[C.rSum] / g[C.rTrips]) ?? direct;
      const logiOld = pick(L, g => g[C.ord] >= 5 && g[C.logi] < 0, g => -g[C.logi] / g[C.ord]) ?? 0;
      const logi = direct !== null ? direct + (ret ?? direct) * (1 - buyout) : logiOld;
      const acq = pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -g[C.acq] / g[C.sale])) ?? 0.015;
      const other = (pick(L, g => g[C.sale] > 0 && g[C.saleQty] >= 3, g => Math.max(0, -(g[C.storage] + g[C.promo] + g[C.other]) / g[C.sale])) ?? 0) + generalRate;
      const ownLevel = own && own[C.del] + own[C.canc] >= 10;
      // Налог — от того, что платит покупатель: цена × (1 − СПП). СПП — с сайта; нет — по «Начислениям».
      const sppSite = own && own[C.spp] !== null && own[C.spp] !== undefined ? own[C.spp] : null;
      const share = sppSite !== null ? 1 - sppSite / 100 : shareOf ? (shareOf(a.o, a.parts) ?? 1) : 1;
      const src = {
        buyout: srcOf(L, own, g => g[C.del] + g[C.canc] >= 10),
        logi: direct !== null ? srcOf(L, own, g => g[C.dTrips] >= 3 && g[C.dSum] < 0) : 'old',
        acq: srcOf(L, own, g => g[C.sale] > 0 && g[C.saleQty] >= 3),
        spp: sppSite !== null ? 'site' : 'report',
      };
      return { platform:coefs._wb?'wb':'ozon', buyout, commFbo, commFbs, fbs30, commCard, comm: commFbo * (1 - fbs30) + commFbs * fbs30, logi, direct, ret: ret ?? direct, acq, other,
        cost: own && own[C.cost] ? own[C.cost] : null, ownLevel, share, spp: (1 - share) * 100, price: own && own[C.price] ? own[C.price] : null, src };
    });
}

// Прогноз по заказам: ordRub, ordQty, ads (расход на рекламу), fbs — доля FBS (по умолчанию из 30 дней).
// selfRub — самовыкупы (в заказах их нет): товар и деньги возвращаются, но Ozon берёт
// комиссию и эквайринг, а выручка попадает в налог (как в P&L) — это расход. Логистики нет:
// доставку Ozon списывает, но столько же перечисляет «за доставку от покупателя».
// selfFbs — отправлений FBS/rFBS: сервисный сбор за интеграцию с логистической платформой.
export const SELF_FBS_FEE = 20;
export function unitProfit(k, { ordRub, ordQty, ads = 0, fbs, selfRub = 0, selfFbs = 0 }, taxPct = 6) {
  const sh = fbs === undefined || fbs === null ? k.fbs30 : fbs;
  const expRev = ordRub * k.buyout, expQty = ordQty * k.buyout;
  const comm = expRev * (k.commFbo * (1 - sh) + k.commFbs * sh);
  const logi = ordQty * k.logi, acq = expRev * k.acq, other = expRev * k.other;
  // Налог — от того, что заплатил покупатель (цена после скидки Ozon), а не от нашей цены.
  const cost = k.cost ? expQty * k.cost : 0, tax = expRev * (k.share ?? 1) * taxPct / 100;
  const selfCost = (selfRub > 0 ? selfRub * (k.commFbo * (1 - sh) + k.commFbs * sh + k.acq) + selfRub * (k.share ?? 1) * taxPct / 100 : 0) + selfFbs * (k.platform === 'wb' ? 0 : SELF_FBS_FEE);
  const profit = expRev - comm - logi - acq - other - cost - tax - ads - selfCost;
  return { expRev, expQty, comm, logi, acq, other, cost, tax, ads, selfCost, profit, margin: expRev > 0 ? profit / expRev * 100 : null, noCost: !k.cost };
}
