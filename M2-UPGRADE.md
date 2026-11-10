# KantorAI M2 — Panduan Upgrade

Paket ini adalah **overlay kode** untuk meng-upgrade instalasi M0 yang sudah berjalan. Ekstrak isi ZIP langsung ke folder proyek yang sudah ada dan izinkan file kode ditimpa. ZIP ini tidak menyertakan file `.env`, folder `node_modules`, migrasi Prisma baru, atau volume database.

## Sebelum upgrade

1. Di terminal tempat `npm.cmd run dev` berjalan, tekan `Ctrl+C`.
2. Buat salinan cadangan folder proyek.
3. Jangan jalankan `docker compose down -v` dan jangan hapus `kantorai-postgres-data`; data agent/task milik Anda berada di database tersebut.

## Konfigurasi lokal dan pasang M2

Buka `.env`, lalu pastikan `REDIS_URL` memakai alamat loopback ini (ubah baris yang ada; jangan dibuat duplikat):

```dotenv
REDIS_URL=redis://127.0.0.1:6379
TASK_EXECUTOR_MODE=dry-run
TASK_WORKER_CONCURRENCY=2
ARTIFACTS_DIR=./data/artifacts
```

Tambahkan hanya baris M2 yang belum ada. Biarkan `DB_PASSWORD` dan `DATABASE_URL` yang sudah bekerja tetap sama. Pastikan `FRONTEND_ORIGIN` serta `VITE_API_URL` masih sesuai alamat yang sedang dipakai browser (`127.0.0.1` pada instalasi ini). Jangan salin contoh password atau membuat file `.env` baru karena akan mengubah kredensial/koneksi workspace.

Dari PowerShell pada folder proyek yang sudah ada, misalnya `D:\KantorAI_kamal`, jalankan:

```powershell
npm.cmd install
npm.cmd run db:generate
npm.cmd run build
```

Tidak ada perubahan schema database M2, jadi tidak perlu menjalankan `db:migrate` atau `db:seed` ulang untuk workspace yang sudah berfungsi. Jika `build` gagal, simpan seluruh pesan error sebelum melanjutkan.

Lalu mulai semua proses:

```powershell
npm.cmd run dev
```

Skrip root akan menjalankan tiga proses yang terpisah: API, BullMQ task worker, dan web Vite. Biarkan terminal tetap terbuka. Buka `http://127.0.0.1:5173`.

## Uji Task Execution Engine

1. Buka `Pengaturan`. Pastikan PostgreSQL, Redis, dan Task worker menunjukkan status siap/online.
2. Buka `Papan Tugas`, lalu buat task uji yang ditugaskan kepada agent aktif, misalnya Ardi. Centang `Masukkan ke antrian`.
3. Tunggu sampai task berstatus `Menunggu review` (REVIEW_REQUIRED).
4. Tekan `Run & artefak` untuk melihat riwayat eksekusi dan unduh laporan diagnostik. Buka `Riwayat & event` untuk memeriksa event run.

**Batasan M2:** task worker hanya melakukan dry-run diagnostik. Worker tidak mengirim instruksi ke model AI, tidak menjalankan kode pengguna, dan tidak menghasilkan keluaran tugas sebenarnya. Laporan JSON hanya membuktikan bahwa antrean, worker, pencatatan run, event, serta penyimpanan artefak bekerja. Integrasi provider AI ada di M3.

## Jika ada error

- `Worker offline`: pastikan proses `worker` muncul di terminal `npm.cmd run dev`.
- Redis tidak tersedia: pastikan Docker Desktop hidup, lalu `docker compose ps`; pastikan `.env` menggunakan `REDIS_URL=redis://127.0.0.1:6379`.
- `npm` diblokir PowerShell: gunakan `npm.cmd`, bukan `npm`.
- Build gagal: jangan hapus database atau mengulang seeder. Simpan error lengkap untuk diagnosis.
