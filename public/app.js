/* HESTIA GATEWAY — frontend SPA */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const NAV_ALL = [
  { id: 'dashboard', label: 'Dashboard', ic: 'home', roles: ['admin'] },
  { id: 'provider', label: 'Provider', ic: 'key', roles: ['admin'] },
  { id: 'keys', label: 'API Key', ic: 'zap', roles: ['admin'] },
  { id: 'models', label: 'Model', ic: 'bot', roles: ['admin'] },
  { id: 'usage', label: 'Riwayat', ic: 'history', roles: ['admin'] },
  { id: 'pricing', label: 'Harga', ic: 'diamond', roles: ['guest', 'user', 'admin'] },
  { id: 'etalase', label: 'Etalase', ic: 'bag', roles: ['guest', 'user', 'admin'] },
  { id: 'links', label: 'Tautan', ic: 'link', roles: ['admin'] },
  { id: 'mykeys', label: 'Key Saya', ic: 'key', roles: ['user'] },
  { id: 'users', label: 'Pengguna', ic: 'users', roles: ['admin'] },
];
const myRole = () => (ME ? ME.role : 'guest');
let PLANS = [], CUSTOM_RATE = 10, PROVIDERS = [];
let SULTAN_IDS = new Set();
let ME = null; // { email, role, suspended } atau null
const sess = () => localStorage.getItem('hg_session') || '';
function deviceId() {
  let d = localStorage.getItem('hg_device');
  if (!d) {
    d = (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36) + Math.random().toString(16).slice(2));
    localStorage.setItem('hg_device', d);
  }
  return d;
}
function fingerprint() {
  const s = [navigator.userAgent, screen.width + 'x' + screen.height,
    (Intl.DateTimeFormat().resolvedOptions().timeZone || ''), navigator.language || ''].join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) >>> 0;
  return 'fp' + h.toString(16);
}
let validatedModels = null; // hasil validasi BYOK (siap simpan)
let pickedModels = new Set(); // model terpilih utk key baru

/* ---------- helpers ---------- */
async function api(path, opts = {}) {
  const token = sess();
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Session-Token': token } : {}), ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/auth/me') {
    if (token) { localStorage.removeItem('hg_session'); ME = null; buildNav(); go('auth'); }
    throw new Error((j && j.msg) || 'Harus login dulu.');
  }
  if (!r.ok && !j.ok && j.error) throw new Error(j.error.message || 'Error ' + r.status);
  if (!r.ok && j.msg) throw new Error(j.msg);
  return j;
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toastWrap').appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function copyText(txt, label = 'Disalin!') {
  navigator.clipboard.writeText(txt).then(() => toast(label)).catch(() => toast('Gagal menyalin'));
}
function openModal(html) { $('#modalBox').innerHTML = html; $('#modalBack').classList.remove('hidden'); }
function closeModal() { $('#modalBack').classList.add('hidden'); }
$('#modalBack').addEventListener('click', (e) => { if (e.target.id === 'modalBack') closeModal(); });
const fmtN = (n) => Number(n || 0).toLocaleString('id-ID');
const fmtRp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const fmtDate = (ts) => new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* ---------- ikon SVG (tanpa emoji) ---------- */
const ICONS = {
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  key: '<circle cx="8" cy="16" r="4.5"/><path d="M11.2 12.8L21 3m-4 1l3 3m-6 0l2.5 2.5"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  diamond: '<path d="M6 3h12l4 6-10 12L2 9l4-6z"/><path d="M2 9h20M9 3l3 6 3-6"/>',
  bag: '<path d="M6 7h15l1 14H5L6 7z"/><path d="M9 10V7a3 3 0 0 1 6 0v3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  signal: '<path d="M5 20v-6M10 20V10M15 20v-8M20 20V4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  pencil: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6"/>',
  chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><path d="M12 21a9 9 0 1 1 9-9c0 2.5-2 3.5-3.5 3.5h-2a2 2 0 0 0-1.4 3.4c.6.7.4 2.1-2.1 2.1z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 19h.01M12 19h.01M16 19h.01"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  lock: '<rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/>',
  users: '<path d=\"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2\"/><circle cx=\"9\" cy=\"7\" r=\"4\"/><path d=\"M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75\"/>',
  login: '<path d=\"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3\"/>',
  logout: '<path d=\"M9 21H5a2 2 0 0 1 2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/>',
};
const ic = (n) => `<svg class="icsvg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;

/* ---------- navigation ---------- */
function buildNav() {
  const role = myRole();
  const items = NAV_ALL.filter((n) => n.roles.includes(role));
  const html = items.map((n) => `<button data-nav="${n.id}"><span class="ic">${ic(n.ic)}</span>${n.label}</button>`).join('');
  $('#sideNav').innerHTML = html;
  $('#mobileNav').innerHTML = html;
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
  const ba = $('#btnAuth');
  if (ba) {
    ba.innerHTML = ic(ME ? 'logout' : 'login');
    ba.title = ME ? 'Keluar (' + ME.email + ')' : 'Masuk / Daftar';
  }
  const bs = $('#btnAuthSide');
  if (bs) {
    bs.innerHTML = (ME ? ic('logout') + ' Keluar' : ic('login') + ' Masuk / Daftar') + (ME ? ' <small class="muted">' + esc(ME.email) + '</small>' : '');
    bs.onclick = () => { ME ? doLogout() : go('auth'); };
  }
}
const PUBLIC_PAGES = ['etalase', 'pricing', 'auth'];
function go(id) {
  const role = myRole();
  const navIds = NAV_ALL.filter((n) => n.roles.includes(role)).map((n) => n.id);
  if (!ME && !PUBLIC_PAGES.includes(id)) id = 'auth';
  else if (ME && !navIds.includes(id) && !PUBLIC_PAGES.includes(id)) id = role === 'admin' ? 'dashboard' : 'etalase';
  $('#mdrawerBack').classList.add('hidden');
  $$('.page').forEach((p) => p.classList.add('hidden'));
  $('#page-' + id).classList.remove('hidden');
  $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  window.scrollTo({ top: 0 });
  ({ dashboard: loadDashboard, provider: loadProviders, keys: loadKeyForm, models: loadModels, usage: loadUsage, pricing: loadPricing, etalase: loadEtalase, auth: () => {}, mykeys: loadMyKeys, users: loadUsers }[id] || (() => {}))();
}

/* ---------- dashboard ---------- */
async function loadDashboard() {
  const s = await api('/api/stats');
  $('#statCards').innerHTML = [
    ['Total Token', fmtN(s.totalTokens), 'token terpakai'],
    ['Model Aktif', fmtN(s.activeModels), 'dari ' + s.providers + ' provider'],
    ['Rata-rata Ping', s.avgPing ? s.avgPing + ' ms' : '—', 'ke provider'],
    ['API Key Aktif', fmtN(s.activeKeys), s.totalRequests + ' request tercatat'],
  ].map(([l, v, d]) => `<div class="stat"><div class="v">${v}</div><div class="l"><b style="color:#fff">${l}</b><br>${d}</div></div>`).join('');
  $('#sidePlan').textContent = s.activeKeys + ' KEY AKTIF';

  const u = await api('/api/usage?limit=300');
  drawChart(u.usage);
  $('#recentList').innerHTML = u.usage.slice(0, 6).map((x) => `
    <div class="list-item"><span><b>${esc(x.keyName)}</b><br><span class="mono">${esc(x.model)}</span></span>
    <span style="text-align:right"><b class="neon">${fmtN(x.totalTokens)}</b><br><small class="muted">${fmtDate(x.ts)}</small></span></div>`
  ).join('') || '<p class="muted">Belum ada pemakaian.</p>';
}
function drawChart(usage) {
  const c = $('#chart7'), ctx = c.getContext('2d');
  const W = c.width = c.offsetWidth * 2, H = c.height = 360;
  const days = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d; });
  const vals = days.map((d) => usage.filter((u) => new Date(u.ts).toDateString() === d.toDateString())
    .reduce((a, x) => a + (x.totalTokens || 0), 0));
  const max = Math.max(...vals, 1), bw = W / 7;
  ctx.clearRect(0, 0, W, H);
  vals.forEach((v, i) => {
    const h = (v / max) * (H - 70);
    const g = ctx.createLinearGradient(0, H - 40 - h, 0, H - 40);
    g.addColorStop(0, '#ff2e9a'); g.addColorStop(1, '#8b5cf6');
    ctx.fillStyle = g;
    const x = i * bw + bw * .22;
    ctx.beginPath(); ctx.roundRect(x, H - 40 - h, bw * .56, h, 8); ctx.fill();
    ctx.fillStyle = '#a89bbd'; ctx.font = '20px Space Grotesk'; ctx.textAlign = 'center';
    ctx.fillText(days[i].toLocaleDateString('id-ID', { weekday: 'short' }), i * bw + bw / 2, H - 12);
  });
}

/* ---------- provider / BYOK ---------- */
$('#btnToggleKey').addEventListener('click', () => {
  const i = $('#pvKey'); i.type = i.type === 'password' ? 'text' : 'password';
});
$('#btnValidate').addEventListener('click', async () => {
  const name = $('#pvName').value.trim(), baseUrl = $('#pvBase').value.trim(), apiKey = $('#pvKey').value.trim();
  if (!name || !baseUrl || !apiKey) return toast('Isi nama, Base URL, dan API key dulu');
  const btn = $('#btnValidate'); btn.disabled = true; btn.textContent = 'Memvalidasi…';
  try {
    const r = await api('/api/providers/validate', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) });
    validatedModels = r.models;
    const box = $('#pvResult'); box.classList.remove('hidden');
    box.innerHTML = `
      <p>${ic('check')} <b>${r.models.length} model</b> ditemukan di key ini <span class="muted">(${r.latencyMs} ms • ${esc(r.base)})</span></p>
      <div class="model-pick">${r.models.map((m) => `<span class="chip on${m.free ? ' free' : ''}">${esc(m.id)}</span>`).join('')}</div>
      <button class="btn primary" id="btnSavePv">${ic('save')} Simpan Provider</button>`;
    $('#btnSavePv').addEventListener('click', async () => {
      try {
        await api('/api/providers', { method: 'POST', body: JSON.stringify({ name, baseUrl, apiKey, models: validatedModels }) });
        toast('Provider tersimpan!');
        $('#pvName').value = $('#pvBase').value = $('#pvKey').value = '';
        box.classList.add('hidden'); validatedModels = null;
        loadProviders();
      } catch (e) { toast(e.message); }
    });
    toast('Key valid! Model-model muncul di bawah');
  } catch (e) { toast(ic('x') + ' ' + e.message); }
  btn.disabled = false; btn.textContent = 'Validasi & Lihat Model';
});

async function loadProviders() {
  const { providers } = await api('/api/providers');
  PROVIDERS = providers;
  $('#providerList').innerHTML = providers.map((p) => `
    <div class="card">
      <div class="card-head"><h3>${esc(p.name)} ${p.official ? '<span class="badge info">' + ic('star') + ' RESMI</span>' : ''}</h3>
        <span><span class="badge ${p.pingMs ? 'ok' : 'warn'}">${p.pingMs ? p.pingMs + ' ms' : 'belum di-ping'}</span>
        <span class="badge info">${p.activeCount}/${p.models.length} aktif</span></span></div>
      <div class="mono" style="font-size:.72rem;color:var(--muted);margin-bottom:8px">${esc(p.baseUrl)}</div>
      <div class="model-pick">${p.models.map((m) => `<span class="chip" title="${esc(m.id)}">${esc(m.alias || m.id)}</span>`).join('')}</div>
      <div class="row gap wrap">
        <button class="btn ghost sm" onclick="pingProvider('${p.id}')">${ic('signal')} Ping</button>
        <button class="btn ghost sm" onclick="go('models')">${ic('gear')} Kelola Model</button>
        <button class="btn danger sm" onclick="delProvider('${p.id}')">${ic('trash')} Hapus</button>
      </div>
    </div>`).join('') || '<p class="muted">Belum ada provider. Tambahkan di atas ya.</p>';
}
async function pingProvider(id) {
  toast('Ping…');
  const r = await api('/api/providers/' + id + '/ping', { method: 'POST' });
  toast(r.ok ? 'Ping: ' + r.pingMs + ' ms' : 'Gagal: ' + r.msg);
  loadProviders();
}
async function delProvider(id) {
  openModal(`<h3>Hapus provider?</h3><p class="muted">Key gateway yang memakai provider ini ikut tidak bisa dipakai.</p>
    <div class="row gap"><button class="btn danger" id="mDel">Ya, hapus</button><button class="btn ghost" onclick="closeModal()">Batal</button></div>`);
  $('#mDel').addEventListener('click', async () => {
    await api('/api/providers/' + id, { method: 'DELETE' });
    closeModal(); toast('Provider dihapus'); loadProviders();
  });
}

/* ---------- gateway keys ---------- */
let keyTab = 'hestia'; // 'hestia' = provider resmi Hestia | 'byok' = provider titipan user
const KEY_DESCS = {
  hestia: ic('star') + ' <b>Key Hestia</b>: pakai model-model resmi milik Hestia. Token kepotong dari kuota Hestia — beli paketnya di halaman Harga.',
  byok: ic('key') + ' <b>Key Sendiri (BYOK)</b>: pakai API key & Base URL milikmu sendiri. Token kepotong dari key-mu, bukan dari Hestia.',
};
function setKeyTab(t) {
  keyTab = t;
  pickedModels = new Set();
  const hb = $('#tabHestia'), bb = $('#tabByok');
  hb.className = 'btn sm ' + (t === 'hestia' ? 'primary' : 'ghost');
  bb.className = 'btn sm ' + (t === 'byok' ? 'primary' : 'ghost');
  $('#keyTypeDesc').innerHTML = KEY_DESCS[t];
  fillProviderSelect();
  renderModelPick();
}
async function loadKeyForm() {
  const { plans, sultanPools } = await api('/api/plans');
  PLANS = plans;
  SULTAN_IDS = new Set((sultanPools && sultanPools.mahal) || []);
  const { providers } = await api('/api/providers');
  PROVIDERS = providers;
  $('#gkPlan').innerHTML = plans.map((p) =>
    `<option value="${p.id}">${p.name} — ${fmtN(p.tokens)} token / ${fmtRp(p.price)} / ${p.durationDays} hari</option>`).join('');
  $('#tabHestia').onclick = () => setKeyTab('hestia');
  $('#tabByok').onclick = () => setKeyTab('byok');
  $('#gkProvider').onchange = renderModelPick;
  $('#gkPlan').onchange = renderModelPick;
  setKeyTab(keyTab);
  loadKeyList();
}
function fillProviderSelect() {
  const list = PROVIDERS.filter((p) => (keyTab === 'hestia' ? p.official : !p.official));
  $('#gkProvider').innerHTML = list.map((p) =>
    `<option value="${p.id}">${esc(p.name)} (${p.activeCount} model aktif)</option>`).join('')
    || `<option value="">— ${keyTab === 'hestia' ? 'tidak ada provider resmi' : 'tambah dulu di halaman Provider'} —</option>`;
}
function renderModelPick() {
  const p = PROVIDERS.find((x) => x.id === $('#gkProvider').value);
  const plan = PLANS.find((x) => x.id === $('#gkPlan').value);
  const models = p ? p.models.filter((m) => m.active) : [];
  const sultanLock = !(plan && plan.sultan);
  pickedModels = new Set([...pickedModels].filter((id) => models.some((m) => m.id === id)));
  $('#gkModels').innerHTML = models.map((m) => {
    const locked = sultanLock && SULTAN_IDS.has(m.id);
    return `<span class="chip${pickedModels.has(m.id) ? ' on' : ''}${m.free ? ' free' : ''}${locked ? ' locked' : ''}" data-mid="${esc(m.id)}" title="${esc(m.id)}${locked ? ' — Model Sultan' : ''}">${locked ? ic('lock') : ''}${esc(m.alias || m.id)}</span>`;
  }).join('')
    || '<span class="muted">Pilih provider yang punya model aktif.</span>';
  $$('#gkModels .chip').forEach((c) => c.addEventListener('click', () => {
    const id = c.dataset.mid;
    if (c.classList.contains('locked')) return toast('Model Sultan hanya untuk paket Sultan');
    if (pickedModels.has(id)) pickedModels.delete(id);
    else {
      if (plan && pickedModels.size >= plan.maxModels) return toast('Paket ini maksimal ' + plan.maxModels + ' model');
      pickedModels.add(id);
    }
    renderModelPick();
  }));
}
$('#btnCreateKey').addEventListener('click', async () => {
  const name = $('#gkName').value.trim() || 'Key Tanpa Nama';
  const providerId = $('#gkProvider').value, planId = $('#gkPlan').value;
  if (!providerId) return toast(keyTab === 'hestia' ? 'Tidak ada provider resmi' : 'Tambah provider dulu di halaman Provider');
  if (!pickedModels.size) return toast('Pilih minimal 1 model');
  try {
    const r = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name, providerId, planId, modelIds: [...pickedModels], keyType: keyTab, userEmail: $('#gkUserEmail').value.trim() }),
    });
    openModal(`
      <h3>${ic('check')} API Key Berhasil Dibuat!</h3>
      <p class="muted">Salin & simpan baik-baik — key tampil penuh <b>hanya sekali ini</b>.</p>
      <label>API Key</label><div class="codebox" id="mKey">${esc(r.key)}</div>
      <button class="btn primary sm" onclick="copyText(document.getElementById('mKey').textContent,'API key disalin!')">${ic('copy')} Salin API Key</button>
      <label style="margin-top:12px">Base URL (untuk agent lain)</label><div class="codebox" id="mBase">${esc(r.baseUrl)}</div>
      <button class="btn ghost sm" onclick="copyText(document.getElementById('mBase').textContent,'Base URL disalin!')">${ic('copy')} Salin Base URL</button>
      <label style="margin-top:12px">Contoh pasang di agent (SillyTavern / Cherry Studio / dll)</label>
      <div class="codebox">Base URL : ${esc(r.baseUrl)}\nAPI Key  : ${esc(r.key)}\nHeader   : Authorization: Bearer ${esc(r.key)}</div>
      <p class="muted">Masa aktif sampai ${fmtDate(r.expiresAt)} • kuota ${fmtN(r.tokenLimit)} token • ${r.modelCount} model</p>
      <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
    $('#gkName').value = '';
    loadKeyForm();
  } catch (e) { toast(ic('x') + ' ' + e.message); }
});
async function loadKeyList() {
  const { keys } = await api('/api/keys');
  window._keys = keys;
  const f = $('#usageFilter');
  if (f) f.innerHTML = '<option value="">Semua Key</option>' + keys.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $('#keyList').innerHTML = keys.map((k) => {
    const pct = k.tokenLimit ? Math.min(100, Math.round((k.tokensUsed / k.tokenLimit) * 100)) : 0;
    const st = k.revoked ? '<span class="badge off">DICABUT</span>' : k.expired ? '<span class="badge warn">KEDALUWARSA</span>' : '<span class="badge ok">AKTIF</span>';
    const kt = k.keyType === 'hestia' ? '<span class="badge info">' + ic('star') + ' HESTIA</span>' : '<span class="badge ok">' + ic('key') + ' BYOK</span>';
    return `<div class="key-card">
      <div class="card-head"><h3>${esc(k.name)}</h3><span class="row gap">${kt}${st}</span></div>
      <div class="keyline">${esc(k.masked)}</div>
      <div class="kv"><span>Paket</span><b>${esc(k.planName)}</b></div>
      <div class="kv"><span>Provider</span><b>${esc(k.providerName)}</b></div>
      <div class="kv"><span>Token terpakai</span><b>${fmtN(k.tokensUsed)} / ${fmtN(k.tokenLimit)}</b></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="kv"><span>Sisa</span><b class="neon">${fmtN(k.tokensLeft)}</b></div>
      <div class="kv"><span>Request</span><b>${fmtN(k.requests)}</b></div>
      <div class="kv"><span>Model</span><b>${k.modelCount} model</b></div>
      <div class="kv"><span>Berlaku s/d</span><b>${k.expiresAt ? fmtDate(k.expiresAt) : '—'}</b></div>
      <div class="row gap wrap" style="margin-top:10px">
        <button class="btn ghost sm" onclick="revealKey('${k.id}')">${ic('eye')} Lihat & Salin</button>
        ${k.revoked ? '' : `<button class="btn danger sm" onclick="revokeKey('${k.id}')">Cabut Key</button>`}
      </div></div>`;
  }).join('') || '<p class="muted">Belum ada key. Buat di atas ya.</p>';
}
async function revealKey(id) {
  const r = await api('/api/keys/' + id + '/reveal');
  openModal(`<h3>Detail Key</h3>
    <label>API Key</label><div class="codebox" id="rk">${esc(r.key)}</div>
    <button class="btn primary sm" onclick="copyText(document.getElementById('rk').textContent,'API key disalin!')">${ic('copy')} Salin API Key</button>
    <label style="margin-top:10px">Base URL</label><div class="codebox">${esc(r.baseUrl)}</div>
    <button class="btn ghost sm" onclick="closeModal()" style="margin-top:12px">Tutup</button>`);
}
async function revokeKey(id) {
  openModal(`<h3>Cabut key ini?</h3><p class="muted">Key tidak bisa dipakai lagi di agent mana pun.</p>
    <div class="row gap"><button class="btn danger" id="mRev">Ya, cabut</button><button class="btn ghost" onclick="closeModal()">Batal</button></div>`);
  $('#mRev').addEventListener('click', async () => {
    await api('/api/keys/' + id, { method: 'DELETE' });
    closeModal(); toast('Key dicabut'); loadKeyList();
  });
}

/* ---------- models ---------- */
let lastModels = [];
async function loadModels() {
  const { models } = await api('/api/models');
  lastModels = models;
  $('#modelCount').textContent = models.filter((m) => m.active).length + ' aktif / ' + models.length + ' total';
  $('#modelTable tbody').innerHTML = models.map((m) => `
    <tr><td><b>${esc(m.alias || m.id)}</b>${m.free ? ' <span class="badge ok">FREE</span>' : ''}
      <button class="mini-btn" data-rename-pid="${m.providerId}" data-rename-mid="${esc(m.id)}" title="Ganti nama tampil">${ic('pencil')}</button><br>
      <span class="muted" style="font-size:11px">${esc(m.id)}</span></td>
    <td>${esc(m.providerName)}</td>
    <td><input type="checkbox" class="switch" ${m.active ? 'checked' : ''} onchange="toggleModel('${m.providerId}','${esc(m.id)}',this.checked)"></td>
    <td>${m.pingMs ? m.pingMs + ' ms' : '—'}</td>
    <td>${fmtN(m.context)}</td>
    <td>${m.avgPerReq ? fmtN(m.avgPerReq) : '—'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Belum ada model. Tambah provider dulu.</td></tr>';
}
$('#modelTable tbody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-rename-pid]');
  if (!b) return;
  const pid = b.dataset.renamePid, mid = b.dataset.renameMid;
  const cur = (lastModels.find((m) => m.providerId === pid && m.id === mid) || {}).alias || mid;
  const name = prompt('Nama tampil untuk model ini (yang dilihat pembeli):', cur);
  if (!name || !name.trim() || name.trim() === cur) return;
  const r = await api('/api/providers/' + pid + '/models', { method: 'PATCH', body: JSON.stringify({ modelId: mid, alias: name.trim() }) });
  if (r.ok) { toast('Nama tampil diganti'); loadModels(); }
  else toast(r.msg || 'Gagal mengganti nama');
});
async function toggleModel(providerId, modelId, active) {
  await api('/api/providers/' + providerId + '/models', { method: 'PATCH', body: JSON.stringify({ modelId, active }) });
  toast(active ? 'Model diaktifkan' : 'Model dinonaktifkan');
}
$('#btnPingAll').addEventListener('click', async () => {
  const { providers } = await api('/api/providers');
  toast('Ping ' + providers.length + ' provider…');
  for (const p of providers) { try { await api('/api/providers/' + p.id + '/ping', { method: 'POST' }); } catch {} }
  toast('Selesai'); loadModels();
});

/* ---------- usage ---------- */
async function loadUsage() {
  const keyId = $('#usageFilter').value;
  const { usage } = await api('/api/usage?keyId=' + keyId + '&limit=200');
  window._usage = usage;
  $('#usageTable tbody').innerHTML = usage.map((u) => `
    <tr><td>${fmtDate(u.ts)}</td><td>${esc(u.keyName)}</td><td>${esc(u.model)}</td>
    <td>${fmtN(u.promptTokens)}</td><td>${fmtN(u.completionTokens)}</td>
    <td><b class="neon">${fmtN(u.totalTokens)}</b></td>
    <td>${u.ok ? '<span class="badge ok">OK</span>' : '<span class="badge off">GAGAL</span>'}</td></tr>`).join('')
    || '<tr><td colspan="7" class="muted">Belum ada riwayat.</td></tr>';
}
$('#usageFilter').addEventListener('change', loadUsage);
$('#btnExportCsv').addEventListener('click', () => {
  const rows = [['waktu', 'key', 'model', 'in', 'out', 'total', 'status'],
    ...(window._usage || []).map((u) => [new Date(u.ts).toISOString(), u.keyName, u.model, u.promptTokens, u.completionTokens, u.totalTokens, u.ok ? 'OK' : 'GAGAL'])];
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'riwayat-hestia-gateway.csv'; a.click();
  toast('CSV diunduh');
});

/* ---------- pricing ---------- */
async function loadPricing() {
  const { plans, customRatePer1K } = await api('/api/plans');
  CUSTOM_RATE = customRatePer1K;
  const planCard = (p, i) => `
    <div class="card${i === 2 ? ' glow' : ''}">
      <span class="badge ${p.price > 0 ? 'info' : 'ok'}">${p.name}</span>
      <div class="price" style="margin:8px 0">${fmtRp(p.price)}</div>
      <ul class="plan-feats">
        <li><b style="color:#fff">${fmtN(p.tokens)}</b> token</li>
        <li>Aktif <b style="color:#fff">${p.durationDays} hari</b></li>
        <li>${p.maxModels >= 9999 ? 'FULL model' : 's.d. ' + p.maxModels + ' model pilihan'}</li>
        <li><b style="color:#fff">${p.maxKeys}</b> API key</li>
      </ul>
      ${p.price > 0 ? `<button class="btn primary big" onclick="buyPlan('${p.id}')">Beli Paket</button>` : `<button class="btn primary big" onclick="genFreeKey()">Generate Key Gratis</button>`}
    </div>`;
  $('#planCards').innerHTML = plans.filter((p) => !p.sultan).map(planCard).join('');
  $('#sultanCards').innerHTML = plans.filter((p) => p.sultan).map((p) => `
    <div class="card glow">
      <span class="badge info">${p.name}</span>
      <div class="price" style="margin:8px 0">${fmtRp(p.price)}</div>
      <ul class="plan-feats">
        <li>Bonus <b style="color:#fff">${fmtN(p.tokens)}</b> token</li>
        <li>Aktif <b style="color:#fff">${p.durationDays} hari</b></li>
        <li>${esc(p.desc.split('•').slice(2).join('•').trim() || p.desc)}</li>
        <li><b style="color:#fff">${p.maxKeys}</b> API key</li>
      </ul>
      <button class="btn primary big" onclick="buySultan('${p.id}')">Beli Paket</button>
    </div>`).join('');
  calcCustom();
  let orders = [];
  try { ({ orders } = await api('/api/orders')); } catch (e) { orders = []; }
  $('#orderList').innerHTML = orders.map((o) => `
    <div class="list-item"><span><b>${o.id}</b> — ${esc(o.label)}<br><small class="muted">${esc(o.buyer)} • ${fmtDate(o.createdAt)}</small></span>
    <span style="text-align:right"><b class="neon">${fmtRp(o.price)}</b><br><span class="badge warn">${o.status.toUpperCase()}</span>
    <button class="mini-btn" title="Hapus order" onclick="delOrder('${o.id}')">${ic('trash')}</button></span></div>`).join('')
    || '<p class="muted">Belum ada order.</p>';
}
async function delOrder(id) {
  if (!confirm('Hapus order ' + id + '?')) return;
  await api('/api/orders/' + id, { method: 'DELETE' });
  loadPricing();
}
function calcCustom() {
  const t = Math.max(0, parseInt($('#customTokens').value) || 0);
  $('#customPrice').textContent = fmtRp(Math.ceil(t / 1000) * CUSTOM_RATE);
}
$('#customTokens').addEventListener('input', calcCustom);
/* ---------- beli paket sultan (dengan pilih model) ---------- */
async function buySultan(planId) {
  if (needLogin()) return;
  const { plans, sultanPools } = await api('/api/plans');
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return toast('Paket tidak valid');
  let picked = [];
  if (plan.pick > 0) {
    const { models } = await api('/api/public/models');
    const pool = (sultanPools[plan.pool] || [])
      .map((id) => {
        const m = models.find((x) => x.id === id);
        return m ? { id, alias: m.alias || id } : null;
      })
      .filter(Boolean);
    if (!pool.length) return toast('Model belum tersedia');
    openModal(`<h3>${ic('diamond')} Pilih ${plan.pick} Model — ${esc(plan.name)}</h3>
      <div class="pick-list">${pool.map((x) => `
        <label class="pick-item"><input type="checkbox" value="${esc(x.id)}"><span><b>${esc(x.alias)}</b><br><small class="muted">Hestia</small></span></label>`).join('')}
      </div>
      <div class="row gap" style="margin-top:14px">
        <button class="btn ghost big" style="flex:1" onclick="closeModal()">Batal</button>
        <button class="btn primary big" style="flex:2" id="btnPickGo">Lanjut</button>
      </div>`);
    const boxes = [...document.querySelectorAll('#modalBox .pick-item input')];
    boxes.forEach((b) => b.addEventListener('change', () => {
      if (boxes.filter((x) => x.checked).length > plan.pick) { b.checked = false; toast('Maksimal ' + plan.pick + ' model'); }
    }));
    $('#btnPickGo').addEventListener('click', () => {
      picked = boxes.filter((x) => x.checked).map((x) => x.value);
      if (picked.length !== plan.pick) return toast('Pilih ' + plan.pick + ' model ya');
      closeModal();
      finishSultanOrder(plan, picked);
    });
    return;
  }
  finishSultanOrder(plan, []);
}
async function finishSultanOrder(plan, picked) {
  const name = prompt('Nama pembeli:', '') || 'Tanpa Nama';
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ planId: plan.id, name, models: picked }) });
  openModal(`<h3>${ic('receipt')} Order Dibuat</h3>
    <div class="kv"><span>ID Order</span><b class="mono">${r.order.id}</b></div>
    <div class="kv"><span>Paket</span><b>${esc(r.order.label)}</b></div>
    <div class="kv"><span>Total</span><b class="neon">${fmtRp(r.order.price)}</b></div>
    <p class="muted">${esc(r.payInfo)}</p>
    <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
  loadPricing();
}
function needLogin() {
  if (!ME) { toast('Masuk dulu ya untuk membeli'); go('auth'); return true; }
  return false;
}
async function buyPlan(planId) {
  if (needLogin()) return;
  const name = prompt('Nama pembeli:', '') || 'Tanpa Nama';
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ planId, name }) });
  openModal(`<h3>${ic('receipt')} Order Dibuat</h3>
    <div class="kv"><span>ID Order</span><b class="mono">${r.order.id}</b></div>
    <div class="kv"><span>Paket</span><b>${esc(r.order.label)}</b></div>
    <div class="kv"><span>Total</span><b class="neon">${fmtRp(r.order.price)}</b></div>
    <p class="muted">${esc(r.payInfo)}</p>
    <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
  loadPricing();
}
async function genFreeKey() {
  if (needLogin()) return;
  openModal(`<h3>Pesan dari Hestia Gateway</h3>
    <p>Akun Gratis hanya bisa membuat 2 api key dan kamu mendapatkan 700k Token 10 Model Ai</p>
    <div class="row gap" style="margin-top:14px">
      <button class="btn ghost big" style="flex:1" onclick="closeModal()">Batal</button>
      <button class="btn primary big" style="flex:1" id="btnGenFreeOk">Oke</button>
    </div>`);
  $('#btnGenFreeOk').addEventListener('click', async () => {
    closeModal();
    try {
      const r = await api('/api/my-keys/free', { method: 'POST' });
      openModal(`<h3>${ic('key')} Key Gratis Dibuat</h3>
        <div class="kv"><span>Base URL</span><b class="mono">${esc(r.baseUrl)}</b></div>
        <div class="kv"><span>API Key</span><b class="mono">${esc(r.key)}</b></div>
        <p class="muted">Key ini bisa kamu lihat kapan saja di halaman Key Saya lewat tombol Lihat &amp; Salin.</p>
        <button class="btn primary big" onclick="closeModal();go('mykeys')">Lihat Key Saya</button>`);
    } catch (e) { toast(e.message); }
  });
}
$('#btnBuyCustom').addEventListener('click', async () => {
  if (needLogin()) return;
  const customTokens = parseInt($('#customTokens').value) || 0;
  if (customTokens < 1000) return toast('Minimal 1000 token');
  const name = $('#buyerName').value.trim() || 'Tanpa Nama';
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ customTokens, name }) });
  openModal(`<h3>${ic('receipt')} Order Dibuat</h3>
    <div class="kv"><span>ID Order</span><b class="mono">${r.order.id}</b></div>
    <div class="kv"><span>Token</span><b>${fmtN(r.order.tokens)}</b></div>
    <div class="kv"><span>Total</span><b class="neon">${fmtRp(r.order.price)}</b></div>
    <p class="muted">${esc(r.payInfo)}</p>
    <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
  loadPricing();
});

/* ---------- etalase ---------- */
async function loadEtalase() {
  const { tiers } = await api('/api/public/etalase');
  document.getElementById('etalaseTiers').innerHTML = tiers.map((t) => `
    <div class="card"><div class="card-head"><h3>${ic(t.icon)} ${t.tier}</h3><span class="muted">${t.desc}</span></div>
    <div class="link-grid">${t.items.map((m) => `
      <div class="link-card">
        <b class="mono">${esc(m.alias || m.id)}</b>
        <small>Hestia${m.context ? ' \u2022 ' + fmtN(m.context) + ' konteks' : ''}</small>
        <span class="row gap" style="margin-top:8px">
          <span class="badge ${m.active ? 'ok' : 'off'}">${m.active ? 'READY' : 'OFF'}</span>
          ${m.pingMs ? `<small class="muted">${m.pingMs} ms</small>` : ''}
        </span>
        <button class="btn primary sm" style="margin-top:10px;width:100%" data-nav="pricing">Beli Paket</button>
      </div>`).join('')}</div></div>`).join('');
  document.querySelectorAll('#etalaseTiers [data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
}

/* ---------- provider links ---------- */
const LINKS = [
  ['OpenAI', 'ChatGPT API resmi', 'https://platform.openai.com/api-keys'],
  ['Anthropic', 'Claude API', 'https://console.anthropic.com/'],
  ['Google AI Studio', 'Gemini API gratis', 'https://aistudio.google.com/apikey'],
  ['Groq', 'Gratis, cepat', 'https://console.groq.com/keys'],
  ['OpenRouter', 'Ratusan model satu key', 'https://openrouter.ai/keys'],
  ['Together AI', 'Open-source models', 'https://api.together.xyz/settings/api-keys'],
  ['DeepSeek', 'Murah & pintar', 'https://platform.deepseek.com/api_keys'],
  ['Mistral AI', 'La Plateforme', 'https://console.mistral.ai/api-keys/'],
  ['Fireworks AI', 'Banyak model open', 'https://fireworks.ai/'],
  ['xAI', 'Grok API', 'https://console.x.ai/'],
  ['Cohere', 'Command models', 'https://dashboard.cohere.com/api-keys'],
  ['Perplexity', 'Sonar models', 'https://www.perplexity.ai/settings/api'],
];
function loadLinks() {
  $('#linkGrid').innerHTML = LINKS.map(([n, d, u]) => `
    <a class="link-card" href="${u}" target="_blank" rel="noopener">
      <b>${n}</b><small>${d}</small><span class="go">Ambil API key →</span></a>`).join('');
}

/* ---------- auth ---------- */
let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('#tabLogin').className = 'btn sm' + (m === 'login' ? ' primary' : ' ghost');
  $('#tabRegister').className = 'btn sm' + (m === 'register' ? ' primary' : 'ghost');
  $('#tabLogin').style.flex = $('#tabRegister').style.flex = 1;
  $('#btnDoAuth').textContent = m === 'login' ? 'Masuk' : 'Daftar';
  $('#authMsg').textContent = '';
}
async function doAuth() {
  const email = $('#authEmail').value.trim();
  const password = $('#authPass').value;
  $('#authMsg').textContent = '';
  if (!email || !password) { $('#authMsg').textContent = 'Isi email dan sandi dulu.'; return; }
  try {
    const r = await api('/api/auth/' + authMode, {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceId: deviceId(), fp: fingerprint() }),
    });
    localStorage.setItem('hg_session', r.token);
    ME = r.user;
    buildNav();
    if (r.user.suspended) { go('auth'); $('#authMsg').textContent = 'Akun ini di-suspend karena terdeteksi banyak akun dalam 1 device.'; return; }
    toast(authMode === 'login' ? 'Selamat datang kembali!' : 'Akun dibuat! Selamat datang.');
    go(ME.role === 'admin' ? 'dashboard' : 'etalase');
  } catch (e) { $('#authMsg').textContent = e.message; }
}
async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  localStorage.removeItem('hg_session');
  ME = null;
  buildNav();
  go('etalase');
  toast('Kamu sudah keluar.');
}
async function boot() {
  try {
    const r = await api('/api/auth/me');
    ME = r.user;
  } catch (e) { ME = null; }
  buildNav();
  setAuthMode('login');
  loadLinks();
  go(ME ? (ME.role === 'admin' ? 'dashboard' : 'etalase') : 'etalase');
}
/* ---------- key saya (pembeli) ---------- */
async function loadMyKeys() {
  $('#myBaseUrl').textContent = location.origin + '/v1';
  $('#btnCopyBase').onclick = () => copyText(location.origin + '/v1', 'Base URL disalin!');
  const { keys } = await api('/api/keys');
  $('#myKeyList').innerHTML = keys.map((k) => `
    <div class="card"><div class="card-head"><h3>${esc(k.name)}</h3>
      <span class="badge ${k.revoked ? 'off' : (k.expired ? 'warn' : 'ok')}">${k.revoked ? 'DICABUT' : (k.expired ? 'KEDALUWARSA' : 'AKTIF')}</span></div>
      <div class="kv"><span>Paket</span><b>${esc(k.planName)}</b></div>
      <div class="kv"><span>Token</span><b>${fmtN(k.tokensLeft)} / ${fmtN(k.tokenLimit)}</b></div>
      <div class="kv"><span>Model</span><b>${k.modelCount} model</b></div>
      <div class="kv"><span>Key</span><b class="mono">${esc(k.masked)}</b></div>
      <div class="row gap" style="margin-top:10px">
        <button class="btn ghost sm" onclick="revealMyKey('${k.id}')">Lihat &amp; Salin</button>
      </div>
    </div>`).join('') || '<p class="muted">Belum ada key. Beli paket dulu di halaman Harga ya.</p>';
}
async function revealMyKey(id) {
  const r = await api('/api/keys/' + id + '/reveal');
  openModal(`<h3>${ic('key')} API Key Kamu</h3>
    <div class="codebox">${esc(r.key)}</div>
    <p class="muted">Base URL: <b class="mono">${esc(r.baseUrl)}</b><br>Jaga key ini baik-baik, jangan disebar.</p>
    <div class="row gap"><button class="btn ghost big" style="flex:1" onclick="copyText('${r.key}','Key disalin!')">Salin</button>
    <button class="btn primary big" style="flex:1" onclick="closeModal()">Tutup</button></div>`);
}
/* ---------- pengguna (admin) ---------- */
async function loadUsers() {
  const { users } = await api('/api/users');
  $('#userList').innerHTML = users.map((u) => `
    <div class="list-item"><span><b>${esc(u.email)}</b>
      <span class="badge ${u.role === 'admin' ? 'info' : 'ok'}" style="margin-left:6px">${u.role.toUpperCase()}</span>
      ${u.suspended ? '<span class="badge off" style="margin-left:6px">SUSPEND</span>' : ''}
      <br><small class="muted">${u.deviceAccounts} akun di device ini • ${u.keys} key aktif • ${fmtDate(u.createdAt)}</small></span>
      <span>${u.role !== 'admin' ? (u.suspended
        ? `<button class="btn ghost sm" onclick="unsuspendUser('${u.id}')">Buka Suspend</button>`
        : `<button class="btn ghost sm" onclick="suspendUser('${u.id}')">Suspend</button>`)
        + ` <button class="mini-btn" title="Hapus akun" onclick="delUser('${u.id}')">${ic('trash')}</button>` : ''}</span>
    </div>`).join('') || '<p class="muted">Belum ada pengguna.</p>';
}
async function suspendUser(id) {
  if (!confirm('Suspend akun ini? Key-nya tidak bisa dipakai.')) return;
  await api('/api/users/' + id + '/suspend', { method: 'POST' });
  loadUsers(); toast('Akun di-suspend.');
}
async function unsuspendUser(id) {
  await api('/api/users/' + id + '/unsuspend', { method: 'POST' });
  loadUsers(); toast('Suspend dibuka.');
}
async function delUser(id) {
  if (!confirm('Hapus akun ini permanen? Key miliknya ikut dicabut.')) return;
  await api('/api/users/' + id, { method: 'DELETE' });
  loadUsers(); toast('Akun dihapus.');
}

/* ---------- init ---------- */
$('#btnMenu').addEventListener('click', () => $('#mdrawerBack').classList.remove('hidden'));
$('#mdrawerBack').addEventListener('click', (e) => { if (e.target.id === 'mdrawerBack') $('#mdrawerBack').classList.add('hidden'); });
$('#btnRefresh').addEventListener('click', () => { const r = myRole(); go(r === 'admin' ? 'dashboard' : 'etalase'); toast('Data dimuat ulang'); });
$('#btnAuth').addEventListener('click', () => { ME ? doLogout() : go('auth'); });
$('#tabLogin').addEventListener('click', () => setAuthMode('login'));
$('#tabRegister').addEventListener('click', () => setAuthMode('register'));
$('#btnDoAuth').addEventListener('click', doAuth);
boot();
