/* HESTIA GATEWAY — frontend SPA */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const NAV = [
  { id: 'dashboard', label: 'Dashboard', ic: '🏠' },
  { id: 'provider', label: 'Provider', ic: '🔑' },
  { id: 'keys', label: 'API Key', ic: '⚡' },
  { id: 'models', label: 'Model', ic: '🤖' },
  { id: 'usage', label: 'Riwayat', ic: '📜' },
  { id: 'pricing', label: 'Harga', ic: '💎' },
  { id: 'etalase', label: 'Etalase', ic: '🛍️' },
  { id: 'links', label: 'Tautan', ic: '🔗' },
];
let PLANS = [], CUSTOM_RATE = 10, PROVIDERS = [];
let validatedModels = null; // hasil validasi BYOK (siap simpan)
let pickedModels = new Set(); // model terpilih utk key baru

/* ---------- helpers ---------- */
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
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

/* ---------- navigation ---------- */
function buildNav() {
  $('#sideNav').innerHTML = NAV.map((n) => `<button data-nav="${n.id}"><span class="ic">${n.ic}</span>${n.label}</button>`).join('');
  $('#bottomNav').innerHTML = NAV.map((n) => `<button data-nav="${n.id}"><span class="ic">${n.ic}</span>${n.label}</button>`).join('');
  $$('[data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
}
function go(id) {
  $$('.page').forEach((p) => p.classList.add('hidden'));
  $('#page-' + id).classList.remove('hidden');
  $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
  window.scrollTo({ top: 0 });
  ({ dashboard: loadDashboard, provider: loadProviders, keys: loadKeyForm, models: loadModels, usage: loadUsage, pricing: loadPricing, etalase: loadEtalase }[id] || (() => {}))();
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
      <p>✅ <b>${r.models.length} model</b> ditemukan di key ini <span class="muted">(${r.latencyMs} ms • ${esc(r.base)})</span></p>
      <div class="model-pick">${r.models.map((m) => `<span class="chip on${m.free ? ' free' : ''}">${esc(m.id)}</span>`).join('')}</div>
      <button class="btn primary" id="btnSavePv">💾 Simpan Provider</button>`;
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
  } catch (e) { toast('❌ ' + e.message); }
  btn.disabled = false; btn.textContent = 'Validasi & Lihat Model';
});

async function loadProviders() {
  const { providers } = await api('/api/providers');
  PROVIDERS = providers;
  $('#providerList').innerHTML = providers.map((p) => `
    <div class="card">
      <div class="card-head"><h3>${esc(p.name)} ${p.official ? '<span class="badge info">🌟 RESMI</span>' : ''}</h3>
        <span><span class="badge ${p.pingMs ? 'ok' : 'warn'}">${p.pingMs ? p.pingMs + ' ms' : 'belum di-ping'}</span>
        <span class="badge info">${p.activeCount}/${p.models.length} aktif</span></span></div>
      <div class="mono" style="font-size:.72rem;color:var(--muted);margin-bottom:8px">${esc(p.baseUrl)}</div>
      <div class="model-pick">${p.models.map((m) => `<span class="chip">${esc(m.id)}</span>`).join('')}</div>
      <div class="row gap wrap">
        <button class="btn ghost sm" onclick="pingProvider('${p.id}')">📶 Ping</button>
        <button class="btn ghost sm" onclick="go('models')">⚙ Kelola Model</button>
        <button class="btn danger sm" onclick="delProvider('${p.id}')">🗑 Hapus</button>
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
  hestia: '🌟 <b>Key Hestia</b>: pakai model-model resmi milik Hestia. Token kepotong dari kuota Hestia — beli paketnya di halaman Harga.',
  byok: '🔑 <b>Key Sendiri (BYOK)</b>: pakai API key & Base URL milikmu sendiri. Token kepotong dari key-mu, bukan dari Hestia.',
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
  const { plans } = await api('/api/plans');
  PLANS = plans;
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
  pickedModels = new Set([...pickedModels].filter((id) => models.some((m) => m.id === id)));
  $('#gkModels').innerHTML = models.map((m) =>
    `<span class="chip${pickedModels.has(m.id) ? ' on' : ''}${m.free ? ' free' : ''}" data-mid="${esc(m.id)}">${esc(m.id)}</span>`).join('')
    || '<span class="muted">Pilih provider yang punya model aktif.</span>';
  $$('#gkModels .chip').forEach((c) => c.addEventListener('click', () => {
    const id = c.dataset.mid;
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
      body: JSON.stringify({ name, providerId, planId, modelIds: [...pickedModels], keyType: keyTab }),
    });
    openModal(`
      <h3>🎉 API Key Berhasil Dibuat!</h3>
      <p class="muted">Salin & simpan baik-baik — key tampil penuh <b>hanya sekali ini</b>.</p>
      <label>API Key</label><div class="codebox" id="mKey">${esc(r.key)}</div>
      <button class="btn primary sm" onclick="copyText(document.getElementById('mKey').textContent,'API key disalin!')">📋 Salin API Key</button>
      <label style="margin-top:12px">Base URL (untuk agent lain)</label><div class="codebox" id="mBase">${esc(r.baseUrl)}</div>
      <button class="btn ghost sm" onclick="copyText(document.getElementById('mBase').textContent,'Base URL disalin!')">📋 Salin Base URL</button>
      <label style="margin-top:12px">Contoh pasang di agent (SillyTavern / Cherry Studio / dll)</label>
      <div class="codebox">Base URL : ${esc(r.baseUrl)}\nAPI Key  : ${esc(r.key)}\nHeader   : Authorization: Bearer ${esc(r.key)}</div>
      <p class="muted">Masa aktif sampai ${fmtDate(r.expiresAt)} • kuota ${fmtN(r.tokenLimit)} token • ${r.modelCount} model</p>
      <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
    $('#gkName').value = '';
    loadKeyForm();
  } catch (e) { toast('❌ ' + e.message); }
});
async function loadKeyList() {
  const { keys } = await api('/api/keys');
  window._keys = keys;
  const f = $('#usageFilter');
  if (f) f.innerHTML = '<option value="">Semua Key</option>' + keys.map((k) => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
  $('#keyList').innerHTML = keys.map((k) => {
    const pct = k.tokenLimit ? Math.min(100, Math.round((k.tokensUsed / k.tokenLimit) * 100)) : 0;
    const st = k.revoked ? '<span class="badge off">DICABUT</span>' : k.expired ? '<span class="badge warn">KEDALUWARSA</span>' : '<span class="badge ok">AKTIF</span>';
    const kt = k.keyType === 'hestia' ? '<span class="badge info">🌟 HESTIA</span>' : '<span class="badge ok">🔑 BYOK</span>';
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
        <button class="btn ghost sm" onclick="revealKey('${k.id}')">👁 Lihat & Salin</button>
        ${k.revoked ? '' : `<button class="btn danger sm" onclick="revokeKey('${k.id}')">Cabut Key</button>`}
      </div></div>`;
  }).join('') || '<p class="muted">Belum ada key. Buat di atas ya.</p>';
}
async function revealKey(id) {
  const r = await api('/api/keys/' + id + '/reveal');
  openModal(`<h3>Detail Key</h3>
    <label>API Key</label><div class="codebox" id="rk">${esc(r.key)}</div>
    <button class="btn primary sm" onclick="copyText(document.getElementById('rk').textContent,'API key disalin!')">📋 Salin API Key</button>
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
async function loadModels() {
  const { models } = await api('/api/models');
  $('#modelCount').textContent = models.filter((m) => m.active).length + ' aktif / ' + models.length + ' total';
  $('#modelTable tbody').innerHTML = models.map((m) => `
    <tr><td>${esc(m.id)}${m.free ? ' <span class="badge ok">FREE</span>' : ''}</td>
    <td>${esc(m.providerName)}</td>
    <td><input type="checkbox" class="switch" ${m.active ? 'checked' : ''} onchange="toggleModel('${m.providerId}','${esc(m.id)}',this.checked)"></td>
    <td>${m.pingMs ? m.pingMs + ' ms' : '—'}</td>
    <td>${fmtN(m.context)}</td>
    <td>${m.avgPerReq ? fmtN(m.avgPerReq) : '—'}</td></tr>`).join('')
    || '<tr><td colspan="6" class="muted">Belum ada model. Tambah provider dulu.</td></tr>';
}
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
  $('#planCards').innerHTML = plans.map((p, i) => `
    <div class="card${i === 2 ? ' glow' : ''}">
      <span class="badge ${i === 2 ? 'info' : 'ok'}">${p.name}</span>
      <div class="price" style="margin:8px 0">${fmtRp(p.price)}</div>
      <ul class="plan-feats">
        <li><b style="color:#fff">${fmtN(p.tokens)}</b> token</li>
        <li>Aktif <b style="color:#fff">${p.durationDays} hari</b></li>
        <li>${p.maxModels >= 9999 ? 'FULL model' : p.maxModels + ' model aktif + ' + p.freeModels + ' model free'}</li>
      </ul>
      <button class="btn ${i === 2 ? 'primary' : 'ghost'} big" onclick="buyPlan('${p.id}')">Beli Paket</button>
    </div>`).join('');
  calcCustom();
  const { orders } = await api('/api/orders');
  $('#orderList').innerHTML = orders.map((o) => `
    <div class="list-item"><span><b>${o.id}</b> — ${esc(o.label)}<br><small class="muted">${esc(o.buyer)} • ${fmtDate(o.createdAt)}</small></span>
    <span style="text-align:right"><b class="neon">${fmtRp(o.price)}</b><br><span class="badge warn">${o.status.toUpperCase()}</span></span></div>`).join('')
    || '<p class="muted">Belum ada order.</p>';
}
function calcCustom() {
  const t = Math.max(0, parseInt($('#customTokens').value) || 0);
  $('#customPrice').textContent = fmtRp(Math.ceil(t / 1000) * CUSTOM_RATE);
}
$('#customTokens').addEventListener('input', calcCustom);
async function buyPlan(planId) {
  const name = prompt('Nama pembeli:', '') || 'Tanpa Nama';
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ planId, name }) });
  openModal(`<h3>🧾 Order Dibuat</h3>
    <div class="kv"><span>ID Order</span><b class="mono">${r.order.id}</b></div>
    <div class="kv"><span>Paket</span><b>${esc(r.order.label)}</b></div>
    <div class="kv"><span>Total</span><b class="neon">${fmtRp(r.order.price)}</b></div>
    <p class="muted">${esc(r.payInfo)}</p>
    <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
  loadPricing();
}
$('#btnBuyCustom').addEventListener('click', async () => {
  const customTokens = parseInt($('#customTokens').value) || 0;
  if (customTokens < 1000) return toast('Minimal 1000 token');
  const name = $('#buyerName').value.trim() || 'Tanpa Nama';
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ customTokens, name }) });
  openModal(`<h3>🧾 Order Dibuat</h3>
    <div class="kv"><span>ID Order</span><b class="mono">${r.order.id}</b></div>
    <div class="kv"><span>Token</span><b>${fmtN(r.order.tokens)}</b></div>
    <div class="kv"><span>Total</span><b class="neon">${fmtRp(r.order.price)}</b></div>
    <p class="muted">${esc(r.payInfo)}</p>
    <button class="btn primary big" onclick="closeModal()">Mengerti!</button>`);
  loadPricing();
});

/* ---------- etalase ---------- */
const ETALASE = [
  { tier: 'Sultan', icon: '👑', desc: 'Kasta tertinggi — untuk paket VIP', items: [
    ['claude-opus-5.5', 'LikeChat - TNT'],
    ['claude-opus-5', 'LikeChat - TNT'],
    ['gpt-6.1-sol', 'LikeChat - TNT'],
    ['gpt-5.5-xhigh', 'LikeChat - TNT'],
    ['claude-sonnet-4-6', 'LikeChat - VYCE (chat)'],
  ]},
  { tier: 'Harian', icon: '⚡', desc: 'Enak dipakai tiap hari — untuk paket MEMBER', items: [
    ['DeepSeek-V4-Pro', 'LikeChat - hcnsec (chat)'],
    ['glm-5.3', 'LikeChat - hcnsec (chat)'],
    ['kimi-k3', 'LikeChat - hcnsec (chat)'],
    ['openai/gpt-oss-120b', 'LikeChat - HyperFusion (file/gambar)'],
    ['deepseek-ai/DeepSeek-V4-Flash-0731', 'LikeChat - HyperFusion (file/gambar)'],
    ['gpt-5.5', 'LikeChat - TNT'],
  ]},
];
async function loadEtalase() {
  const { models } = await api('/api/models');
  const byKey = {};
  models.forEach((m) => (byKey[m.id + '|' + m.providerName] = m));
  $('#etalaseTiers').innerHTML = ETALASE.map((t) => `
    <div class="card"><div class="card-head"><h3>${t.icon} Kasta ${t.tier}</h3><span class="muted">${t.desc}</span></div>
    <div class="link-grid">${t.items.map(([id, prov]) => {
      const m = byKey[id + '|' + prov];
      const live = !!(m && m.active);
      return `<div class="link-card">
        <b class="mono">${esc(id)}</b>
        <small>${esc(prov)}${m ? ' • ' + fmtN(m.context) + ' konteks' : ''}</small>
        <span class="row gap" style="margin-top:8px">
          <span class="badge ${live ? 'ok' : 'off'}">${live ? 'READY' : 'OFF'}</span>
          ${m && m.pingMs ? `<small class="muted">${m.pingMs} ms</small>` : ''}
        </span>
        <button class="btn primary sm" style="margin-top:10px;width:100%" data-nav="pricing">Beli Paket</button>
      </div>`;
    }).join('')}</div></div>`).join('');
  $$('#etalaseTiers [data-nav]').forEach((b) => b.addEventListener('click', () => go(b.dataset.nav)));
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

/* ---------- init ---------- */
$('#btnRefresh').addEventListener('click', () => { go('dashboard'); toast('Data dimuat ulang'); });
buildNav();
loadLinks();
go('dashboard');
