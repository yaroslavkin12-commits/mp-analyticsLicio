// forPay — уже после комиссии и эквайринга. Отдельные услуги вычитаются один раз.
const BUCKETS = ['sale','return','commission','acquiring','logistics','storage','promo','other','ads'];
const num = (r,k) => { const v=r[k]; if(v==null||v==='')return 0; const n=Number(v); if(!Number.isFinite(n))throw new Error('Некорректное денежное поле WB: '+k); return n; };
function entries(rows) {
  const out=[];
  for(const r of rows) {
    const date=String(r.rrDate||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('В финансовом отчёте WB отсутствует дата операции');
    if(r.currency && r.currency!=='RUB')throw new Error('Финансовый отчёт WB содержит валюту, отличную от рублей');
    const sign=r.docTypeName==='Возврат'?-1:1, op=r.sellerOperName||'';
    const put=(bucket,amount,qty=0,taxBase=0)=>{if(amount||qty)out.push({date,offer:r.vendorCode||null,sku:r.nmId||null,name:r.title||'',bucket,amount,qty,taxBase,srid:r.srid||null,sourceId:r.id,operation:r.sellerOperName||'',reason:r.bonusTypeName||''});};
    if(op==='Продажа'||op==='Возврат') {
      if(r.forPay==null || r.retailPriceWithDisc==null || r.quantity==null || r.retailAmount==null)throw new Error('Неполная финансовая строка продажи WB');
      const gross=sign*num(r,'retailPriceWithDisc'), acq=sign*num(r,'acquiringFee'), paid=sign*num(r,'forPay');
      put(sign===1?'sale':'return',gross,sign*num(r,'quantity'),sign*num(r,'retailAmount'));
      put('commission',paid-gross+acq); put('acquiring',-acq);
    } else put('other',sign*num(r,'forPay'));
    // rebillLogisticCost и ppvzReward — расшифровки расходов WB внутри услуг, повторно не удерживаем.
    // Софинансирование рассрочки уже уменьшает forPay в исходном отчёте.
    put('logistics',-num(r,'deliveryService')); put('storage',-num(r,'paidStorage'));
    const deduction=num(r,'deduction');
    if(deduction&&!Object.hasOwn(r,'bonusTypeName'))throw new Error('Для удержаний WB требуется расшифровка bonusTypeName');
    put(/WB Продвижение/i.test(r.bonusTypeName||'')?'ads':'other',-deduction);
    put('other',-num(r,'penalty')-num(r,'paidAcceptance')-num(r,'additionalPayment')-sign*num(r,'cashbackAmount')-sign*num(r,'cashbackCommissionChange')-num(r,'paymentSchedule')+sign*num(r,'cashbackDiscount'));
  }
  return out;
}
function pnl(dataset, {articles, index, costs=[], prefs, dates, order}) {
  const ledger=entries(dataset.rows), byDate=new Map(dates.map((d,i)=>[d,i]));
  const rows=new Map(), noSku=new Map(), taxBase=new Map(), self=new Map();
  const add=(map,key,value)=>map.set(key,(map.get(key)||0)+value);
  for(const e of ledger) {
    if(!byDate.has(e.date))continue;
    const di=byDate.get(e.date), bi=BUCKETS.indexOf(e.bucket);
    if(!e.offer && !(Number(e.sku)>0)) { add(noSku,di+'|'+bi,e.amount); continue; }
    const ai=index({offer:e.offer,nmId:e.sku,name:e.name});
    const key=ai+'|'+di+'|'+bi, row=rows.get(key)||[ai,di,bi,0,0]; row[3]+=e.amount;row[4]+=e.qty;rows.set(key,row);
    if(e.taxBase)add(taxBase,ai+'|'+di,e.taxBase);
    if(e.qty && prefs.self[`${e.srid}|${e.sku}`])add(self,ai+'|'+di,e.qty);
  }
  const costMap=new Map();for(const c of costs)if(!costMap.has(c.article.toLowerCase()))costMap.set(c.article.toLowerCase(),Number(c.cost_price));
  const triples=map=>[...map].map(([key,v])=>[...key.split('|').map(Number),v]);
  return {_wb:true,financeSource:'wb',dates,articles,rows:[...rows.values()],noSku:triples(noSku),taxBase:triples(taxBase),self:triples(self),buckets:BUCKETS,cost:articles.map(a=>costMap.get(a.o.toLowerCase())??null),ads:[],adNoSku:dates.map(()=>0),order,available:{mn:dataset.meta.from,mx:dataset.meta.to},from:dates[0],to:dates.at(-1),sourceRows:dataset.rows.length};
}
module.exports={BUCKETS,entries,pnl};
function coefs(dataset,{articles,index,costs=[],orders=[],sales=[],prices=[],prefs,today,order}) {
  const dayjs=require('dayjs'),since=dayjs(dataset.meta.to).subtract(29,'day').format('YYYY-MM-DD'),by=new Map(),noSku={},names=new Map();
  const get=ai=>{if(!by.has(ai)){const r=Array(28).fill(0);r[0]=ai;for(const k of [12,13,14,15,16,27])r[k]=null;by.set(ai,r);}return by.get(ai);};
  const gross=new Map(),customer=new Map(),bucketCol={commission:3,logistics:4,acquiring:5,storage:6,promo:7,other:8,ads:18};
  for(const e of entries(dataset.rows).filter(e=>e.date>=since&&e.date<=dataset.meta.to)) {
    names.set(e.bucket,(names.get(e.bucket)||0)+e.amount);
    if(!e.offer&&!(Number(e.sku)>0)){noSku[e.bucket]=(noSku[e.bucket]||0)+e.amount;continue;}
    const ai=index({offer:e.offer,nmId:e.sku,name:e.name}),r=get(ai);
    if(['sale','return'].includes(e.bucket)){r[1]+=e.amount;r[2]+=e.qty;gross.set(ai,(gross.get(ai)||0)+e.amount);customer.set(ai,(customer.get(ai)||0)+e.taxBase);}
    else r[bucketCol[e.bucket]]+=e.amount;
  }
  const sold=new Set(sales.filter(r=>r.type==='sale').map(r=>r.srid)),returned=new Set(sales.filter(r=>r.type==='return').map(r=>r.srid));
  const older=dayjs(today).subtract(90,'day').format('YYYY-MM-DD'),mature=dayjs(today).subtract(7,'day').format('YYYY-MM-DD');
  const fbs=new Map();
  for(const o of orders) {
    if(prefs.self[`${o.srid||o.id}|${o.nmId}`])continue;
    const ai=index(o),r=get(ai);
    if(o.date>=since&&!o.cancelled){r[9]++;if(/продавца/i.test(o.warehouseType||''))r[17]++;const k=ai+'|'+o.date,v=fbs.get(k)||[ai,o.date,0,0];v[2]++;if(/продавца/i.test(o.warehouseType||''))v[3]++;fbs.set(k,v);}
    if(o.date>=older&&o.date<=mature){if(o.cancelled||returned.has(o.srid))r[11]++;else if(o.srid&&sold.has(o.srid))r[10]++;}
  }
  const costMap=new Map();for(const c of costs)if(!costMap.has(c.article.toLowerCase()))costMap.set(c.article.toLowerCase(),Number(c.cost_price));
  for(const [ai,r] of by){const a=articles[ai];r[15]=costMap.get(a.o.toLowerCase())??null;r[14]=Number(prices.find(p=>String(p.nmId)===a.sku)?.price)||null;if(gross.get(ai)>0)r[27]=(1-customer.get(ai)/gross.get(ai))*100;}
  return {_wb:true,financeSource:'wb',articles,coefs:[...by.values()],noSku,totalSale:[...by.values()].reduce((s,r)=>s+r[1],0),names:[...names].map(([b,v])=>[b,b,v]),since,order,fbsDays:[...fbs.values()]};
}
module.exports.coefs=coefs;
