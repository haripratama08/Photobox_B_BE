# Mimamch WhatsApp Gateway

Photobox dapat memakai gateway `mimamch/wa-gateway` sebagai provider WhatsApp
self-hosted. Fonnte tetap menjadi default sampai `WHATSAPP_PROVIDER=mimach` diisi.

## Gateway

```bash
cd ~/Apk/PHOTOBOX_A/API/deploy/mimach
mkdir -p wa_credentials media
docker compose up -d
```

Buka `http://127.0.0.1:5001`, masukkan `KEY`, buat session `box-a`, lalu scan QR.

Compose memakai `network_mode: host` karena API Photobox hanya dibuka pada
`127.0.0.1`. Dengan begitu gateway dapat mengambil file foto dari endpoint
lokal Photobox tanpa membuka port foto ke jaringan LAN.

Tambahkan ke `API/.env`:

```env
ENABLE_WHATSAPP=true
WHATSAPP_PROVIDER=mimach
MIMACH_API_URL=http://127.0.0.1:5001
MIMACH_API_KEY=ganti-dengan-key-yang-sama
MIMACH_SESSION=box-a
MIMACH_MEDIA_BASE_URL=http://127.0.0.1:3000/photos
```

`MIMACH_MEDIA_BASE_URL` harus menggunakan port API Photobox yang aktif. Nilai
bawaan instalasi Box A adalah `http://127.0.0.1:3000/photos`.

Semua hasil JPG/PNG dikirim melalui endpoint dokumen, bukan endpoint gambar.
Dengan begitu WhatsApp tidak mengecilkan atau mengompresi file foto. Penerima
akan melihatnya sebagai file yang dapat diunduh dengan nama aslinya.

Untuk hasil cetak 4 x 6 inci pada 720 DPI, gunakan nilai berikut atau hapus
`PRINT_WIDTH` dan `PRINT_HEIGHT` lama agar nilai bawaan yang sama dipakai:

```env
PRINT_DPI=720
PRINT_WIDTH=2880
PRINT_HEIGHT=4320
```

Sesudah mengubah Compose, terapkan ulang gateway:

```bash
cd ~/Apk/PHOTOBOX_A/API/deploy/mimach
sudo docker compose down
sudo docker compose up -d
sudo docker compose ps
```

Session tersimpan di folder `wa_credentials`, sehingga normalnya tidak perlu
scan QR lagi setelah container dibuat ulang.

Sebelum menguji pengiriman, pastikan file foto memang bisa diambil dari API:

```bash
curl -I "http://127.0.0.1:3000/photos/NAMA_FOLDER/NAMA_FILE.jpg"
```

Hasil yang diharapkan adalah `HTTP/1.1 200 OK`. Respons `404` berarti nama atau
lokasi file salah, sedangkan gagal tersambung berarti API belum berjalan di
port 3000.

Status session:

```bash
curl "http://127.0.0.1:5001/session?key=ganti-dengan-key-yang-sama"
```

Log Photobox:

```bash
tail -f state/logs/photobox.jsonl
```

## Antrean pengiriman tahan restart

Setiap hasil sesi disimpan lebih dahulu di `state/whatsapp-outbox.json`. Jika API
ditutup atau restart, pengiriman yang belum selesai dilanjutkan otomatis saat
`node app.js` kembali dijalankan.

Status antrean:

```bash
curl http://127.0.0.1:3000/whatsapp-outbox
```

Coba ulang antrean yang gagal (gunakan ID dari status antrean):

```bash
curl -X POST http://127.0.0.1:3000/whatsapp-outbox/ID_ANTREAN/retry
```

Untuk sesi lama yang dibuat sebelum fitur antrean, kirim ulang foto mentah dari
folder sesi. Secara bawaan frame cetak tidak dikirim ulang:

```bash
curl -X POST http://127.0.0.1:3000/whatsapp-outbox/resend-folder \
  -H "Content-Type: application/json" \
  -d '{"folder":"NAMA_FOLDER","userWA":"628xxxxxxxxxx","userName":"Nama Tamu"}'
```

Pengaturan opsional di `.env`:

```env
WHATSAPP_OUTBOX_RETRY_DELAY_MS=15000
WHATSAPP_OUTBOX_MAX_RETRIES=10
```
