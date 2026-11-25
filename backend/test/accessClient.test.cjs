const test=require('node:test'),assert=require('node:assert/strict');
test('Браузерные настройки, набор выгрузки и история отделены по пользователю и категории; общий профиль сохраняет прежние настройки',async()=>{
 const client=await import('../../dashboard/src/lib/accessClient.js');
 const store=new Map([['basket','PRIVATE-OWNER']]);global.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 client.configureAccess({id:1,role:'owner',accessScope:null});assert.equal(client.accessStorage.getItem('basket'),'PRIVATE-OWNER');
 client.configureAccess({id:2,role:'user',accessScope:{paths:['Дефлекторы / Окна / 2D']}});
 assert.equal(client.accessMode().readOnly,true);assert.equal(client.accessStorage.getItem('basket'),null);assert.ok(client.accessMode().cacheTag);
 client.accessStorage.setItem('basket','ONLY-2D');assert.equal(client.accessStorage.getItem('basket'),'ONLY-2D');
 client.configureAccess({id:2,role:'user',accessScope:{paths:['Одежда']}});assert.equal(client.accessStorage.getItem('basket'),null);
 client.configureAccess({id:3,role:'user',accessScope:{paths:['Дефлекторы / Окна / 2D']}});assert.equal(client.accessStorage.getItem('basket'),null);
 client.configureAccess({id:1,role:'owner',accessScope:null});assert.equal(client.accessMode().readOnly,false);assert.equal(client.accessStorage.getItem('basket'),'PRIVATE-OWNER');
 delete global.localStorage;
});
