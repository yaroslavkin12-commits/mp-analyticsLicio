const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{pathToFileURL}=require('node:url');
test('Настоящий клиент сотрудника отправляет добавление и удаление заметки; остальные записи блокируются до отправки',async()=>{
 const root=path.resolve(__dirname,'../../dashboard/src'),accessUrl=pathToFileURL(path.join(root,'lib/accessClient.js')).href;
 const access=await import(accessUrl);access.configureAccess({id:7,role:'user',accessScope:{paths:['Дефлекторы']}});
 const axiosUrl=pathToFileURL(require.resolve('axios',{paths:[root]})).href;
 let code=fs.readFileSync(path.join(root,'api.js'),'utf8').replace("from 'axios'",`from '${axiosUrl}'`).replace("from './lib/accessClient'",`from '${accessUrl}'`);
 code=code.replace("from './lib/cabinets.js'", `from '${pathToFileURL(path.join(root,'lib/cabinets.js')).href}'`);
 const api=await import('data:text/javascript;base64,'+Buffer.from(code+'\nexport const testClient=api;').toString('base64'));
 const sent=[];api.testClient.defaults.adapter=async cfg=>{sent.push({url:cfg.url,method:cfg.method,data:cfg.data});return {status:200,statusText:'OK',headers:{},config:cfg,data:{success:true,data:{id:'12'}}};};
 try{
  await api.addAdsEvent('defly','OWN-2D','2026-11-16','Проверили фото');
  await api.deleteAdsEvent('defly','12');
  assert.deepEqual(sent.map(r=>[r.url,r.method]),[['/promo/events','post'],['/ads/events/12','delete']]);
  assert.equal(JSON.parse(sent[0].data).offerId,'OWN-2D');
  await assert.rejects(api.addAdsEvent('defly',null,'2026-11-16','Общая запись'));
  await assert.rejects(api.addAdsEvent('defly_wb','OWN-2D','2026-11-16','WB'));
  await assert.rejects(api.testClient.post('/sales/category',{cabinet:'defly'}));
  await assert.rejects(api.testClient.post('/promo/manual',{cabinet:'defly'}));
  await assert.rejects(api.deleteAdsEvent('defly','p:OWN:date'));
  assert.equal(sent.length,2);
 }finally{access.configureAccess(null);}
});
