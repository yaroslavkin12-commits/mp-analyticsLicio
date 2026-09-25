import React, { useState, useMemo } from 'react';

// Калькулятор юнит-экономики — считает чистую прибыль/маржу/ROI по одному
// товару с учётом расходов маркетплейса (комиссия, эквайринг, логистика,
// хранение, платная приёмка, реклама) и расходов вне маркетплейса
// (себестоимость, брак, налог, прочие операционные). Полностью на клиенте,
// без бэкенда и сохранения — как отдельный инструмент unit.truestats.ru,
// но встроенный прямо в дашборд. Считает для WB и Ozon (разные площадки —
// разные типовые % комиссии/логистики, но все поля можно менять руками).

const MARKETPLACES = [
  ['wb', 'Wildberries', { commission: 17, logistics: 60, storage: 5, acquiring: 0 }],
  ['ozon', 'Ozon', { commission: 15, logistics: 50, storage: 4, acquiring: 1.5 }],
];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(v) { return `${Math.round(v).toLocaleString('ru-RU')} ₽`; }
function fmtPct(v) { return `${v.toFixed(1)}%`; }

function Field({ label, value, onChange, suffix, hint, type = 'number', step }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text2)', marginBottom: 5 }}>{label}</div>
      <div style={{ position: 'relative' }}>
        <input
          type={type} value={value} step={step}
          onChange={e => onChange(e.target.value)}
          style={{
            width: '100%', padding: '8px 10px', paddingRight: suffix ? 34 : 10, borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text)', fontSize: 13.5,
            boxSizing: 'border-box',
          }}
        />
        {suffix && <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text3)', fontSize: 12.5 }}>{suffix}</span>}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function ResultRow({ label, value, bold, negative, indent }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', padding: '7px 0',
      borderTop: bold ? '1px solid var(--border)' : 'none', marginTop: bold ? 6 : 0,
      paddingLeft: indent ? 14 : 0,
    }}>
      <span style={{ fontSize: bold ? 13.5 : 12.5, fontWeight: bold ? 700 : 400, color: indent ? 'var(--text2)' : 'var(--text)' }}>{label}</span>
      <span style={{ fontSize: bold ? 14.5 : 12.5, fontWeight: bold ? 700 : 600, color: negative ? 'var(--danger)' : 'var(--text)' }}>{value}</span>
    </div>
  );
}

export default function Calculator() {
  const [mp, setMp] = useState('ozon');
  const preset = MARKETPLACES.find(([id]) => id === mp)[2];

  const [name, setName] = useState('');
  const [priceBefore, setPriceBefore] = useState('');
  const [mpDiscount, setMpDiscount] = useState('20');
  const [costPrice, setCostPrice] = useState('');
  const [buyoutPct, setBuyoutPct] = useState('75');
  const [defectPct, setDefectPct] = useState('2');

  const [commission, setCommission] = useState(String(preset.commission));
  const [acquiring, setAcquiring] = useState(String(preset.acquiring));
  const [logistics, setLogistics] = useState(String(preset.logistics));
  const [storage, setStorage] = useState(String(preset.storage));
  const [paidReception, setPaidReception] = useState('0');
  const [adSpend, setAdSpend] = useState('0');
  const [taxPct, setTaxPct] = useState('6');
  const [opex, setOpex] = useState('0');

  function switchMp(id) {
    setMp(id);
    const p = MARKETPLACES.find(([mid]) => mid === id)[2];
    setCommission(String(p.commission)); setAcquiring(String(p.acquiring));
    setLogistics(String(p.logistics)); setStorage(String(p.storage));
  }

  const r = useMemo(() => {
    const priceBeforeN = num(priceBefore);
    const priceAfter = priceBeforeN * (1 - num(mpDiscount) / 100);
    const buyout = Math.max(1, num(buyoutPct)); // % выкупа, минимум 1 чтобы не делить на 0
    const trips = 100 / buyout; // среднее число "поездок" логистики на 1 реально проданную единицу (невыкупленные едут туда-обратно)

    const commissionCost = priceAfter * num(commission) / 100;
    const acquiringCost = priceAfter * num(acquiring) / 100;
    const logisticsCost = num(logistics) * trips;
    const storageCost = num(storage);
    const receptionCost = num(paidReception);
    const adCost = num(adSpend);
    const mpExpenses = commissionCost + acquiringCost + logisticsCost + storageCost + receptionCost + adCost;

    const defectCost = num(costPrice) * num(defectPct) / 100;
    const taxCost = priceAfter * num(taxPct) / 100;
    const nonMpExpenses = num(costPrice) + defectCost + taxCost + num(opex);

    const netProfit = priceAfter - mpExpenses - nonMpExpenses;
    const margin = priceAfter > 0 ? (netProfit / priceAfter) * 100 : 0;
    const investment = num(costPrice) + adCost;
    const roi = investment > 0 ? (netProfit / investment) * 100 : 0;

    return {
      priceBeforeN, priceAfter, commissionCost, acquiringCost, logisticsCost, storageCost,
      receptionCost, adCost, mpExpenses, defectCost, taxCost, nonMpExpenses, netProfit, margin, roi, trips,
    };
  }, [priceBefore, mpDiscount, commission, acquiring, logistics, storage, paidReception, adSpend, costPrice, buyoutPct, defectPct, taxPct, opex]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Калькулятор юнит-экономики</h2>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 16, lineHeight: 1.5, maxWidth: 720 }}>
        Считает чистую прибыль, маржу и ROI с одной продажи товара с учётом расходов маркетплейса
        (комиссия, эквайринг, логистика, хранение, платная приёмка, реклама) и расходов вне него
        (себестоимость, брак, налог). Логистика домножается на среднее число поездок на 1 продажу —
        невыкупленные заказы всё равно едут туда и обратно за счёт продавца.
      </div>

      <div style={{ display: 'flex', gap: 3, background: 'var(--surface2)', borderRadius: 8, padding: 3, marginBottom: 16, width: 'fit-content' }}>
        {MARKETPLACES.map(([id, label]) => (
          <button key={id} onClick={() => switchMp(id)} style={{
            padding: '6px 16px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 500,
            background: mp === id ? (id === 'wb' ? 'var(--accent-wb)' : 'var(--accent-oz)') : 'transparent',
            color: mp === id ? '#fff' : 'var(--text2)',
          }}>{label}</button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 420px) minmax(280px, 380px)', gap: 16, alignItems: 'start' }}>
        <div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Товар</div>
            <Field label="Название товара" type="text" value={name} onChange={setName} />
            <Field label="Цена до скидки МП" value={priceBefore} onChange={setPriceBefore} suffix="₽" />
            <Field label="Скидка МП" value={mpDiscount} onChange={setMpDiscount} suffix="%" />
            <Field label="Себестоимость" value={costPrice} onChange={setCostPrice} suffix="₽" />
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><Field label="Процент выкупа" value={buyoutPct} onChange={setBuyoutPct} suffix="%"
                hint={`≈ ${r.trips.toFixed(2)} поездок логистики на продажу`} /></div>
              <div style={{ flex: 1 }}><Field label="Процент брака" value={defectPct} onChange={setDefectPct} suffix="%" /></div>
            </div>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Расходы маркетплейса</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><Field label="Комиссия" value={commission} onChange={setCommission} suffix="%" /></div>
              <div style={{ flex: 1 }}><Field label="Эквайринг" value={acquiring} onChange={setAcquiring} suffix="%" /></div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><Field label="Логистика (за поездку)" value={logistics} onChange={setLogistics} suffix="₽" /></div>
              <div style={{ flex: 1 }}><Field label="Хранение" value={storage} onChange={setStorage} suffix="₽" /></div>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><Field label="Платная приёмка" value={paidReception} onChange={setPaidReception} suffix="₽" /></div>
              <div style={{ flex: 1 }}><Field label="Реклама" value={adSpend} onChange={setAdSpend} suffix="₽" /></div>
            </div>
          </div>

          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Расходы вне маркетплейса</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}><Field label="Налог" value={taxPct} onChange={setTaxPct} suffix="%" hint="От цены продажи (напр. УСН «доходы» 6%)" /></div>
              <div style={{ flex: 1 }}><Field label="Прочие расходы" value={opex} onChange={setOpex} suffix="₽" /></div>
            </div>
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, position: 'sticky', top: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Результаты расчёта</div>
          <ResultRow label="Цена до скидки МП" value={fmt(r.priceBeforeN)} />
          <ResultRow label="Цена после скидки МП" value={fmt(r.priceAfter)} bold />

          <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Расходы МП</div>
          <ResultRow label="Комиссия" value={fmt(r.commissionCost)} indent negative />
          <ResultRow label="Эквайринг" value={fmt(r.acquiringCost)} indent negative />
          <ResultRow label="Логистика" value={fmt(r.logisticsCost)} indent negative />
          <ResultRow label="Хранение" value={fmt(r.storageCost)} indent negative />
          <ResultRow label="Платная приёмка" value={fmt(r.receptionCost)} indent negative />
          <ResultRow label="Реклама" value={fmt(r.adCost)} indent negative />
          <ResultRow label="Итого расходы МП" value={fmt(r.mpExpenses)} bold negative />

          <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase' }}>Расходы вне МП</div>
          <ResultRow label="Себестоимость" value={fmt(num(costPrice))} indent negative />
          <ResultRow label="Брак" value={fmt(r.defectCost)} indent negative />
          <ResultRow label="Налог" value={fmt(r.taxCost)} indent negative />
          <ResultRow label="Прочие расходы" value={fmt(num(opex))} indent negative />
          <ResultRow label="Итого расходы вне МП" value={fmt(r.nonMpExpenses)} bold negative />

          <div style={{ marginTop: 14, padding: '14px 0', borderTop: '2px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Чистая прибыль</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: r.netProfit >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmt(r.netProfit)}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, background: 'var(--surface2)', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>Маржа</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: r.margin >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(r.margin)}</div>
            </div>
            <div style={{ flex: 1, background: 'var(--surface2)', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 3 }}>ROI</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: r.roi >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{fmtPct(r.roi)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
