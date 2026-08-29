# Photobox A local device agent

`config/devices.json` menyimpan identitas persisten untuk kamera (serial/vendor/product/USB path), queue printer CUPS, connector display/EDID, dan touchscreen (nama/vendor/product/USB path). Nomor `/dev/videoN` tidak dipakai sebagai identitas kamera.

Status perangkat:

```bash
node scripts/device-status.js
```

Endpoint API: `GET /device-status`. Terapkan mapping touchscreen yang tersimpan:

```bash
node scripts/device-status.js map-touch
```

Uji autostart terlebih dahulu dengan `./start_photobox_linux.sh`. Jika sudah stabil:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/photobox-a.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now photobox-a.service
```
