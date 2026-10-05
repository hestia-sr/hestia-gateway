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
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- Database (JSON file) ---------------- */
function defaultDb() {
  return { providers: [], gatewayKeys: [], usage: [], orders: [], users: [], sessions: [], seq: 1 };
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
      const own = p.name.indexOf('LikeChat - ') === 0; // provider milik Hestia sendiri
      if (p.official === undefined) {
        p.official = own;
        dirty = true;
      } else if (own && !p.official) {
        p.official = true; // restorasi: provider Hestia yang masuk via API publik
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
    // Migrasi: alias nama tampil untuk model lama
    for (const p of d.providers || []) {
      const before = JSON.stringify((p.models || []).map((m) => m.alias));
      assignAliases(p.models);
      if (JSON.stringify((p.models || []).map((m) => m.alias)) !== before) dirty = true;
    }
    // Migrasi: tabel auth
    if (!Array.isArray(d.users)) { d.users = []; dirty = true; }
    if (!Array.isArray(d.sessions)) { d.sessions = []; dirty = true; }
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
/* Alias nama tampil model: default = id tanpa akhiran ":free", unik per provider */
function assignAliases(models) {
  const seen = new Set();
  for (const m of models || []) {
    if (!m.alias) m.alias = String(m.id).replace(/:free$/, '');
    if (seen.has(m.alias)) m.alias = m.id;
    seen.add(m.alias);
  }
}
let db = loadDb();
const nid = (p) => p + '_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ---------------- Paket harga (Rupiah) ---------------- */
const PLANS = [
  { id: 'free-500k', name: 'FREE', tokens: 700000, price: 0, durationDays: 7, maxModels: 10, maxKeys: 2, freeModels: 0,
    desc: '700K token • 7 hari • 10 model' },
  { id: 'basic-1m', name: 'BASIC', tokens: 1000000, price: 10000, durationDays: 7, maxModels: 10, maxKeys: 5, freeModels: 0,
    desc: '1M token • 7 hari • 10 model' },
  { id: 'member-3m', name: 'MEMBER', tokens: 3000000, price: 25000, durationDays: 14, maxModels: 20, maxKeys: 10, freeModels: 0,
    desc: '3M token • 14 hari • 20 model' },
  { id: 'vip-8m', name: 'VIP', tokens: 8000000, price: 50000, durationDays: 30, maxModels: 9999, maxKeys: 20, freeModels: 0,
    desc: '8M token • 30 hari • FULL model' },
  { id: 'sultan', name: 'SULTAN', tokens: 1500000, price: 350000, durationDays: 30, maxModels: 8, maxKeys: 50, sultan: true, pick: 0,
    desc: '1,5M token • 30 hari • semua 8 model mahal terbuka otomatis' },
  { id: 'sultan-plus', name: 'SULTAN+', tokens: 1000000, price: 150000, durationDays: 30, maxModels: 3, maxKeys: 50, sultan: true, pick: 3, pool: 'mahal',
    desc: '1M token • 30 hari • pilih 3 dari 8 model mahal' },
  { id: 'sultan-plus2', name: 'SULTAN++', tokens: 1000000, price: 100000, durationDays: 30, maxModels: 5, maxKeys: 50, sultan: true, pick: 5, pool: 'mid',
    desc: '1M token • 30 hari • pilih 5 model menengah + bonus' },
];
const CUSTOM_RATE_PER_1K = 10; // Rp10 per 1000 token (ikut harga 5k/500k)
const getPlan = (id) => PLANS.find((p) => p.id === id);
const keyActive = (k) => !k.revoked && !(k.expiresAt && Date.now() > k.expiresAt);

/* ---------------- Model paket GRATIS (dipilih otomatis) ----------------
   Model yang umum digratiskan reseller lain; DeepSeek-V4-Pro ikut kata Hestia.
   Key gratis jalan di provider hcnsec (1 key = 1 provider). */
const FREE_PROVIDER_NAME = 'LikeChat - hcnsec (chat)';
const FREE_MODEL_IDS = [
  'DeepSeek-V4-Pro',
  'DeepSeek-V4-Flash',
  'DeepSeek-V4.1-Flash',
  'glm-5.3-flash',
  'kimi-k3',
  'Qwen3.8-27B',
  'Qwen3.8-Flash-Next',
  'MiniMax-M3.1-Flash',
  'MiMo-V2.6-Flash',
  'longcat-2.5',
];

/* ---------------- Pool model Sultan ---------------- */
const SULTAN_MAHAL = [
  ['openai/gpt-6-astra', 'LikeChat - Odyssey'],
  ['openai/gpt-6-sol', 'LikeChat - Odyssey'],
  ['openai/gpt-5.6-sol', 'LikeChat - Odyssey'],
  ['claude-opus-5.5', 'LikeChat - TNT'],
  ['claude-opus-5', 'LikeChat - TNT'],
  ['gpt-6.1-sol', 'LikeChat - TNT'],
  ['gpt-5.5-xhigh', 'LikeChat - TNT'],
  ['gpt-5.5', 'LikeChat - TNT'],
];
const SULTAN_MID = [
  ['claude-sonnet-4-6', 'LikeChat - VYCE (chat)'],
  ['DeepSeek-V4-Pro', 'LikeChat - hcnsec (chat)'],
  ['DeepSeek-V4.1-Flash', 'LikeChat - hcnsec (chat)'],
  ['glm-5.3', 'LikeChat - hcnsec (chat)'],
  ['kimi-k3', 'LikeChat - hcnsec (chat)'],
  ['openai/gpt-oss-120b', 'LikeChat - HyperFusion (file/gambar)'],
  ['deepseek-ai/DeepSeek-V4-Flash-0731', 'LikeChat - HyperFusion (file/gambar)'],
  ['grok-imagine-2', 'LikeChat - VYCE (chat)'],
];
// Bonus SULTAN++: 1 model sedikit lebih tinggi (lumayan buat coding), dipilih Hestia.
const SULTAN_PLUS2_BONUS = [
  ['claude-opus-5', 'LikeChat - TNT'],
];

const SULTAN_IDS = new Set(SULTAN_MAHAL.map(([id]) => id));

/* ================= AUTH (email + sandi, khusus Gmail) ================= */
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const MAX_PER_DEVICE = 3; // maks akun per device, selebihnya auto-suspend
const SESSION_DAYS = 30;
const BLOCKED_DOMAINS = new Set(['hotmail.com', 'hotmail.co.id', 'outlook.com', 'outlook.co.id', 'live.com', 'live.co.id', 'msn.com']);
const TEMP_DOMAINS = new Set(('tempmail.com temp-mail.org guerrillamail.com guerrillamail.org 10minutemail.com 10minutemail.net ' +
  'mailinator.com yopmail.com yopmail.fr trashmail.com throwawaymail.com getnada.com mohmal.com emailondeck.com ' +
  'tempail.com fakemail.net dispostable.com maildrop.cc harakirimail.com anonbox.net burnermail.io crazymailing.com ' +
  'dashmail.io dropmail.me fakeinbox.com incognitomail.org spamgourmet.com tmpmail.org deadaddress.com moakt.com ' +
  'tempmailo.com mailnesia.com mintemail.com sharklasers.com spambog.com teleworm.us veryrealemail.com ' +
  'e4ward.com mailnull.com spambox.us mytrashmail.com pookmail.com sogetthis.com zippymail.info').split(' '));
function emailCheck(email) {
  const m = String(email || '').trim().toLowerCase().match(/^([^\s@]+)@([^\s@]+\.[^\s@]+)$/);
  if (!m) return { ok: false, msg: 'Format email tidak valid.' };
  const d = m[2];
  if (BLOCKED_DOMAINS.has(d)) return { ok: false, msg: 'Hotmail/Outlook diblokir. Pakai Gmail ya.' };
  if (TEMP_DOMAINS.has(d)) return { ok: false, msg: 'Email sementara diblokir.' };
  if (d !== 'gmail.com') return { ok: false, msg: 'Hanya Gmail yang bisa daftar.' };
  return { ok: true, email: m[1] + '@' + d };
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, createdAt: Date.now() });
  const cut = Date.now() - SESSION_DAYS * 864e5;
  db.sessions = db.sessions.filter((s) => s.createdAt > cut);
  saveDb(db);
  return token;
}
function authUser(req) {
  const t = req.headers['x-session-token'];
  if (!t) return null;
  const s = db.sessions.find((x) => x.token === t);
  if (!s || Date.now() - s.createdAt > SESSION_DAYS * 864e5) return null;
  return db.users.find((u) => u.id === s.userId) || null;
}
function ensureAdmin(u) {
  if (ADMIN_EMAIL && u.email === ADMIN_EMAIL && u.role !== 'admin') {
    u.role = 'admin'; u.suspended = false; saveDb(db);
  }
}
function requireAuth(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false, msg: 'Harus login dulu.' });
  ensureAdmin(u);
  if (u.suspended) return res.status(403).json({ ok: false, msg: 'Akun kamu di-suspend. Hubungi admin.' });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ ok: false, msg: 'Khusus admin.' });
    next();
  });
}
/* Auth khusus bot Telegram: header x-bot-token harus sama dengan env BOT_API_TOKEN */
const BOT_API_TOKEN = String(process.env.BOT_API_TOKEN || '');
function requireBot(req, res, next) {
  if (!BOT_API_TOKEN) return res.status(500).json({ ok: false, msg: 'BOT_API_TOKEN belum diset di server.' });
  if (req.headers['x-bot-token'] !== BOT_API_TOKEN)
    return res.status(403).json({ ok: false, msg: 'Token bot tidak valid.' });
  next();
}
function deviceAbusers(dev, fp) {
  return db.users.filter((u) => u.role !== 'admin' && (u.deviceId === dev || (fp && u.fp === fp)));
}
app.post('/api/auth/register', (req, res) => {
  const { email, password, deviceId, fp } = req.body || {};
  const chk = emailCheck(email);
  if (!chk.ok) return res.status(400).json({ ok: false, msg: chk.msg });
  const em = chk.email;
  if (!password || String(password).length < 6)
    return res.status(400).json({ ok: false, msg: 'Sandi minimal 6 karakter.' });
  if (db.users.some((u) => u.email === em))
    return res.status(400).json({ ok: false, msg: 'Email sudah terdaftar. Silakan masuk.' });
  const dev = String(deviceId || 'dev-' + crypto.randomBytes(8).toString('hex')).slice(0, 64);
  const fingerprint = String(fp || '').slice(0, 64);
  let suspended = false;
  if (deviceAbusers(dev, fingerprint).length >= MAX_PER_DEVICE) {
    suspended = true;
    for (const u of deviceAbusers(dev, fingerprint)) u.suspended = true;
  }
  const user = {
    id: nid('user'), email: em, passHash: bcrypt.hashSync(String(password), 10),
    deviceId: dev, fp: fingerprint,
    role: (ADMIN_EMAIL && em === ADMIN_EMAIL) ? 'admin' : 'user',
    suspended, createdAt: Date.now(),
  };
  db.users.push(user); saveDb(db);
  const token = newSession(user.id);
  res.json({ ok: true, token, user: { email: user.email, role: user.role, suspended: user.suspended } });
});
app.post('/api/auth/login', (req, res) => {
  const { email, password, deviceId, fp } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const u = db.users.find((x) => x.email === em);
  if (!u || !bcrypt.compareSync(String(password || ''), u.passHash || ''))
    return res.status(401).json({ ok: false, msg: 'Email / sandi salah.' });
  ensureAdmin(u);
  if (u.suspended) return res.status(403).json({ ok: false, msg: 'Akun kamu di-suspend. Hubungi admin.' });
  if (deviceId) u.deviceId = String(deviceId).slice(0, 64);
  if (fp) u.fp = String(fp).slice(0, 64);
  saveDb(db);
  const token = newSession(u.id);
  res.json({ ok: true, token, user: { email: u.email, role: u.role, suspended: u.suspended } });
});
app.post('/api/auth/logout', (req, res) => {
  const t = req.headers['x-session-token'];
  db.sessions = db.sessions.filter((s) => s.token !== t); saveDb(db);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ ok: false });
  ensureAdmin(u);
  res.json({ ok: true, user: { email: u.email, role: u.role, suspended: u.suspended } });
});
/* Kelola pengguna (admin) */
app.get('/api/users', requireAdmin, (req, res) => {
  const counts = {};
  db.users.forEach((u) => { counts[u.deviceId] = (counts[u.deviceId] || 0) + 1; });
  res.json({
    users: db.users.map((u) => ({
      id: u.id, email: u.email, role: u.role, suspended: u.suspended,
      deviceAccounts: counts[u.deviceId] || 1, createdAt: u.createdAt,
      keys: db.gatewayKeys.filter((k) => k.userId === u.id && !k.revoked).length,
    })),
  });
});
app.post('/api/users/:id/suspend', requireAdmin, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u || u.role === 'admin') return res.status(400).json({ ok: false, msg: 'Tidak bisa suspend akun ini.' });
  u.suspended = true; saveDb(db); res.json({ ok: true });
});
app.post('/api/users/:id/unsuspend', requireAdmin, (req, res) => {
  const u = db.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ ok: false });
  u.suspended = false; saveDb(db); res.json({ ok: true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const i = db.users.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false });
  if (db.users[i].role === 'admin') return res.status(400).json({ ok: false, msg: 'Tidak bisa hapus admin.' });
  const uid = db.users[i].id;
  db.users.splice(i, 1);
  db.sessions = db.sessions.filter((s) => s.userId !== uid);
  for (const k of db.gatewayKeys) if (k.userId === uid) k.revoked = true;
  saveDb(db); res.json({ ok: true });
});

/* ---------------- Etalase (daftar model unggulan, tanpa nama provider) ---------------- */
const ETALASE_DEF = [
  { tier: 'Text', icon: 'chat', desc: 'Chat, coding, reasoning & analisis', items: [
    ['openai/gpt-6-astra', 'LikeChat - Odyssey'],
    ['openai/gpt-6-sol', 'LikeChat - Odyssey'],
    ['openai/gpt-5.6-sol', 'LikeChat - Odyssey'],
    ['claude-opus-5.5', 'LikeChat - TNT'],
    ['claude-opus-5', 'LikeChat - TNT'],
    ['gpt-6.1-sol', 'LikeChat - TNT'],
    ['gpt-5.5-xhigh', 'LikeChat - TNT'],
    ['gpt-5.5', 'LikeChat - TNT'],
  ]},
];
function resolveEtalase() {
  const byKey = {};
  db.providers.forEach((p) => p.models.forEach((m) => { byKey[m.id + '|' + p.name] = m; }));
  return ETALASE_DEF.map((t) => ({
    tier: t.tier, icon: t.icon, desc: t.desc,
    items: t.items.map(([id, prov]) => {
      const m = byKey[id + '|' + prov];
      return { id, alias: (m && m.alias) || id, context: displayContext(m), active: !!(m && m.active), pingMs: (m && m.pingMs) || 0 };
    }).filter((x) => x.active),
  }));
}
app.get('/api/public/etalase', (req, res) => res.json({ tiers: resolveEtalase() }));
app.get('/api/public/models', (req, res) => {
  const rows = [];
  db.providers.forEach((p) => p.models.forEach((m) => {
    if (m.active) rows.push({ id: m.id, alias: m.alias || m.id });
  }));
  res.json({ models: rows });
});
/* Katalog model per paket (PUBLIK, untuk halaman "Model AI") — hanya data non-sensitif:
   id, alias, status aktif live, nama paket, harga. Tanpa nama provider internal / secret. */
app.get('/api/public/catalog', (req, res) => {
  const strip = (m) => ({ id: m.id, alias: m.alias || m.id, active: !!m.active, context: displayContext(m), pingMs: (m && m.pingMs) || 0 });
  const packages = [];
  // FREE: 10 model paket gratis, status live dari provider hcnsec
  const freeProv = db.providers.find((p) => p.name === FREE_PROVIDER_NAME);
  packages.push({
    id: 'free-500k', name: 'FREE', price: 0, tokens: 700000,
    note: 'Paket gratis — daftar via web untuk generate key.',
    models: FREE_MODEL_IDS.map((id) => {
      const m = freeProv && freeProv.models.find((x) => x.id === id);
      return strip(m ? m : { id });
    }),
  });
  // BASIC / MEMBER / VIP: replika PERSIS logika auto-assign (provider berurutan, aktif, bukan sultan, maks maxModels)
  const planNotes = {
    'basic-1m': '10 model dipilih otomatis.',
    'member-3m': '20 model dipilih otomatis.',
    'vip-8m': 'Semua model (akses penuh).',
  };
  for (const pid of ['basic-1m', 'member-3m', 'vip-8m']) {
    const plan = getPlan(pid);
    const models = [];
    let count = 0;
    for (const p of db.providers) {
      for (const m of p.models) {
        if (!m.active || SULTAN_IDS.has(m.id)) continue;
        if (count >= plan.maxModels) break;
        models.push(strip(m));
        count++;
      }
      if (count >= plan.maxModels) break;
    }
    packages.push({ id: plan.id, name: plan.name, price: plan.price, tokens: plan.tokens, note: planNotes[pid], models });
  }
  // SULTAN: semua model mahal live
  packages.push({
    id: 'sultan', name: 'SULTAN', price: 350000, tokens: 1500000,
    note: 'Semua 8 model mahal terbuka otomatis.',
    models: poolLive(SULTAN_MAHAL).map(strip),
  });
  // SULTAN+: pilih 3 dari 8 model mahal
  packages.push({
    id: 'sultan-plus', name: 'SULTAN+', price: 150000, tokens: 1000000,
    note: 'Pilih 3 dari 8 model mahal.',
    models: poolLive(SULTAN_MAHAL).map(strip),
  });
  // SULTAN++: 8 model menengah + bonus, live
  const bonusIds = new Set(SULTAN_PLUS2_BONUS.map(([bid]) => bid));
  packages.push({
    id: 'sultan-plus2', name: 'SULTAN++', price: 100000, tokens: 1000000,
    note: 'Pilih 5 model menengah + bonus.',
    models: poolLive(SULTAN_MID.concat(SULTAN_PLUS2_BONUS)).map((m) => {
      const s = strip(m);
      if (bonusIds.has(s.id)) s.bonus = true;
      return s;
    }),
  });
  res.json({ packages });
});
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
/* Context window TERVERIFIKASI dari pembuat model resmi (hasil riset dokumen resmi).
   Model yang TIDAK ada di tabel ini dan belum diverifikasi manual TIDAK menampilkan
   chip konteks di halaman publik — dilarang menebak (biar tidak dikira nipu). */
const VERIFIED_CONTEXT = {
  'MiniMax-M3': 1000000, 'minimax-m3': 1000000, 'minimax/minimax-m3': 1000000,
  'minimax/minimax-m2': 204800, 'minimax/minimax-m2.1': 204800,
  'minimax/minimax-m2.1-highspeed': 204800, 'minimax/minimax-m2.5': 204800,
  'minimax/minimax-m2.5-highspeed': 204800, 'minimax/minimax-m2.7': 204800,
  'minimax/minimax-m2.7-highspeed': 204800,
  'DeepSeek-V4-Flash': 1000000, 'DeepSeek-V4-Pro': 1000000,
  'DeepSeek-V4.1-Flash': 1000000, 'deepseek-ai/DeepSeek-V4-Flash-0731': 1000000,
  'deepseek-v4-flash': 1000000,
  'cohere/aya-expanse-32b': 128000, 'cohere/aya-vision-32b': 16000,
  'cohere/command-a': 256000, 'cohere/command-a-plus': 128000,
  'cohere/command-a-reasoning': 256000, 'cohere/command-a-translate': 8000,
  'cohere/command-a-vision': 128000, 'cohere/command-r-08-2024': 128000,
  'cohere/command-r-plus-08-2024': 128000, 'cohere/command-r7b-12-2024': 128000,
  'cohere/north-mini-code': 256000, 'cohere/north-small-translate': 16000,
  'cohere/tiny-aya-earth': 8000, 'cohere/tiny-aya-fire': 8000,
  'cohere/tiny-aya-global': 8000, 'cohere/tiny-aya-water': 8000,
  'mistralai/codestral-2508': 128000, 'mistralai/devstral-medium': 128000,
  'mistralai/ministral-14b': 256000, 'mistralai/ministral-3b': 256000,
  'mistralai/ministral-8b': 256000, 'mistralai/mistral-large-2512': 256000,
  'mistralai/mistral-medium-3.5': 256000, 'mistralai/mistral-small-2603': 256000,
  'claude-opus-5': 1000000, 'claude-opus-5.5': 1000000,
  'claude-sonnet-4-6': 1000000, 'claude-opus-4-6': 1000000,
  'claude-opus-4-7': 1000000, 'claude-opus-4-8': 1000000,
  'gemini-3.8-flash': 1000000, 'grok-4.6': 500000,
  'kimi-k3': 1048576, 'MiMo-V2.6-Flash': 1000000,
  'glm-5.3': 1000000, 'glm-5.3-flash': 1000000,
  'nvidia/nemotron-3-nano-omni': 262144, 'nvidia/nemotron-3-super': 1000000,
  'nvidia/nemotron-3-ultra': 1000000, 'openai/gpt-oss-120b': 128000,
  'liquid/lfm-2.5-2.6b': 128000, 'inclusionai/ling-3.0-flash-sante': 262144,
  'agnes-3.0-flash': 524288,
  'meituan/longcat-2.0': 1000000, 'meituan/longcat-2.5-preview': 1000000,
  'qwen/qwen-plus-2025-07-28': 1000000, 'qwen/qwen3-coder-plus': 1000000,
  'qwen/qwen3-max': 262144, 'qwen/qwen3-vl-plus': 262144,
  'qwen/qwen3.5-397b-a17b': 262144, 'qwen/qwen3.5-flash': 1000000,
  'qwen/qwen3.5-omni-flash': 262144, 'qwen/qwen3.5-omni-plus': 262144,
  'qwen/qwen3.5-plus': 1000000, 'qwen/qwen3.6-27b': 262144,
  'qwen/qwen3.6-35b-a3b': 262144, 'qwen/qwen3.6-max-preview': 262144,
  'qwen/qwen3.6-plus': 1000000, 'qwen/qwen3.7-flash': 1000000,
  'qwen/qwen3.7-max': 1000000, 'qwen/qwen3.7-plus': 1000000,
  'qwen/qwen3.8-max': 1000000, 'qwen3.8-max': 1000000,
  'qwen/qwen3.8-omni-flash': 1000000,
  'Qwen3.8-27B': 262144, 'Qwen3.8-Flash-Next': 262144,
  'qwen3.8-flash': 1000000,
};
const verifiedContext = (id) => {
  const key = String(id || '').replace(/:free$/, '');
  return VERIFIED_CONTEXT[key] || VERIFIED_CONTEXT[id] || 0;
};
// Nilai konteks yang boleh tampil publik: verifikasi manual (prioritas) lalu tabel riset.
const displayContext = (m) => {
  if (!m) return 0;
  if (m.contextVerified && m.context > 0) return m.context;
  return verifiedContext(m.id);
};
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
  assignAliases(models);
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
  if (key.userId) {
    const owner = db.users.find((u) => u.id === key.userId);
    if (owner && owner.suspended) return { ok: false, code: 403, msg: 'Akun pemilik key di-suspend.' };
  }
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

app.get('/api/stats', requireAdmin, (req, res) => {
  const totalTokens = db.usage.reduce((a, u) => a + (u.totalTokens || 0), 0);
  const totalRequests = db.usage.length;
  const activeModels = db.providers.reduce((a, p) => a + p.models.filter((m) => m.active).length, 0);
  const pings = db.providers.map((p) => p.pingMs).filter((x) => x > 0);
  const avgPing = pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : 0;
  const activeKeys = db.gatewayKeys.filter((k) => !k.revoked).length;
  res.json({ totalTokens, totalRequests, activeModels, avgPing, activeKeys, providers: db.providers.length });
});

app.get('/api/plans', (req, res) => res.json({
  plans: PLANS, customRatePer1K: CUSTOM_RATE_PER_1K,
  sultanPools: { mahal: SULTAN_MAHAL.map(([id]) => id), mid: SULTAN_MID.map(([id]) => id), plus2Bonus: SULTAN_PLUS2_BONUS.map(([id]) => id) },
}));

/* ================= PROVIDER (BYOK) ================= */
// 1) Validasi dulu: Base URL + API key user -> daftar model yang support
app.post('/api/providers/validate', requireAdmin, async (req, res) => {
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
app.post('/api/providers', requireAdmin, async (req, res) => {
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

app.get('/api/providers', requireAdmin, (req, res) => {
  res.json({
    providers: db.providers.map((p) => ({
      ...p, apiKey: maskKey(p.apiKey),
      activeCount: p.models.filter((m) => m.active).length,
    })),
  });
});

app.patch('/api/providers/:id/models', requireAdmin, (req, res) => {
  const p = db.providers.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false, msg: 'Provider tidak ditemukan.' });
  const { modelId, active, alias, context } = req.body || {};
  const m = p.models.find((x) => x.id === modelId);
  if (!m) return res.status(404).json({ ok: false, msg: 'Model tidak ditemukan.' });
  if (context !== undefined) {
    const c = parseInt(context, 10);
    if (!Number.isFinite(c) || c < 1000) return res.status(400).json({ ok: false, msg: 'Konteks harus angka ≥ 1000 (satuan token).' });
    m.context = c; m.contextVerified = true;
  }
  if (alias !== undefined) {
    const a = String(alias).trim();
    if (!a) return res.status(400).json({ ok: false, msg: 'Nama alias tidak boleh kosong.' });
    if (p.models.some((x) => x !== m && (x.alias || x.id) === a))
      return res.status(400).json({ ok: false, msg: 'Nama "' + a + '" sudah dipakai model lain.' });
    m.alias = a;
  }
  if (active !== undefined) m.active = !!active;
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/providers/:id/ping', requireAdmin, async (req, res) => {
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

/* Ping otomatis berkala: ukur ulang latensi tiap provider agar angka ping di halaman
   publik selalu segar dan berubah-ubah mengikuti kondisi nyata (bukan angka mati).
   Diukur per provider (wajar: semua model satu provider memang satu server).
   Gagal ping = nilai lama dipertahankan, tidak di-nol-kan. */
const PING_INTERVAL_MS = 15 * 60 * 1000;
async function autoPingProviders() {
  for (const p of db.providers) {
    try {
      const started = Date.now();
      const r = await fetchWithTimeout(p.baseUrl + '/models', {
        headers: { Authorization: 'Bearer ' + p.apiKey },
      }, 15000);
      if (!r.ok) continue;
      await r.text().catch(() => '');
      const ms = Date.now() - started;
      p.pingMs = ms;
      p.models.forEach((m) => (m.pingMs = ms));
      p.lastPingAt = Date.now();
    } catch { /* gagal: pertahankan nilai lama */ }
  }
  saveDb(db);
}
setInterval(autoPingProviders, PING_INTERVAL_MS);
setTimeout(autoPingProviders, 60 * 1000); // ukur pertama 60 dtk setelah server nyala

app.delete('/api/providers/:id', requireAdmin, (req, res) => {
  const i = db.providers.findIndex((x) => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, msg: 'Provider tidak ditemukan.' });
  db.providers.splice(i, 1);
  saveDb(db);
  res.json({ ok: true });
});

/* ================= GATEWAY KEY (hestia-xxxx) ================= */
/* Inti pembuatan key — dipakai dashboard admin & bot Telegram */
function issueGatewayKey(body, req) {
  const { name, providerId, planId, modelIds, keyType, userEmail } = body || {};
  const plan = getPlan(planId);
  const provider = db.providers.find((p) => p.id === providerId);
  if (!provider) return { ok: false, msg: 'Pilih provider dulu.' };
  if (!plan) return { ok: false, msg: 'Pilih paket dulu.' };
  let userId = null;
  if (userEmail) {
    const u = db.users.find((x) => x.email === String(userEmail).trim().toLowerCase());
    if (!u) return { ok: false, msg: 'Email pembeli tidak terdaftar.' };
    userId = u.id;
    const activeCount = db.gatewayKeys.filter((k) => k.userId === userId && k.planId === plan.id && keyActive(k)).length;
    if (activeCount >= (plan.maxKeys || 1))
      return { ok: false, msg: 'Pembeli sudah punya ' + activeCount + ' key aktif di paket ' + plan.name + ' (maks ' + plan.maxKeys + ').' };
  }
  // Jenis key: 'hestia' (provider resmi Hestia) vs 'byok' (provider titipan user)
  const type = keyType === 'hestia' || keyType === 'byok'
    ? keyType
    : (provider.official ? 'hestia' : 'byok');
  if (type === 'hestia' && !provider.official)
    return { ok: false, msg: 'Key Hestia hanya untuk provider resmi.' };
  if (type === 'byok' && provider.official)
    return { ok: false, msg: 'Provider resmi pakai jenis Key Hestia.' };

  const activeModels = provider.models.filter((m) => m.active);
  let chosen = (modelIds && modelIds.length ? modelIds : activeModels.map((m) => m.id))
    .filter((id) => activeModels.some((m) => m.id === id));
  if (!chosen.length) return { ok: false, msg: 'Tidak ada model aktif yang dipilih.' };
  if (chosen.length > plan.maxModels)
    return { ok: false, msg: 'Paket ' + plan.name + ' maksimal ' + plan.maxModels + ' model.' };
  if (!plan.sultan && chosen.some((id) => SULTAN_IDS.has(id)))
    return { ok: false, msg: 'Model Sultan hanya untuk paket Sultan.' };

  const key = 'hestia-' + crypto.randomBytes(18).toString('base64url');
  const gk = {
    id: nid('key'), name: String(name || 'Key Tanpa Nama').slice(0, 60),
    key, providerId: provider.id, planId: plan.id, keyType: type, userId,
    modelIds: chosen, tokenLimit: plan.tokens, tokensUsed: 0,
    requests: 0, revoked: false,
    createdAt: Date.now(), expiresAt: Date.now() + plan.durationDays * 86400000,
  };
  db.gatewayKeys.unshift(gk);
  saveDb(db);
  return {
    ok: true,
    data: {
      key: gk.key, // tampil penuh HANYA saat pembuatan
      baseUrl: publicBaseUrl(req) + '/v1',
      expiresAt: gk.expiresAt, tokenLimit: gk.tokenLimit, modelCount: chosen.length,
      keyName: gk.name, planName: plan.name,
    },
  };
}
app.post('/api/keys', requireAdmin, (req, res) => {
  const r = issueGatewayKey(req.body || {}, req);
  if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
  res.json({ ok: true, ...r.data });
});

/* Pengguna generate 1 key GRATIS sendiri (maks 1 aktif per user) */
app.post('/api/my-keys/free', requireAuth, (req, res) => {
  const plan = getPlan('free-500k');
  const provider = db.providers.find((p) => p.name === FREE_PROVIDER_NAME);
  if (!provider) return res.status(500).json({ ok: false, msg: 'Provider paket gratis sedang tidak tersedia.' });
  const already = db.gatewayKeys.filter((k) => k.userId === req.user.id && k.planId === 'free-500k' && keyActive(k)).length;
  if (already >= (plan.maxKeys || 2)) return res.status(400).json({ ok: false, msg: 'Key gratis kamu sudah ' + already + ' (maks ' + plan.maxKeys + '). Lihat di Key Saya ya.' });
  const activeIds = new Set(provider.models.filter((m) => m.active).map((m) => m.id));
  const chosen = FREE_MODEL_IDS.filter((id) => activeIds.has(id) && !SULTAN_IDS.has(id));
  if (!chosen.length) return res.status(500).json({ ok: false, msg: 'Model paket gratis sedang tidak tersedia.' });
  const key = 'hestia-' + crypto.randomBytes(18).toString('base64url');
  const gk = {
    id: nid('key'), name: String((req.body && req.body.name) || 'Key Gratis').slice(0, 60), key, providerId: provider.id, planId: plan.id,
    keyType: provider.official ? 'hestia' : 'byok', userId: req.user.id,
    modelIds: chosen, tokenLimit: plan.tokens, tokensUsed: 0, requests: 0,
    revoked: false, createdAt: Date.now(), expiresAt: Date.now() + plan.durationDays * 86400000,
  };
  db.gatewayKeys.unshift(gk);
  saveDb(db);
  res.json({
    ok: true, key: gk.key, // tampil penuh HANYA saat pembuatan
    baseUrl: publicBaseUrl(req) + '/v1',
    expiresAt: gk.expiresAt, tokenLimit: gk.tokenLimit, models: chosen,
  });
});

app.get('/api/keys', requireAuth, (req, res) => {
  const list = req.user.role === 'admin' ? db.gatewayKeys : db.gatewayKeys.filter((k) => k.userId === req.user.id);
  res.json({
    keys: list.map((k) => {
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

app.get('/api/keys/:id/reveal', requireAuth, (req, res) => {
  const k = db.gatewayKeys.find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ ok: false });
  if (req.user.role !== 'admin' && k.userId !== req.user.id)
    return res.status(403).json({ ok: false, msg: 'Bukan key kamu.' });
  res.json({ ok: true, key: k.key, baseUrl: publicBaseUrl(req) + '/v1' });
});

app.delete('/api/keys/:id', requireAdmin, (req, res) => {
  const k = db.gatewayKeys.find((x) => x.id === req.params.id);
  if (!k) return res.status(404).json({ ok: false, msg: 'Key tidak ditemukan.' });
  k.revoked = true;
  saveDb(db);
  res.json({ ok: true });
});

/* ================= RIWAYAT & MODEL ================= */
app.get('/api/usage', requireAuth, (req, res) => {
  const { keyId, limit } = req.query;
  let list = db.usage;
  if (req.user.role !== 'admin') {
    const mine = new Set(db.gatewayKeys.filter((k) => k.userId === req.user.id).map((k) => k.id));
    list = list.filter((u) => mine.has(u.keyId));
  }
  if (keyId) list = list.filter((u) => u.keyId === keyId);
  res.json({ usage: list.slice(0, Math.min(parseInt(limit) || 100, 500)) });
});

app.get('/api/models', requireAdmin, (req, res) => {
  const rows = [];
  db.providers.forEach((p) => {
    p.models.forEach((m) => {
      const u = db.usage.filter((x) => x.model === m.id);
      const avgPerReq = u.length ? Math.round(u.reduce((a, x) => a + (x.totalTokens || 0), 0) / u.length) : 0;
      rows.push({
        providerId: p.id, providerName: p.name, id: m.id, alias: m.alias || m.id,
        active: m.active, free: m.free, context: m.context, contextVerified: !!m.contextVerified,
        pingMs: m.pingMs || p.pingMs || 0, avgPerReq, requests: u.length,
      });
    });
  });
  res.json({ models: rows });
});

/* ================= ORDER TOKEN ================= */
app.post('/api/orders', requireAuth, (req, res) => {
  const { planId, customTokens, name, models } = req.body || {};
  let tokens, price, label;
  if (planId) {
    const plan = getPlan(planId);
    if (!plan) return res.status(400).json({ ok: false, msg: 'Paket tidak valid.' });
    tokens = plan.tokens; price = plan.price; label = plan.name + ' • ' + plan.desc;
    if (plan.sultan && plan.pick > 0) {
      const picked = Array.isArray(models) ? models.map(String).slice(0, plan.pick) : [];
      if (picked.length !== plan.pick) return res.status(400).json({ ok: false, msg: 'Pilih ' + plan.pick + ' model.' });
      label += ' • [' + picked.join(', ') + ']';
    }
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
    userId: req.user.id, buyerEmail: req.user.email,
    status: 'pending', createdAt: Date.now(),
  };
  db.orders.unshift(order);
  saveDb(db);
  res.json({
    ok: true, order,
    payInfo: 'Transfer Rp' + price.toLocaleString('id-ID') + ' lalu konfirmasi ke admin. Token aktif otomatis setelah pembayaran diverifikasi.',
  });
});
app.get('/api/orders', requireAuth, (req, res) => {
  const list = req.user.role === 'admin' ? db.orders : db.orders.filter((o) => o.userId === req.user.id);
  res.json({ orders: list.slice(0, 100) });
});
app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  const i = db.orders.findIndex((o) => o.id === req.params.id);
  if (i < 0) return res.status(404).json({ ok: false, msg: 'Order tidak ditemukan.' });
  db.orders.splice(i, 1); saveDb(db);
  res.json({ ok: true });
});

/* ================= BOT TELEGRAM (auth: header x-bot-token) ================= */
// Cek apakah email pembeli terdaftar & tidak di-suspend
app.get('/api/bot/user', requireBot, (req, res) => {
  const em = String(req.query.email || '').trim().toLowerCase();
  const u = db.users.find((x) => x.email === em);
  if (!u) return res.json({ ok: true, exists: false });
  res.json({ ok: true, exists: true, email: u.email, role: u.role, suspended: !!u.suspended });
});
// Pool model Sultan dengan status live (untuk picker di bot)
function poolLive(poolDef) {
  return poolDef.map(([id, provName]) => {
    const p = db.providers.find((x) => x.name === provName);
    const m = p && p.models.find((x) => x.id === id);
    return { id, alias: (m && m.alias) || id, provider: provName, providerId: p ? p.id : null, active: !!(m && m.active), context: displayContext(m), pingMs: (m && m.pingMs) || 0 };
  });
}
app.get('/api/bot/pools', requireBot, (req, res) => {
  res.json({ ok: true, pools: { mahal: poolLive(SULTAN_MAHAL), mid: poolLive(SULTAN_MID), plus2Bonus: poolLive(SULTAN_PLUS2_BONUS) } });
});
// Buat key paket berbayar untuk email pembeli (dipakai bot setelah admin menyetujui pembayaran).
// Satu key terikat satu provider; pembelian multi-provider menghasilkan beberapa key.
app.post('/api/bot/keys', requireBot, (req, res) => {
  const { email, planId, name, modelPicks } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const u = db.users.find((x) => x.email === em);
  if (!u) return res.status(400).json({ ok: false, msg: 'Email belum terdaftar di gateway.' });
  if (u.suspended) return res.status(403).json({ ok: false, msg: 'Akun pembeli di-suspend.' });
  const plan = getPlan(planId);
  if (!plan || plan.id === 'free-500k') return res.status(400).json({ ok: false, msg: 'Paket tidak valid untuk bot.' });

  const groups = new Map(); // providerId -> { provider, ids: [] }
  const addTo = (provId, id) => {
    if (!groups.has(provId)) groups.set(provId, { provider: db.providers.find((x) => x.id === provId), ids: [] });
    groups.get(provId).ids.push(id);
  };

  if (plan.sultan) {
    let poolDef = plan.pool === 'mid' ? SULTAN_MID : SULTAN_MAHAL;
    if (plan.id === 'sultan-plus2') poolDef = poolDef.concat(SULTAN_PLUS2_BONUS); // bonus 1 model sedikit lebih tinggi
    const live = poolLive(poolDef);
    if (plan.pick > 0) {
      const picks = Array.isArray(modelPicks) ? modelPicks.map(String) : [];
      if (picks.length !== plan.pick)
        return res.status(400).json({ ok: false, msg: 'Paket ' + plan.name + ' harus pilih tepat ' + plan.pick + ' model.' });
      const poolIds = new Set(poolDef.map(([id]) => id));
      for (const id of picks) {
        if (!poolIds.has(id)) return res.status(400).json({ ok: false, msg: 'Model "' + id + '" bukan bagian paket ' + plan.name + '.' });
        const li = live.find((x) => x.id === id);
        if (!li || !li.active || !li.providerId)
          return res.status(400).json({ ok: false, msg: 'Model "' + id + '" sedang tidak aktif.' });
        addTo(li.providerId, id);
      }
    } else {
      // SULTAN: semua model mahal yang sedang aktif terbuka otomatis
      const actives = live.filter((x) => x.active && x.providerId);
      if (!actives.length) return res.status(400).json({ ok: false, msg: 'Tidak ada model Sultan yang aktif.' });
      for (const li of actives) addTo(li.providerId, li.id);
    }
  } else {
    // Paket biasa: model non-sultan yang aktif, maksimal plan.maxModels, urut provider
    let count = 0;
    for (const p of db.providers) {
      for (const m of p.models) {
        if (!m.active || SULTAN_IDS.has(m.id)) continue;
        if (count >= plan.maxModels) break;
        addTo(p.id, m.id); count++;
      }
      if (count >= plan.maxModels) break;
    }
    if (!count) return res.status(400).json({ ok: false, msg: 'Tidak ada model aktif untuk paket ini.' });
  }

  const existing = db.gatewayKeys.filter((k) => k.userId === u.id && k.planId === plan.id && keyActive(k)).length;
  if (existing + groups.size > (plan.maxKeys || 1))
    return res.status(400).json({ ok: false, msg: 'Kuota key paket ' + plan.name + ' tidak cukup (' + existing + ' aktif, maks ' + plan.maxKeys + ', butuh ' + groups.size + ' key baru).' });

  const out = [];
  let n = 0;
  for (const [, g] of groups) {
    n++;
    const keyName = String(name || (plan.name + ' via Bot')).slice(0, 50) + (groups.size > 1 ? ' (' + n + '/' + groups.size + ')' : '');
    const r = issueGatewayKey({ name: keyName, providerId: g.provider.id, planId: plan.id, modelIds: g.ids, userEmail: em }, req);
    if (!r.ok) return res.status(400).json({ ok: false, msg: r.msg });
    out.push({ ...r.data, providerName: g.provider.name, modelIds: g.ids });
  }
  res.json({ ok: true, keys: out });
});

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
    // Pembeli hanya melihat ALIAS (nama tampil); id asli disembunyikan
    data: ids.map((id) => {
      const m = provider.models.find((x) => x.id === id);
      return { id: (m && m.alias) || id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'hestia-gateway' };
    }),
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  const started = Date.now();
  const gk = authGatewayKey(req);
  const chk = keyUsable(gk);
  if (!chk.ok) return res.status(chk.code).json({ error: { message: chk.msg } });

  const { model, messages, stream } = req.body || {};
  if (!model || !messages) return res.status(400).json({ error: { message: 'model & messages wajib diisi.' } });
  const provider = db.providers.find((p) => p.id === gk.providerId);
  // Terima alias ATAU id asli, lalu petakan ke id asli untuk diteruskan ke provider
  const pModel = provider && provider.models.find((m) => (m.id === model || m.alias === model) && m.active);
  if (!pModel || !gk.modelIds.includes(pModel.id))
    return res.status(403).json({ error: { message: 'Model "' + model + '" tidak termasuk dalam key ini.' } });
  const realModel = pModel.id;

  const promptText = (messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
  const promptTokens = estimateTokens(promptText);

  let upstream;
  try {
    upstream = await fetchWithTimeout(provider.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + provider.apiKey },
      body: JSON.stringify({ ...req.body, model: realModel }),
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
