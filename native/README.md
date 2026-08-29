# Photobox Camera Agent

Agent ini memegang satu koneksi libgphoto2 selama backend berjalan. Semua preview,
pengaturan kamera, dan pengambilan foto diproses berurutan oleh proses yang sama.

Build satu kali di Linux:

```bash
sudo apt install build-essential pkg-config libgphoto2-dev
bash scripts/build-camera-agent.sh
```

Backend otomatis memakai `native/photobox-camera-agent` setelah binary berhasil
dibangun. Set `CAMERA_AGENT_ENABLED=false` hanya jika perlu kembali ke fallback
`gphoto2 --shell`.
