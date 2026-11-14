const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../../browser-extension/soinvest/background.js'),'utf8');
function setup(mode='ok'){
 const state={apiKey:'TEST-SENTINEL',server:'https://defly-analytics.ru'},requests=[],phases=[];
 const noop=()=>{},on={addListener:noop};
 const chrome={runtime:{onInstalled:on,onStartup:on,onMessage:on},alarms:{create:noop,get:noop,onAlarm:on},storage:{local:{get:async()=>({...state}),set:async d=>{Object.assign(state,JSON.parse(JSON.stringify(d)));if(d.lastRun)phases.push(d.lastRun.phase);},remove:async k=>delete state[k]}},tabs:{query:async()=>[{id:1,status:'complete'}],remove:async()=>{}},scripting:{executeScript:async()=>mode==='seller-timeout'?new Promise(()=>{}):[{result:{status:200,text:JSON.stringify({items:[{item_id:1,price:100}]})}}]}};
 const ctx=vm.createContext({chrome,AbortController,Date,JSON,console,setTimeout:(fn,ms)=>setTimeout(fn,ms>=25000?30:0),clearTimeout,fetch:async(url,opts)=>{
  requests.push({url,key:opts.headers['X-Api-Key']});
  if(mode==='service-timeout')return new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(Object.assign(Error(),{name:'AbortError'}))));
  const status=mode==='bad-key'?401:200;
  return {ok:status===200,status,json:async()=>url.endsWith('/targets')?{success:true,data:[{cabinet:'defly',companyId:1,productIds:[1]}]}:{success:true,data:{matched:1}}};
 }});
 vm.runInContext(source+'\nthis.probe={run,checkConnection};',ctx);return {...ctx.probe,state,requests,phases};
}
test('Расширение различает отсутствующий ключ, отказ ключа и отсутствие связи; ключ не попадает в результат',async()=>{
 const missing=setup();delete missing.state.apiKey;await missing.checkConnection();assert.equal(missing.requests.length,0);assert.equal(missing.state.connectionCheck.ok,false);
 const bad=setup('bad-key');await bad.checkConnection();assert.equal(bad.state.connectionCheck.ok,false);assert.match(bad.state.connectionCheck.message,/Ключ не принят/);
 const timeout=setup('service-timeout');await timeout.checkConnection();assert.equal(timeout.state.connectionCheck.running,false);assert.match(timeout.state.connectionCheck.message,/нет ответа/);
 assert.ok(!JSON.stringify(timeout.state.connectionCheck).includes('TEST-SENTINEL'));
});
test('Успешный сбор показывает этапы и подтверждает принятие цен; зависание Ozon завершает сбор ошибкой',async()=>{
 const ok=setup();await ok.run('test');assert.equal(ok.state.lastRun.running,false);assert.equal(ok.state.lastRun.cabinets.defly.matched,1);assert.ok(ok.phases.some(p=>p.includes('Отправляем')));assert.ok(ok.requests.every(r=>r.key==='TEST-SENTINEL'));
 const stalled=setup('seller-timeout');await stalled.run('test');assert.equal(stalled.state.lastRun.running,false);assert.match(stalled.state.lastRun.error,/Ozon.*нет ответа/);
});
