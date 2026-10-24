// Только новый общий план Ozon. Старые планы кабинетов не изменяются.
const SHOPS = ['defly', 'nabauto', 'alex', 'fullgas', 'accent'];
const SEP = ' / ';
const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj || {}, k);
function leafPath(path, branches) {
  const p = String(path || 'Без категории').split(SEP);
  return p.length > 1 ? p.slice(0, 2).join(SEP) : branches.has(p[0]) ? p[0] + SEP + 'Без подкатегории' : p[0];
}
function taxonomy(catalogs, extra = []) {
  const paths = [...Object.values(catalogs).flatMap(a => a.map(x => x.cat || 'Без категории')), ...extra];
  const branches = new Set(paths.filter(x => x.includes(SEP)).map(x => x.split(SEP)[0]));
  const byShop = {}, leaves = new Set(extra);
  for (const shop of SHOPS) {
    byShop[shop] = {};
    for (const a of catalogs[shop] || []) { const path = leafPath(a.cat, branches); byShop[shop][a.o] = path; leaves.add(path); }
  }
  return { byShop, paths: [...leaves].sort((a, b) => (b.startsWith('Чехлы') - a.startsWith('Чехлы')) || a.localeCompare(b, 'ru')), branches };
}
function validateTargets(input) {
  if (!Array.isArray(input) || !input.length || input.length > 200) throw new Error('Задайте хотя бы один план (не более 200 строк)');
  const paths = new Set();
  return input.map(t => {
    const path = String(t.path || '').trim();
    if (!path || path.length > 200 || paths.has(path)) throw new Error('Категории плана должны быть уникальными');
    if ([...paths].some(p => p.startsWith(path + SEP) || path.startsWith(p + SEP))) throw new Error('Нельзя одновременно планировать родителя и его подкатегорию');
    paths.add(path);
    const qty = Number(t.qty), mean = Number(t.mean);
    if (t.qty == null || t.mean == null || t.qty === '' || t.mean === '' || !Number.isSafeInteger(qty) || qty < 0 || qty > 1e8 || !Number.isFinite(mean) || mean <= 0 || mean > 1e8) throw new Error(`${path}: нужны целые неотрицательные штуки и положительное поступление за выкуп`);
    if (qty * mean > Number.MAX_SAFE_INTEGER / 100) throw new Error(`${path}: сумма плана слишком велика для точного расчёта в копейках`);
    const weights = {}, means = {};
    for (const shop of SHOPS) for (const [field, dest, positive] of [['weights', weights, false], ['means', means, true]]) {
      const v = t[field]?.[shop];
      if (v === '' || v === undefined || v === null) continue;
      if (!Number.isFinite(Number(v)) || Number(v) < 0 || (positive && Number(v) === 0) || Number(v) > 1e8) throw new Error(`${path}: неверная ручная настройка ${shop}`);
      dest[shop] = Number(v);
    }
    return { path, qty, mean, weights, means };
  });
}
// Метод наибольших остатков: сумма назначенных целых штук всегда равна цели.
function integerShares(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('Нет положительных долей для распределения');
  const raw = weights.map(w => total * w / sum), out = raw.map(Math.floor);
  const order = raw.map((v, i) => ({ i, r: v - out[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let n = total - out.reduce((a, b) => a + b, 0), i = 0; i < n; i++) out[order[i].i]++;
  return out;
}
function allocate(targetsInput, basis, source = 'fact') {
  const targets = validateTargets(targetsInput), rows = [], errors = [], warnings = [];
  for (const t of targets) {
    const info = SHOPS.map(id => ({ id, ...(basis.shops[id] || {}), metric: basis.shops[id]?.byPath?.[t.path] || { qty: 0, payout: 0 } }));
    if (t.qty === 0) {
      rows.push({ path: t.path, qty: 0, mean: t.mean, amount: 0, factor: 1, shops: info.map(x => ({ id: x.id, label: x.label || x.id, qty: 0, share: 0, baseQty: x.metric.qty, baseMean: null, mean: null, amount: 0 })) });
      continue;
    }
    const positive = info.reduce((s, x) => s + Math.max(0, x.metric.qty), 0);
    const weights = info.map(x => has(t.weights, x.id) ? t.weights[x.id] : positive > 0 ? Math.max(0, x.metric.qty) / positive * 100 : 0);
    const issues = [];
    for (const x of info) {
      if ((x.error || x.partial || x.metric.qty < 0) && !has(t.weights, x.id)) issues.push(`${x.label || x.id}: ${x.error || (x.metric.qty < 0 ? 'возвратов больше выкупов' : 'неполный период финансов')}; задайте долю вручную, включая 0 для исключения`);
      if (x.error || x.partial || x.metric.qty < 0) warnings.push(`${t.path} · ${x.label || x.id}: распределение использует ручное решение при неполных данных или возвратах`);
    }
    if (!weights.some(w => w > 0)) issues.push('Нет положительных выкупов. Укажите относительные доли вручную');
    if (issues.length) { errors.push(...issues.map(s => `${t.path} · ${s}`)); continue; }
    const quantities = integerShares(t.qty, weights);
    const means = info.map(x => {
      if (has(t.means, x.id)) return t.means[x.id];
      const m = source === 'forecast' ? x.metric.forecast : x.metric;
      if (source === 'forecast' && (x.forecastError || m?.missing)) return null;
      return m && m.qty > 0 ? m.payout / m.qty : null;
    });
    info.forEach((x, i) => { if (quantities[i] > 0 && !(means[i] > 0)) issues.push(`${x.label || x.id}: нет положительного среднего ${source === 'forecast' ? 'прогноза' : 'поступления'}; задайте базовое поступление вручную`); });
    if (issues.length) { errors.push(...issues.map(s => `${t.path} · ${s}`)); continue; }
    const baseTotal = quantities.reduce((s, q, i) => s + q * (means[i] || 0), 0);
    const factor = baseTotal > 0 ? t.qty * t.mean / baseTotal : 1;
    if (factor > 1.3 || factor < 0.7) warnings.push(`${t.path}: цель меняет базовое поступление на ${Math.round((factor - 1) * 100)}%. Проверьте достижимость`);
    const shops = info.map((x, i) => ({ id: x.id, label: x.label || x.id, qty: quantities[i], share: weights[i] / weights.reduce((a, b) => a + b, 0), baseQty: x.metric.qty, baseMean: means[i], mean: quantities[i] ? means[i] * factor : null, amount: quantities[i] ? quantities[i] * means[i] * factor : 0, manualWeight: has(t.weights, x.id), manualMean: has(t.means, x.id) }));
    // Полная точность внутри; только отображение округляется. Убираем ошибку float
    // в общей сумме, не округляя средние каждого магазина до целых рублей.
    const last = shops.findLast(x => x.qty > 0);
    if (last) { last.amount += t.qty * t.mean - shops.reduce((s, x) => s + x.amount, 0); last.mean = last.amount / last.qty; }
    rows.push({ path: t.path, qty: t.qty, mean: t.mean, amount: t.qty * t.mean, factor, shops });
  }
  return { targets, rows, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}
module.exports = { SHOPS, SEP, leafPath, taxonomy, validateTargets, integerShares, allocate };
