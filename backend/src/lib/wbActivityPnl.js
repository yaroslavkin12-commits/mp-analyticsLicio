// Управленческий P&L использует день расхода рекламы. Исходный финансовый
// отчёт не изменяется и остаётся источником фактических поступлений.
function activityPnl(data) {
  if(data.financeSource!=='wb'||!data.adStatistics)return data;
  const ads=data.adStatistics,bi=data.buckets.indexOf('ads'),financialAvailable={...data.available};
  const available={mn:ads.from&&financialAvailable.mn?(ads.from>financialAvailable.mn?ads.from:financialAvailable.mn):null,mx:ads.to&&financialAvailable.mx?(ads.to<financialAvailable.mx?ads.to:financialAvailable.mx):null};
  const cashAds={rows:data.rows.filter(r=>r[2]===bi),noSku:data.noSku.filter(r=>r[1]===bi),available:financialAvailable};
  return {...data,adsBasis:'activity',financialAvailable,available,managementReady:!!available.mn&&!!available.mx&&available.mn<=available.mx,cashAds,rows:[...data.rows.filter(r=>r[2]!==bi),...ads.rows.map(([ai,di,v])=>[ai,di,bi,-v,0])],noSku:[...data.noSku.filter(r=>r[1]!==bi),...ads.unallocated.map((v,di)=>[di,bi,-v]).filter(r=>r[2])],ads:[],adNoSku:data.dates.map(()=>0)};
}
module.exports={activityPnl};
