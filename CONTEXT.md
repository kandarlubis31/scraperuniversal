# scraperUniversal — Project Context

## Ringkasan

Scraper web berbasis browser dengan antarmuka. Beri URL, server membuka halaman memakai Chrome,
menggulir sampai batas yang ditentukan untuk memicu konten lazy-load, lalu mengekstrak data dengan
selector CSS. Hasil bisa dilihat langsung di halaman web bawaan.

## Arsitektur

```
server.js (Express)  →  puppeteer-extra + StealthPlugin  →  halaman target
                                  ↓
                        cheerio (parsing HTML hasil render)
                                  ↓
                        public/ (antarmuka: kirim URL, lihat hasil)
```

Dua endpoint: `GET /api/status` (kondisi server) dan `GET /api/scrape` (menjalankan pengambilan).

Banyak situs memblokir browser otomatis, karena itu plugin stealth dipakai dan batas laju diterapkan
per IP. Semua parameter penting bisa diatur lewat variabel lingkungan tanpa mengubah kode:

| Variabel | Default | Arti |
| :--- | :--- | :--- |
| `PORT` | 3000 | Port server |
| `CONCURRENCY` | 3 | Halaman yang diproses bersamaan |
| `TIMEOUT` | 45000 | Batas waktu per halaman (ms) |
| `RETRY_ATTEMPTS` | 2 | Percobaan ulang saat gagal |
| `RETRY_DELAY` | 1500 | Jeda antar percobaan (ms) |
| `MAX_SCROLL` | 8000 | Batas gulir untuk memicu lazy-load |
| `RATE_LIMIT_MAX` | 20 | Permintaan per menit per IP |
| `CHROME_PATH` | otomatis | Lokasi Chrome (Windows/macOS/Linux ditebak) |

## Struktur

```
server.js    Server, konfigurasi, pengambilan halaman, parsing
index.js     Titik masuk
public/      Antarmuka pengguna
```

## Menjalankan

```bash
pnpm install
node server.js        # belum ada script npm "start"
```

## Catatan

- Butuh Chrome terpasang; kalau lokasinya tidak standar, isi `CHROME_PATH`.
- Batas laju melindungi server ini, bukan situs target. Tetap patuhi `robots.txt` dan syarat situs.
- Halaman yang butuh login tidak bisa diambil tanpa profil browser yang sudah diautentikasi.
- Belum ada test otomatis (`npm test` masih placeholder).
