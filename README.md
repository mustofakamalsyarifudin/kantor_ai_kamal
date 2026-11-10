# KantorAI — Foundation M2

KantorAI adalah fondasi workspace multi-agent dengan registry agent persisten, PostgreSQL, autentikasi lokal, scene kantor 3D, dan **Task Execution Engine berbasis Redis/BullMQ**.

## Status M2 dan batasan yang penting

M2 menambahkan antrean task, worker terpisah, heartbeat, siklus AgentRun, progress event, event realtime, penyimpanan artefak, dan kontrol pause/resume/cancel/retry. Konfigurasi default `TASK_EXECUTOR_MODE=dry-run` dengan sengaja **tidak memanggil provider AI dan tidak menjalankan instruksi task**. Worker membuat file `M2-dry-run-report.json` untuk membuktikan alur antrean dan pencatatan berjalan. Task dry-run berakhir pada status `REVIEW_REQUIRED`, bukan `COMPLETED`, agar laporan diagnostik tidak disangka sebagai hasil kerja AI. Integrasi provider AI ada pada milestone M3.

## Persyaratan

- Node.js 22 atau lebih baru.
- Docker Desktop dengan WSL 2 aktif di Windows, atau Docker Engine dengan Compose.
- npm dan akses lokal ke port 4000, 5173, 5432, dan 6379.

## Upgrade dari M0 yang sudah berjalan (disarankan untuk workspace yang telah memiliki data)

1. Hentikan aplikasi yang sedang berjalan dengan `Ctrl+C` pada terminal `npm run dev`. **Jangan jalankan `docker compose down -v`** karena opsi `-v` menghapus volume database.
2. Buat cadangan folder proyek. ZIP M2 overlay tidak menyertakan `.env`, `node_modules`, atau data artefak.
3. Ekstrak berkas ZIP M2 langsung ke folder proyek yang sama (contoh `D:\KantorAI_kamal`) dan izinkan file kode yang sama ditimpa. Jangan menghapus `.env`. Volume PostgreSQL/Redis dan data agent/task tetap digunakan.
4. Buka `.env`. Biarkan `DB_PASSWORD` dan `DATABASE_URL` yang sudah terhubung ke PostgreSQL tetap sama. Pastikan origin frontend mengikuti alamat browser (`http://127.0.0.1:5173`), lalu ubah `REDIS_URL` dan tambahkan konfigurasi M2 berikut bila belum tersedia (jangan membuat duplikat key):

   ```dotenv
   REDIS_URL=redis://127.0.0.1:6379
   TASK_EXECUTOR_MODE=dry-run
   TASK_WORKER_CONCURRENCY=2
   ARTIFACTS_DIR=./data/artifacts
   ```

   Pertahankan `VITE_API_URL=http://127.0.0.1:4000` pada instalasi lokal ini. Jangan bagikan file `.env`.
5. Di PowerShell dari folder proyek, jalankan:

   ```powershell
   npm.cmd install
   npm.cmd run db:generate
   npm.cmd run build
   ```

   Tidak ada perubahan skema Prisma pada M2, jadi untuk upgrade workspace M0 yang sudah termigrasi **jangan menjalankan migrasi init dan jangan menjalankan seeder ulang**. Bila `npm install` melaporkan bahwa lifecycle script Prisma belum diizinkan, tinjau daftar skrip dengan `npm.cmd install-scripts ls`, lalu izinkan hanya paket yang memang berasal dari dependency proyek.
6. Jika build berhasil, jalankan `npm.cmd run dev`. Perintah ini menjalankan API, task worker, dan web secara bersamaan. Pertahankan jendela terminal tetap terbuka.
7. Buka `http://127.0.0.1:5173` dan login memakai akun workspace yang sudah ada.

## Instalasi baru di Windows

Untuk workspace baru, siapkan `.env` berdasarkan `.env.example` dan ubah semua `CHANGE_ME`. Selanjutnya jalankan `docker compose up -d`, `npm.cmd install`, `npm.cmd run db:generate`, `npm.cmd run db:migrate -w @kantorai/api -- --name init`, `npm.cmd run db:seed`, kemudian `npm.cmd run dev`. File `run-local-windows.bat` juga melakukan urutan instalasi tersebut. Jangan gunakan ulang urutan instalasi baru untuk upgrade workspace yang sudah memiliki database; gunakan petunjuk upgrade M0 di atas.

## Endpoint penting

Semua `/api/*` memerlukan Bearer token dari `POST /api/auth/login`.

- `GET /health` — health API dan database.
- `GET /api/queue/status` — status Redis, worker heartbeat, dan hitungan antrean.
- `GET /api/tasks` / `POST /api/tasks` — registry task. `submitNow=true` membuat task dan mencoba memasukkannya ke antrean.
- `POST /api/tasks/:id/queue` — masukkan draft ke antrean.
- `POST /api/tasks/:id/pause` / `resume` / `cancel` / `retry` — kontrol task. Retry untuk status review hanya diizinkan untuk hasil dry-run diagnostik.
- `GET /api/tasks/:id/runs` — riwayat eksekusi agent, events, artefak.
- `GET /api/tasks/:id/events` dan `GET /api/events` — trace event persisten.
- `GET /api/artifacts/:id/download` — unduh artefak dari penyimpanan lokal.

## Alur uji M2

1. Buka Papan Tugas dan buat tugas uji. Pilih agent aktif dan centang `Masukkan ke antrian`.
2. Pastikan kartu tugas bergerak dari `QUEUED` ke `RUNNING`, kemudian ke `REVIEW_REQUIRED`. Proses dry-run biasanya berlangsung sekitar satu hingga dua detik.
3. Buka `Run & artefak`, periksa run, progress event, dan unduh `M2-dry-run-report.json`.
4. Buka `Riwayat & event`; event `run.started`, `run.progress`, `run.succeeded`, dan `task.review_required` harus tersimpan.
5. Pastikan bagian Pengaturan menunjukkan Redis tersambung dan worker online.

Jika antrean tidak diproses, buka `http://127.0.0.1:4000/health`, lihat `/api/queue/status` setelah login, dan periksa terminal untuk log worker. Jangan tandai dry-run sebagai hasil kerja final.

## Status dan keamanan

- Agent/task/run/event/artefak disimpan di PostgreSQL. File artefak diagnostik berada di `data/artifacts/`.
- Worker hanya menjalankan mode `dry-run`; model AI tidak dipanggil. Jangan mengubah `TASK_EXECUTOR_MODE` ke nilai lain karena belum ada executor non-dry-run.
- Jangan mengekspos API ke internet. Rate limit, pengelolaan sesi, backup/restore produksi, provider AI, approvals, dan sandbox eksekusi kode masih perlu disiapkan.
- API key dan kredensial harus berada di backend/`.env`, tidak di frontend. Jangan commit `.env`.

## Roadmap

- M0 — registry agent/task, autentikasi lokal, PostgreSQL, event dasar dan scene 3D awal.
- M1 — peningkatan visual kantor, aset karakter, collision dan pathfinding.
- M2 — task worker, antrean BullMQ, lifecycle run, kontrol pause/resume/cancel/retry, events serta artefak dry-run.
- M3 — provider AI sungguhan dan manager agent.
- M4 — delegasi multi-agent, tools, review, dan sandbox programmer.
- M5 — hardening keamanan, observability, backup/restore, dan deployment.
