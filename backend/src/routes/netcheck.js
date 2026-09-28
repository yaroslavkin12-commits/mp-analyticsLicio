const express = require('express');
const router = express.Router();
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');
const https = require('https');

// ВРЕМЕННЫЙ диагностический роут (убрать после того, как разберёмся с
// таймаутами Ozon API 28.09) — раздельно измеряет DNS-резолвинг, "сырое" TCP
// подключение на 443 порт, TLS-рукопожатие и полноценный HTTPS-запрос к
// каждому хосту. Цель: понять, на каком именно шаге всё виснет — если виснет
// уже на "сыром" TCP SYN, это блокировка на уровне сети/хостинга, а не баг в
// нашем коде (axios/agent/retry), и не что-то специфичное для HTTP.

const HOSTS = [
  'api-seller.ozon.ru',
  'api-performance.ozon.ru',
  'www.ozon.ru',
  'statistics-api.wildberries.ru', // контроль: точно должен работать
  'api.github.com',                // контроль: обычный внешний хост
];

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout ${ms}ms (${label})`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function checkDns(host) {
  const start = Date.now();
  const addrs = await withTimeout(dns.lookup(host, { all: true }), 8000, 'dns');
  return { ok: true, ms: Date.now() - start, addrs: addrs.map(a => a.address) };
}

async function checkTcp(host, port = 443) {
  const start = Date.now();
  await withTimeout(new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, timeout: 8000 }, () => { sock.destroy(); resolve(); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('tcp timeout')); });
    sock.on('error', reject);
  }), 9000, 'tcp');
  return { ok: true, ms: Date.now() - start };
}

async function checkTls(host, port = 443) {
  const start = Date.now();
  await withTimeout(new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host, timeout: 8000 }, () => { sock.destroy(); resolve(); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('tls timeout')); });
    sock.on('error', reject);
  }), 9000, 'tls');
  return { ok: true, ms: Date.now() - start };
}

async function checkHttps(host) {
  const start = Date.now();
  await withTimeout(new Promise((resolve, reject) => {
    const req = https.get({ host, path: '/', timeout: 10000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      resolve(res.statusCode);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('https timeout')); });
    req.on('error', reject);
  }), 11000, 'https');
  return { ok: true, ms: Date.now() - start };
}

router.get('/', async (req, res) => {
  const results = {};
  for (const host of HOSTS) {
    results[host] = {};
    for (const [step, fn] of [['dns', checkDns], ['tcp', checkTcp], ['tls', checkTls], ['https', checkHttps]]) {
      try {
        results[host][step] = await fn(host);
      } catch (e) {
        results[host][step] = { ok: false, error: e.message };
        break; // нет смысла проверять следующий шаг, если этот не прошёл
      }
    }
  }
  res.json({ success: true, at: new Date().toISOString(), results });
});

module.exports = router;
