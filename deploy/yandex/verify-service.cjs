const fs = require('fs'), https = require('https'), tls = require('tls');
const domain = 'defly-analytics.ru';
const env = require('/opt/mp/app/backend/node_modules/dotenv').parse(fs.readFileSync('/etc/mp/app.env'));
const file = '/var/lib/mp/status.json';
function request(path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({ hostname: '127.0.0.1', port: 443, servername: domain,
      checkServerIdentity: (_, cert) => tls.checkServerIdentity(domain, cert), path,
      method: data ? 'POST' : 'GET', headers: { Host: domain,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}) } }, res => {
      let raw = ''; res.on('data', b => raw += b);
      res.on('end', () => { let json; try { json = JSON.parse(raw); } catch {}
        resolve({ code: res.statusCode, json, cookie: res.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') }); });
    });
    req.setTimeout(150000, () => req.destroy(Error('timeout'))); req.on('error', reject); req.end(data);
  });
}
(async () => {
  let out = { transport: 'https', domain }, cookie, probeId;
  try {
    let ready = false;
    for (let i = 0; i < 45; i++) {
      try { if ((await request('/health')).code === 200) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!ready) throw Error('service not ready');
    if (!env.ADMIN_PASSWORD) out.configurationMissing = true;
    else {
      const login = await request('/api/auth/login', { login: 'evgeniy', password: env.ADMIN_PASSWORD });
      out.login = login.code; cookie = login.cookie;
      if (login.code === 200) {
        const me = await request('/api/auth/me', null, cookie);
        out.owner = me.json?.data?.login === 'evgeniy' && me.json?.data?.role === 'owner';
        for (const [name, path] of [['sales', '/api/sales/data'], ['finance', '/api/finance/pnl']]) {
          const r = await request(path + '?cabinet=defly&dateFrom=2026-11-13&dateTo=2026-11-13', null, cookie);
          out[name] = { code: r.code, success: r.json?.success, articles: r.json?.data?.articles?.length, rows: r.json?.data?.rows?.length };
        }
        probeId = require('crypto').randomUUID();
        const opened = await request('/api/auth/activity', {visitId:probeId,idleSeconds:0,visible:true,close:false,page:'service-check',cabinet:'defly'},cookie);
        await new Promise(resolve=>setTimeout(resolve,1200));
        const ping = await request('/api/auth/activity', {visitId:probeId,idleSeconds:1,visible:false,close:true,page:'service-check',cabinet:'defly'},cookie);
        out.accessHeartbeatOpen = opened.code;
        out.accessHeartbeat = {code:ping.code,success:ping.json?.success};
        if (ping.json?.error) out.accessHeartbeat.error = String(ping.json.error).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi,'[адрес]').replace(/[a-zA-Z0-9_-]{32,}/g,'[скрыто]').slice(0,180);
        const journal = await request('/api/auth/activity/report', null, cookie);
        out.accessJournal = { code: journal.code, success: journal.json?.success };
        const categories = await request('/api/auth/categories', null, cookie);
        out.categoryAccess = {code:categories.code,success:categories.json?.success,paths:categories.json?.data?.paths?.length,readiness:categories.json?.data?.accessStatus};
        const keys = await request('/api/auth/keys', null, cookie);
        out.integrationKeys = { code: keys.code, count: keys.json?.data?.length, recentlyUsed: keys.json?.data?.some(k => k.last_used && Date.now() - new Date(k.last_used).getTime() < 86400000) };
      }
    }
  } catch { out.error = 'verification failed'; }
  finally {
    if (probeId) {
      const { Client } = require('/opt/mp/app/backend/node_modules/pg');
      const client = new Client({connectionString:env.DATABASE_URL,ssl:/@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL)?false:{rejectUnauthorized:false},connectionTimeoutMillis:10000});
      try { await client.connect(); const counted=await client.query('SELECT active_seconds,source FROM app_access_visits WHERE id=$1',[probeId]); if(out.accessHeartbeat) out.accessHeartbeat.counterConfirmed=Number(counted.rows[0]?.active_seconds)>=1 && counted.rows[0]?.source==='service-check'; await client.query("DELETE FROM app_access_visits WHERE id=$1 AND page='service-check'",[probeId]); }
      catch {} finally { await client.end().catch(()=>{}); }
    }
    if (cookie) await request('/api/auth/logout', {}, cookie).catch(() => {}); }
  let d = {}; try { d = JSON.parse(fs.readFileSync(file)); } catch {}
  d.serviceVerification = out; fs.writeFileSync(file, JSON.stringify(d));
})();
