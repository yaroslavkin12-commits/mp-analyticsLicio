// Проверка чтения реальных данных с категорией сотрудника без создания аккаунтов.
module.exports=async env=>{
 for(const [key,value] of Object.entries(env))if(process.env[key]===undefined)process.env[key]=value;
 const access=require('../../backend/src/lib/categoryAccess'),scope={paths:['Дефлекторы / Окна / 2D'],readOnly:true};
 const ctx=await access.context('defly',scope),out={allowedArticles:ctx.allowed.size};
 const dispatch=async(path,routerPath,route,method='GET',extra={})=>new Promise((resolve,reject)=>{
  const req={path,method,query:{cabinet:'defly',dateFrom:'2026-11-13',dateTo:'2026-11-13',month:'2026-11',scope:'marketplaces',...extra},user:{id:0,role:'user',accessScope:scope}};
  const res={statusCode:200,set(){return this;},status(code){this.statusCode=code;return this;},type(){return this;},send(body){try{resolve({code:this.statusCode,...JSON.parse(body)});}catch{reject(Error('bad response'));}return this;},json(body){resolve({code:this.statusCode,...body});return this;}};
  access.middleware()(req,res,()=>{
   const handler=require('../../backend/src/routes/'+routerPath).stack.find(l=>l.route?.path===route&&l.route.methods[method.toLowerCase()])?.route.stack[0].handle;
   if(!handler)return reject(Error('missing handler'));Promise.resolve(handler(req,res)).catch(reject);
  }).catch(reject);
 });
 try{
  const products=await dispatch('/api/sales/costs','sales','/costs');
  out.products={code:products.code,onlyAllowed:products.success&&products.data.items.every(a=>ctx.allowed.has(a.offerId))};
  const geo=await dispatch('/api/sales/geo','sales','/geo');out.geo={code:geo.code,onlyAllowed:geo.success&&geo.data.articles.every(a=>ctx.allowed.has(a.o))};
  const q=await dispatch('/api/queries/data','queries','/data');out.search={code:q.code,onlyAllowed:q.success&&q.data.articles.every(a=>ctx.allowed.has(a.o))};
  const plan=await dispatch('/api/plan/ozon','ozonPlan','/');out.plan={code:plan.code,onlyAllowed:plan.success&&plan.data.versions.every(v=>v.rows.every(r=>scope.paths.some(p=>access.inPath(r.path,p))))};
  const summary=await dispatch('/api/sales/summary','sales','/summary');out.summary={code:summary.code,onlyAllowed:summary.success&&summary.data.shops.every(s=>[s.cur,s.prev].every(t=>Object.keys(t.byPath).every(p=>scope.paths.some(allowed=>access.inPath(p,allowed)||access.inPath(allowed,p)))))};
  out.costChangeBlocked=(await dispatch('/api/sales/costs','sales','/costs','POST')).code===403;
  out.categoryChangeBlocked=(await dispatch('/api/sales/category','sales','/category','POST')).code===403;
  out.productionHidden=!access.publicScope(scope).pages.includes('production');
  out.foreignArticleBlocked=(await dispatch('/api/queries/article','queries','/article','GET',{offerId:'not-in-permitted-catalogue'})).code===403;
  return out;
 }catch{return {...out,error:'scoped verification failed'};}
 finally{await require('../../backend/src/db').getPool().end().catch(()=>{});}
};
