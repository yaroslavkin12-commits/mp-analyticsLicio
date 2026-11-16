const {test}=require('node:test'),assert=require('node:assert/strict');
let lastSql, lastArgs;
const events=new Map([['1',{offer:'OWN',auto:false}],['2',{offer:'OTHER',auto:false}],['3',{offer:'OWN',auto:true}]]);
require.cache[require.resolve('../src/db')]={exports:{query:async(sql,args)=>{
 if(sql.startsWith('DELETE FROM ad_events')){lastSql=sql;lastArgs=args;const e=events.get(args[0]);return e&&!e.auto&&args[2].includes(e.offer)?[{id:args[0]}]:[];}return [];
}}};
const router=require('../src/routes/ads');
const handler=router.stack.find(l=>l.route?.path==='/events/:id'&&l.route.methods.delete).route.stack[0].handle;
test('Удаление ограничено ручной записью и текущим доступом к артикулу в SQL',async()=>{
 for(const [id,expected] of [['1',200],['2',403],['3',403],['99',403]]){
 let code=200;const res={status(n){code=n;return this;},json(){return this;}};
 await handler({restricted:true,categoryContext:{allowed:new Map([['OWN',{}]])},params:{id},query:{cabinet:'defly'}},res);
 assert.equal(code,expected);assert.match(lastSql,/auto = false/);assert.match(lastSql,/kind = 'note'/);assert.match(lastSql,/offer_id = ANY/);assert.deepEqual(lastArgs,[id,'defly',['OWN']]);
 }
});
