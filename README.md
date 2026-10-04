# HESTIA GATEWAY

Web agent untuk menampung API key AI dari berbagai provider + meng-generate API key sendiri (`hestia-xxxx`) yang bisa dipakai ke agent lain / web lain.

## Cara jalan

```
npm install
npm start
```

Buka http://localhost:3000

## Alur pakai (sesuai permintaan)

1. **Tampung key provider lain (BYOK)** — Di halaman *Provider*, isi Nama + Base URL + API Key dari web lain, klik **Validasi & Hubungkan**.
   Server memanggil `<baseUrl>/models` memakai key tersebut, lalu menampilkan **model-model yang support** di API key itu. Simpan sebagai provider.
2. **Generate key sendiri** — Di halaman *API Key*, klik **Buat API Key**, pilih provider + paket + model.
   Web menampilkan **API key `hestia-xxxx`** + **Base URL web ini (`https://domain-kamu/v1`)**.
3. **Pakai di agent lain** — Di agent favorit (SillyTavern, Cherry Studio, LibreChat, dll, semua yang support custom OpenAI endpoint):
   - Base URL: `https://domain-kamu/v1`
   - API Key: `hestia-xxxx`
   - Header otomatis: `Authorization: Bearer hestia-xxxx`
   
   Request diteruskan server ke provider asli memakai key simpanan server. Token dihitung & dicatat di *Riwayat*.

## Fitur

- Dashboard: total token, total request, model aktif, rata-rata ping, grafik 7 hari
- Provider: tambah/hapus, toggle model aktif-nonaktif, ping per provider
- API Key: generate `hestia-xxxx`, masa aktif paket, sisa token, revoke, salin key + base URL + contoh pemakaian
- Model: status aktif/nonaktif, ping, jumlah konteks, rata-rata token per request
- Riwayat: semua pemakaian per key (masuk/keluar/total token)
- Harga: MEMBER 500K/5k/3 hari, MEMBER 1M/10k/1 minggu, VIP 5M/35k/1 bulan, + kalkulator token custom
- Tautan: link resmi ke provider-provider populer untuk ambil API key

## Keamanan

- API key provider tersimpan di `data/db.json` (server-side saja, tidak pernah dikirim utuh ke browser — hanya versi mask).
- Key `hestia-xxxx` tampil penuh hanya saat pembuatan (salin & simpan baik-baik).
- Untuk produksi: jalankan di balik HTTPS + batasi akses dashboard (tambah auth) + backup `data/db.json`.
