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
  let out = { transport: 'https', domain }, cookie;
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
        const journal = await request('/api/auth/activity/report', null, cookie);
        out.accessJournal = { code: journal.code, success: journal.json?.success };
        const keys = await request('/api/auth/keys', null, cookie);
        out.integrationKeys = { code: keys.code, count: keys.json?.data?.length, recentlyUsed: keys.json?.data?.some(k => k.last_used && Date.now() - new Date(k.last_used).getTime() < 86400000) };
      }
    }
  } catch { out.error = 'verification failed'; }
  finally { if (cookie) await request('/api/auth/logout', {}, cookie).catch(() => {}); }
  let d = {}; try { d = JSON.parse(fs.readFileSync(file)); } catch {}
  d.serviceVerification = out; fs.writeFileSync(file, JSON.stringify(d));
})();
