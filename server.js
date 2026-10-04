/*
 * HESTIA GATEWAY — AI API Key Gateway & Manager
 * Backend: Node.js + Express (no build step)
 *
 * Alur (sesuai permintaan Hestia):
 *  1. Pengguna memasukkan Base URL + API Key miliknya dari provider lain (BYOK)
 *     -> server memvalidasi lewat <baseUrl>/models, lalu menampilkan model-model
 *        yang didukung API key tersebut.
 *  2. Web meng-generate API key sendiri berformat hestia-xxxx + Base URL web ini
 *     -> key itu dipakai di agent lain / web lain (format OpenAI-compatible:
 *        Authorization: Bearer hestia-xxxx ke https://domain-kamu/v1)
 *  3. Setiap request lewat gateway di-proxy ke provider asli memakai key
 *     simpanan server, token dihitung & dicatat ke riwayat pemakaian.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Database (JSON file) ---------------- */
function defaultDb() {
  return { providers: [], gatewayKeys: [], usage: [], orders: [], seq: 1 };
}
function loadDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DB_FILE)) {
      const d = defaultDb();
      fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
      return d;
    }
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // Migrasi: tandai provider resmi Hestia & jenis key lama
    let dirty = false;
    for (const p of d.providers || []) {
      if (p.official === undefined) {
        p.official = p.name.indexOf('LikeChat - ') === 0;
        dirty = true;
      }
    }
    for (const k of d.gatewayKeys || []) {
      if (!k.keyType) {
        const pr = (d.providers || []).find((x) => x.id === k.providerId);
        k.keyType = pr && pr.official ? 'hestia' : 'byok';
        dirty = true;
      }
    }
    if (dirty) fs.writeFileSync(DB_FILE, JSON.stringify(d, null, 2));
    return d;
  } catch (e) {
    console.error('DB load error:', e.message);
    return defaultDb();
  }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDb();
const nid = (p) => p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ---------------- Paket harga (Rupiah) ---------------- */
const PLANS = [
  { id: 'member-500k', name: 'MEMBER', tokens: 500000, price: 5000, durationDays: 3, maxModels: 5, freeModels: 3,
    desc: '500K token • 5 model aktif + 3 model free' },
  { id: 'member-1m', name: 'MEMBER', tokens: 1000000, price: 10000, durationDays: 7, maxModels: 7, freeModels: 3,
    desc: '1M token • 7 model aktif + 3 model free' },
  { id: 'vip-5m', name: 'VIP', tokens: 5000000, price: 35000, durationDays: 30, maxModels: 9999, freeModels: 9999,
    desc: '5M token • 1 bulan • FULL model' },
];
const CUSTOM_RATE_PER_1K = 10; // Rp10 per 1000 token (ikut harga 5k/500k)
const getPlan = (id) => PLANS.find((p) => p.id === id);

/* ---------------- Helper ---------------- */
function apiBase(baseUrl) {
  let u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/\/v1$/.test(u)) u += '/v1';
  return u;
}
function maskKey(k) {
  if (!k || k.length < 14) return '••••••';
  return k.slice(0, 10) + '••••••' + k.slice(-4);
}
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
function guessContext(modelId) {
  const m = String(modelId).toLowerCase();
  if (/1m|1000k/.test(m)) return 1000000;
  if (/200k|256k/.test(m)) return 200000;
  if (/128k/.test(m)) return 128000;
  if (/64k/.test(m)) return 64000;
  if (/32k/.test(m)) return 32768;
  if (/16k/.test(m)) return 16384;
  if (/8k/.test(m)) return 8192;
  if (/4k/.test(m)) return 4096;
  if (/opus|gpt-4o|sonnet|deepseek|qwen3|llama-3|gemini/.test(m)) return 128000;
  if (/haiku|flash-lite|mini|nano|3\.5/.test(m)) return 32768;
  return 32768;
}
function guessFree(modelId) {
  return /free|flash-lite|lite|nano|mini|haiku|turbo/i.test(String(modelId));
}
async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}
// Validasi BYOK: panggil <baseUrl>/models pakai API key user
async function validateProvider(baseUrl, apiKey) {
  const base = apiBase(baseUrl);
  const started = Date.now();
  const r = await fetchWithTimeout(base + '/models', {
    headers: { Authorization: 'Bearer ' + apiKey },
  }, 20000);
  const latencyMs = Date.now() - started;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Provider menolak (HTTP ' + r.status + '): ' + txt.slice(0, 160));
  }
  const j = await r.json();
  const models = (j.data || []).map((m) => ({
    id: m.id,
    context: guessContext(m.id),
    free: guessFree(m.id),
    active: true,
    pingMs: latencyMs,
  }));
  if (!models.length) throw new Error('Provider tidak mengembalikan daftar model.');
  return { base, models, latencyMs };
}
function publicBaseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return proto + '://' + host;
}
function authGatewayKey(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const key = m[1].trim();
  return db.gatewayKeys.find((k) => k.key === key && !k.revoked) || null;
}
function keyUsable(key) {
  if (!key || key.revoked) return { ok: false, code: 401, msg: 'API key tidak valid / sudah dicabut.' };
  if (key.expiresAt && Date.now() > key.expiresAt)
    return { ok: false, code: 402, msg: 'Masa aktif key habis. Perpanjang paket dulu ya.' };
  if (key.tokenLimit > 0 && key.tokensUsed >= key.tokenLimit)
    return { ok: false, code: 402, msg: 'Kuota token habis. Beli token tambahan dulu ya.' };
  return { ok: true };
}
function logUsage(entry) {
  db.usage.unshift({ id: nid('use'), ts: Date.now(), ...entry });
  if (db.usage.length > 2000) db.usage.length = 2000;
  saveDb(db);
}

/* ================= DASHBOARD API ================= */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/stats', (req, res) => {
  const totalTokens = db.usage.reduce((a, u) => a + (u.totalTokens || 0), 0);
  const totalRequests = db.usage.length;
  const activeModels = db.providers.reduce((a, p) => a + p.models.filter((m) => m.active).length, 0);
  const pings = db.providers.map((p) => p.pingMs).filter((x) => x > 0);
  const avgPing = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : 0;
  const activeKeys = db.gatewayKeys.filter((k) => !k.revoked).length;
  res.json({ totalTokens, totalRequests, activeModels, avgPing, activeKeys, providers: db.providers.length });
});

app.get('/api/plans', (req, res) => res.json({ plans: PLANS, customRatePer1K: CUSTOM_RATE_PER_1K }));

/* ================= PROVIDER (BYOK) ================= */
// 1) Validasi dulu: Base URL + API key user -> daftar model yang support
app.post('/api/providers/validate', async (req, res) => {
  try {
    const { baseUrl, apiKey } = req.body || {};
    if (!baseUrl || !apiKey) return res.status(400).json({ ok: false, msg: 'Base URL dan API key wajib diisi.' });
    const { base, models, latencyMs } = await validateProvider(baseUrl, apiKey);
    res.json({ ok: true, base, latencyMs, models });
  } catch (e) {
    res.status(400).json({ ok: false, msg: e.name === 'AbortError' ? 'Timeout: provider tidak merespons.' : e.message });
  }
});

// 2) Simpan provider (dijalankan setelah validasi sukses)
app.post('/api/providers', async (req, res) => {
  try {
    const { name, baseUrl, apiKey, models } = req.body || {};
    if (!name || !baseUrl || !apiKey) return res.status(400).json({ ok: false, msg: 'Nama, Base URL, API key wajib diisi.' });
    let finalModels = models, base = apiBase(baseUrl), latencyMs = 0;
    if (!finalModels || !finalModels.length) {
      const v = await validateProvider(baseUrl, apiKey);
      finalModels = v.models; base = v.base; latencyMs = v.latencyMs;
    }
    const p = {
      id: nid('prv'), name: String(name).slice(0, 60), baseUrl: base, apiKey,
      models: finalModels, pingMs: latencyMs, createdAt: Date.now(),
      official: false, // provider titipan user (BYOK); yang resmi hanya via migrasi
    };
    db.providers.unshift(p);
    saveDb(db);
    res.json({ ok: true, provider: { ...p, apiKey: maskKey(p.apiKey) } });
  } catch (e) {
    res.status(400).json({ ok: false, msg: e.name === 'AbortError' ? 'Timeout: provider tidak merespons.' : e.message });
  }
});

app.get('/api/providers', (req, res) => {
  res.json({
    providers: db.providers.map((p) => ({
      ...p, apiKey: maskKey(p.apiKey),
      activeCount: p.models.filter((m) => m.active).length,
    })),
  });
});

app.patch('/api/providers/:id/models', (req, res) => {
  const p = db.providers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: 'Provider tidak ditemukan.' });
  const { modelId, active } = req.body || {};
  const m = p.models.find((x) => x.id === modelId);
  if (!m) return res.status(404).json({ ok: false, msg: 'Model tidak ditemukan.' });
  m.active = !!active;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/providers/:id/ping', async (req, res) => {
  const p = db.providers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: 'Provider tidak ditemukan.' });
  try {
    const started = Date.now();
    const r = await fetchWithTimeout(p.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + p.apiKey },
    }, 15000);
    const ms = Date.now() - started;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    p.pingMs = ms;
    p.models.forEach((m) => (m.pingMs = ms));
    p.lastPingAt = Date.now();
    saveDb(db);
    res.json({ ok: true, pingMs: ms });
  } catch (e) {
    res.json({ ok: false, msg: e.name === 'AbortError' ? 'Timeout.' : e.message });
  }
});

app.delete('/api/providers/:id', (req, res) => {
  const i = db.providers.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, msg: 'Provider tidak ditemukan.' });
  db.providers.splice(i, 1);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= GATEWAY KEY (hestia-xxxx) ================= */
app.post('/api/keys', (req, res) => {
  const { name, providerId, planId, modelIds, keyType } = req.body || {};
  const plan = getPlan(planId);
  const provider = db.providers.find((p) => p.id === providerId);
  if (!provider) return res.status(400).json({ ok: false, msg: 'Pilih provider dulu.' });
  if (!plan) return res.status(400).json({ ok: false, msg: 'Pilih paket dulu.' });
  // Jenis key: 'hestia' (provider resmi Hestia) vs 'byok' (provider titipan user)
  const type = keyType === 'hestia' || keyType === 'byok'
    ? keyType
    : (provider.official ? 'hestia' : 'byok');
  if (type === 'hestia' && !provider.official)
    return res.status(400).json({ ok: false, msg: 'Key Hestia hanya untuk provider resmi.' });
  if (type === 'byok' && provider.official)
    return res.status(400).json({ ok: false, msg: 'Provider resmi pakai jenis Key Hestia.' });

  const activeModels = provider.models.filter((m) => m.active);
  let chosen = (modelIds && modelIds.length ? modelIds : activeModels.map((m) => m.id))
    .filter((id) => activeModels.some((m) => m.id === id));
  if (!chosen.length) return res.status(400).json({ ok: false, msg: 'Tidak ada model aktif yang dipilih.' });
  if (chosen.length > plan.maxModels)
    return res.status(400).json({ ok: false, msg: 'Paket ' + plan.name + ' maksimal ' + plan.maxModels + ' model.' });

  const key = 'hestia-' + crypto.randomBytes(18).toString('base64url');
  const gk = {
    id: nid('key'), name: String(name || 'Key Tanpa Nama').slice(0, 60),
    key, providerId: provider.id, planId: plan.id, keyType: type,
    modelIds: chosen, tokenLimit: plan.tokens, tokensUsed: 0,
    requests: 0, revoked: false,
    createdAt: Date.now(), expiresAt: Date.now() + plan.durationDays * 86400000,
  };
  db.gatewayKeys.unshift(gk);
  saveDb(db);
  res.json({
    ok: true,
    key: gk.key, // tampil penuh HANYA saat pembuatan
    baseUrl: publicBaseUrl(req) + '/v1',
    expiresAt: gk.expiresAt, tokenLimit: gk.tokenLimit, modelCount: chosen.length,
  });
});

app.get('/api/keys', (req, res) => {
  res.json({
    keys: db.gatewayKeys.map((k) => {
      const plan = getPlan(k.planId) || {};
      const provider = db.providers.find((p) => p.id === k.providerId);
      return {
        id: k.id, name: k.name, masked: maskKey(k.key),
        providerName: provider ? provider.name : '(dihapus)',
        keyType: k.keyType || (provider && provider.official ? 'hestia' : 'byok'),
        planName: plan.name || k.planId, tokenLimit: k.tokenLimit,
        tokensUsed: k.tokensUsed, tokensLeft: Math.max(0, k.tokenLimit - k.tokensUsed),
        requests: k.requests, modelCount: k.modelIds.length,
        revoked: k.revoked, createdAt: k.createdAt, expiresAt: k.expiresAt,
        expired: k.expiresAt && Date.now() > k.expiresAt,
      };
    }),
  });
});

app.get('/api/keys/:id/reveal', (req, res) => {
  const k = db.gatewayKeys.find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ ok: false });
  res.json({ ok: true, key: k.key, baseUrl: publicBaseUrl(req) + '/v1' });
});

app.delete('/api/keys/:id', (req, res) => {
  const k = db.gatewayKeys.find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ ok: false, msg: 'Key tidak ditemukan.' });
  k.revoked = true;
  saveDb(db);
  res.json({ ok: true });
});

/* ================= RIWAYAT & MODEL ================= */
app.get('/api/usage', (req, res) => {
  const { keyId, limit } = req.query;
  let list = db.usage;
  if (keyId) list = list.filter((u) => u.keyId === keyId);
  res.json({ usage: list.slice(0, Math.min(parseInt(limit) || 100, 500)) });
});

app.get('/api/models', (req, res) => {
  const rows = [];
  db.providers.forEach((p) => {
    p.models.forEach((m) => {
      const u = db.usage.filter((x) => x.model === m.id);
      const avgPerReq = u.length ? Math.round(u.reduce((a, x) => a + (x.totalTokens || 0), 0) / u.length) : 0;
      rows.push({
        providerId: p.id, providerName: p.name, id: m.id,
        active: m.active, free: m.free, context: m.context,
        pingMs: m.pingMs || p.pingMs || 0, avgPerReq, requests: u.length,
      });
    });
  });
  res.json({ models: rows });
});

/* ================= ORDER TOKEN ================= */
app.post('/api/orders', (req, res) => {
  const { planId, customTokens, name } = req.body || {};
  let tokens, price, label;
  if (planId) {
    const plan = getPlan(planId);
    if (!plan) return res.status(400).json({ ok: false, msg: 'Paket tidak valid.' });
    tokens = plan.tokens; price = plan.price; label = plan.name + ' • ' + plan.desc;
  } else if (customTokens) {
    tokens = Math.max(1000, Math.min(100000000, parseInt(customTokens) || 0));
    price = Math.ceil(tokens / 1000) * CUSTOM_RATE_PER_1K;
    label = 'Custom ' + tokens.toLocaleString('id-ID') + ' token';
  } else {
    return res.status(400).json({ ok: false, msg: 'Pilih paket / jumlah token.' });
  }
  const order = {
    id: 'HG-' + Date.now().toString(36).toUpperCase(),
    label, tokens, price, buyer: String(name || 'Tanpa Nama').slice(0, 60),
    status: 'pending', createdAt: Date.now(),
  };
  db.orders.unshift(order);
  saveDb(db);
  res.json({
    ok: true, order,
    payInfo: 'Transfer Rp' + price.toLocaleString('id-ID') + ' lalu konfirmasi ke admin. Token aktif otomatis setelah pembayaran diverifikasi.',
  });
});
app.get('/api/orders', (req, res) => res.json({ orders: db.orders.slice(0, 100) }));

/* ================= OPENAI-COMPATIBLE GATEWAY (/v1) =================
 * Key hestia-xxxx dipakai di agent mana pun yang mendukung custom endpoint:
 *   Base URL : https://domain-kamu/v1
 *   API Key  : hestia-xxxx
 *   Header   : Authorization: Bearer hestia-xxxx
 */
app.get('/v1/models', (req, res) => {
  const gk = authGatewayKey(req);
  const chk = keyUsable(gk);
  if (!chk.ok) return res.status(chk.code).json({ error: { message: chk.msg } });
  const provider = db.providers.find((p) => p.id === gk.providerId);
  const ids = gk.modelIds.filter((id) => provider && provider.models.some((m) => m.id === id && m.active));
  res.json({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'hestia-gateway' })),
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const started = Date.now();
  const gk = authGatewayKey(req);
  const chk = keyUsable(gk);
  if (!chk.ok) return res.status(chk.code).json({ error: { message: chk.msg } });

  const { model, messages, stream } = req.body || {};
  if (!model || !messages) return res.status(400).json({ error: { message: 'model & messages wajib diisi.' } });
  if (!gk.modelIds.includes(model))
    return res.status(403).json({ error: { message: 'Model "' + model + '" tidak termasuk dalam key ini.' } });
  const provider = db.providers.find((p) => p.id === gk.providerId);
  const pModel = provider && provider.models.find((m) => m.id === model && m.active);
  if (!provider || !pModel)
    return res.status(503).json({ error: { message: 'Provider/model sedang nonaktif.' } });

  const promptText = (messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
  const promptTokens = estimateTokens(promptText);

  let upstream;
  try {
    upstream = await fetchWithTimeout(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.apiKey },
      body: JSON.stringify(req.body),
    }, 120000);
  } catch (e) {
    logUsage({ keyId: gk.id, keyName: gk.name, providerId: provider.id, model, promptTokens, completionTokens: 0, totalTokens: 0, ok: false, latencyMs: Date.now() - started, err: 'upstream unreachable' });
    return res.status(502).json({ error: { message: 'Provider tidak merespons.' } });
  }

  const finish = (completionTokens, ok, err) => {
    const totalTokens = promptTokens + completionTokens;
    gk.tokensUsed += totalTokens;
    gk.requests += 1;
    saveDb(db);
    logUsage({ keyId: gk.id, keyName: gk.name, providerId: provider.id, model, promptTokens, completionTokens, totalTokens, ok, latencyMs: Date.now() - started, err });
  };

  // Streaming: teruskan SSE apa adanya, hitung token di akhir
  if (stream && upstream.body) {
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    });
    let acc = '';
    try {
      for await (const chunk of upstream.body) {
        const s = Buffer.from(chunk).toString('utf8');
        acc += s;
        res.write(chunk);
      }
      const texts = [...acc.matchAll(/"delta":\s*\{\s*"content":\s*"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => { try { return JSON.parse('"' + m[1] + '"'); } catch { return ''; } });
      finish(estimateTokens(texts.join('')), upstream.ok, upstream.ok ? undefined : 'upstream ' + upstream.status);
    } catch (e) {
      finish(0, false, 'stream error');
    }
    return res.end();
  }

  const text = await upstream.text();
  let completionTokens = 0, ok = upstream.ok;
  try {
    const j = JSON.parse(text);
    if (j.usage && j.usage.completion_tokens != null) {
      completionTokens = j.usage.completion_tokens;
      if (j.usage.prompt_tokens != null) { /* pakai angka resmi provider */ }
    } else {
      const out = (j.choices || []).map((c) => (c.message && c.message.content) || '').join('');
      completionTokens = estimateTokens(out);
    }
  } catch { completionTokens = estimateTokens(text); }
  finish(completionTokens, ok, ok ? undefined : 'upstream ' + upstream.status);
  res.status(upstream.status).type('application/json').send(text);
});

/* ---------------- Static fallback & listen ---------------- */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log('HESTIA GATEWAY berjalan di http://localhost:' + PORT);
  console.log('Dashboard : http://localhost:' + PORT + '/');
  console.log('Endpoint agent (OpenAI-compatible): http://localhost:' + PORT + '/v1');
});
