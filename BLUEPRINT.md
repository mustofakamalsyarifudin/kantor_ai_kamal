# KantorAI — Blueprint Pengembangan Produk

**Status:** Rancangan teknis awal untuk mengubah prototipe UI menjadi aplikasi multi-agent AI dengan kantor virtual 3D.

## 1. Visi produk

KantorAI adalah aplikasi single-workspace terlebih dahulu, yang menggabungkan:

1. Dunia kantor 3D yang dapat dilihat dari sudut pandang isometrik/atas.
2. Karakter agent dengan animasi idle, berjalan, duduk, mengetik, berdiskusi, dan istirahat.
3. Manager AI yang mengurai instruksi menjadi tugas dan mendelegasikannya ke spesialis.
4. Backend agent yang benar-benar menjalankan tugas melalui model AI dan tools yang diizinkan.
5. Papan tugas, artefak hasil kerja, riwayat run, persetujuan manusia, serta pembatas biaya dan akses.

Prinsip penting: kantor 3D adalah visualisasi kondisi sistem. Gerakan santai boleh disimulasikan; status kerja, hasil, progres, error, dan approval harus berasal dari backend sungguhan.

## 2. Stack teknis yang direkomendasikan

| Lapisan | Teknologi | Tanggung jawab |
|---|---|---|
| Frontend/dashboard | React + TypeScript + Vite | Halaman kantor, manajemen agent, tugas, pengaturan, hasil kerja |
| Mesin grafis | Three.js | Scene 3D, kamera, lampu, material, model karakter, animasi |
| Aset karakter | Model GLB/glTF dengan skeletal animation | Animasi idle/walk/sit/type/chat; aset harus memiliki lisensi yang sesuai |
| Navigasi agent | Grid/nav graph + A* pathfinding awal | Menjaga karakter berjalan di lorong yang dapat dilalui dan tidak menembus furnitur/dinding |
| API backend | Node.js + TypeScript + Fastify | REST API, autentikasi, validasi, task lifecycle, agent configuration |
| Realtime | Socket.IO | Mengirim perubahan status, room/target tujuan, progress, approval, dan notifikasi ke browser |
| Orkestrasi AI | OpenAI Agents SDK (TypeScript) melalui adapter provider | Manager, delegasi ke spesialis, tool calling, guardrails, tracing |
| Background queue | Redis + BullMQ | Menjalankan tugas lama secara asynchronous, retries, concurrency, timeout |
| Database | PostgreSQL | Agent, tugas, hasil, riwayat run, konfigurasi, audit, approval |
| Penyimpanan artefak | Folder lokal untuk development; object storage kompatibel S3 saat deployment | File hasil generasi agent, upload, log yang perlu disimpan |
| Isolasi programmer agent | Container/sandbox terpisah | Menjalankan kode uji tanpa akses bebas ke host, secrets, atau data yang tidak diizinkan |

Dokumentasi rujukan: [Three.js](https://threejs.org/docs/), [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk), [Socket.IO rooms](https://socket.io/docs/v4/rooms/), dan [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/).

## 3. Arsitektur logis

```text
Pengguna
   │ instruksi natural language
   ▼
Web App (React + Three.js)
   │ REST: buat tugas/configuration
   │ Socket.IO: perubahan keadaan real-time
   ▼
API Backend (Fastify)
   ├── Auth & workspace access
   ├── Task service + approval policy
   ├── Agent registry & provider adapter
   ├── Artifact service
   └── Audit / budget / rate limits
           │
           ▼
       Redis Queue ─────────────── PostgreSQL
           │                        data persisten
           ▼
       Agent Worker
           │
           ├── Manager AI: rencana + delegasi
           ├── Analyst / Research AI
           ├── Programmer AI dalam sandbox
           ├── Finance AI
           └── Creative / Video AI
           │
           ▼
       Tool adapters + hasil/artefak
           │
           ▼
       Review / approval manusia
           │
           ▼
       Final result + event update ke kantor 3D
```

Backend tidak perlu mengirim posisi karakter setiap frame. Backend mengirim perubahan semantik, misalnya `agent.state = working` dan `agent.target = engineering`; frontend menghitung jalur dan menghaluskan animasi lokal. Ini mengurangi traffic serta memisahkan simulasi visual dari logika AI.

## 4. Struktur agent awal

| Agent | Mandat | Tools awal | Batasan |
|---|---|---|---|
| Nara — Operations Manager | Memahami tujuan, menyusun rencana dan dependency, menetapkan agent, mengumpulkan hasil | Task planner, status tugas, ringkasan hasil | Tidak boleh mengklaim tugas selesai jika belum ada hasil backend; tidak menjalankan tindakan berisiko tanpa izin |
| Bima — Data & Business Analyst | Mengolah tabel/spreadsheet, analisis, visualisasi dan laporan | File reader, spreadsheet tools, kalkulasi, output file | Angka harus dapat ditelusuri ke sumber; jangan mengarang data yang tidak tersedia |
| Raka — Research & QA | Riset, verifikasi sumber, menguji keluaran dan melaporkan keterbatasan | Search/browser adapter, file reader, reviewer | Cantumkan sumber dan bedakan fakta dengan asumsi |
| Sinta — Finance & Accounting | Rekap, kategorisasi, anggaran, rekonsiliasi awal | Spreadsheet, calculator, file reader | Tidak melakukan pembayaran/pencatatan final tanpa approval |
| Dika — Video Producer | Naskah, storyboard, shot list dan prompt video | File/artifact tools; video provider ditambahkan setelah konfigurasi | Tidak mengklaim video selesai sebelum file benar-benar ada |
| Maya — Copywriter & Social Media | Copy, caption, konten dan kalender editorial | Document/artifact tools | Publikasi eksternal harus lewat persetujuan manusia |
| Programmer AI | Menulis, menguji dan memperbaiki kode di workspace terisolasi | Sandbox, file workspace, test runner, git diff | Tidak punya akses host bebas, production credentials, deployment, atau tindakan destruktif secara default |

Agent tambahan dibuat melalui registry/konfigurasi, bukan dengan menambah kondisi khusus di kode kantor. Setiap agent memiliki id stabil, nama, peran, instruksi, provider/model, daftar tools, batas biaya, department, dan titik kerja.

## 5. Status tugas dan run

Status tugas yang disepakati:

`DRAFT → QUEUED → PLANNING → RUNNING → REVIEW_REQUIRED → COMPLETED`

Status alternatif: `PAUSED`, `FAILED`, `CANCELLED`, dan `BLOCKED`.

Status eksekusi agent dipisahkan dari status tugas:

`IDLE`, `THINKING`, `WORKING`, `USING_TOOL`, `WAITING_APPROVAL`, `COMPLETED`, `ERROR`.

Transisi penting harus dicatat dengan timestamp. Status `COMPLETED` hanya boleh ditetapkan bila run sukses dan artefak/output yang diwajibkan sudah tersimpan.

## 6. Model data awal

Tabel inti yang disarankan:

- `users`: akun, status, waktu dibuat.
- `workspaces`: workspace dan pemilik.
- `workspace_members`: role dan hak akses bila kolaborasi ditambahkan.
- `departments`: daftar zona/area kantor.
- `agents`: nama, role, department, prompt, provider/model, tools yang diizinkan, state.
- `tasks`: instruksi, prioritas, status, assigned agent, parent task, deadline.
- `task_dependencies`: hubungan prasyarat antar-subtask.
- `agent_runs`: input, status run, model, biaya/token bila tersedia, output, error, timestamps.
- `run_events`: event langkah/tool/progress untuk audit dan debugging.
- `artifacts`: nama file, MIME type, storage key, ukuran, task/run, status review.
- `approvals`: jenis tindakan, payload, status, approver, timestamp.
- `memory_entries`: catatan/memori terkurasi dengan scope dan asal-usul.
- `tool_connections`: metadata koneksi; secret tidak disimpan plaintext.
- `audit_logs`: tindakan pengguna dan agent yang sensitif.

Gunakan migrations, foreign keys, indeks untuk task status/created time, soft-delete hanya bila ada kebutuhan bisnis yang jelas, dan backup berkala.

## 7. Event realtime untuk visual kantor

Event minimum:

- `task.created`, `task.queued`, `task.progress`, `task.review_required`, `task.completed`, `task.failed`.
- `agent.state_changed` — idle/thinking/working/using-tool/waiting-approval/error.
- `agent.destination_changed` — room/desk tujuan, bukan posisi tiap frame.
- `agent.message` — handoff/ringkasan lintas agent yang aman ditampilkan.
- `artifact.created` — file hasil baru tersedia.
- `approval.required`, `approval.resolved`.

Frontend memetakan event ke animasi: idle→wandering, queued→manager dispatch, working→jalan ke workstation lalu animasi mengetik, review-required→jalan ke meeting/review point, completed→menampilkan indikator hasil, blocked/error→indikator perlu perhatian.

## 8. Kebijakan keamanan dari awal

1. API keys provider hanya berada di backend/secrets manager, tidak pernah di JavaScript browser.
2. Programmer agent berjalan di container terpisah dengan batas CPU/memori/waktu, workspace terbatas, dan egress jaringan dinonaktifkan atau di-allowlist.
3. Persetujuan manusia diperlukan untuk tindakan yang memengaruhi pihak luar atau data penting: mengirim email, mempublikasikan konten, menghapus data, deploy, menjalankan pembayaran, atau mengeksekusi perintah berisiko.
4. Berikan setiap agent hanya tools minimum sesuai peran (*least privilege*).
5. Tetapkan max steps, timeout, retry cap, concurrency cap, batas pemakaian model dan anggaran per run.
6. Pisahkan memori percakapan sementara dengan memori jangka panjang yang disimpan secara terkurasi; simpan sumber/asal-usul fakta.
7. Log tool calls dan hasil penting tanpa menyimpan secret ke log.
8. Setiap tindakan tulis/destruktif memerlukan idempotency key atau perlindungan duplikasi yang sesuai.

## 9. Rencana milestone

### M0 — Fondasi proyek
- Buat repository terpisah dari HTML prototype.
- Tetapkan struktur monorepo dan aturan format/lint/test.
- Buat `.env.example` tanpa secret.
- Siapkan PostgreSQL migrations, backend health endpoint, dan autentikasi admin.
- Buat registry agent serta CRUD agent persisten.

**Lulus jika:** backend berjalan lokal, database terhubung, agent baru tetap ada setelah reload, dan konfigurasi rahasia tidak terekspos.

### M1 — Dunia kantor 3D
- Scene 3D isometrik dengan kamera orbit terbatas/zoom.
- Lantai, dinding, pintu, jendela, meja kecil, kursi, komputer, pantry, meeting room, engineering bay, creative studio dan area tambahan.
- GLB character dengan idle/walk; state animasi lain menyusul.
- Collision map/pathfinding agar karakter tidak melewati meja, dinding, atau koridor tertutup.
- Peta data-driven agar penambahan departemen tidak perlu mengubah engine.

**Lulus jika:** karakter bisa berjalan antara workstation/ruang melalui jalur valid; layout tetap rapi pada zoom dan ukuran layar berbeda.

### M2 — Task Execution Engine (kode awal tersedia; dry-run diagnostik)
- Redis/BullMQ queue dan worker terpisah dengan heartbeat serta batas concurrency.
- Task run lifecycle, progress events, retry, pause, resume, cancel, dan error handling.
- Run/event/artifact/audit tersimpan di PostgreSQL dan dikirim realtime melalui Redis Pub/Sub + Socket.IO.
- UI papan tugas menampilkan status worker, ringkasan queue, riwayat run, dan unduhan artefak diagnostik.
- Executor M2 hanya `dry-run`; tidak memanggil model AI atau mengeksekusi instruksi task.

**Lulus pengujian lokal jika:** task yang dimasukkan antrean berpindah QUEUED → RUNNING → REVIEW_REQUIRED, terbentuk AgentRun dan progress events, laporan `M2-dry-run-report.json` dapat diunduh, serta event tetap terlihat setelah refresh. Pengujian build dan eksekusi end-to-end dilakukan pada komputer pengembang setelah dependency terpasang.

### M3 — AI sungguhan pertama
- Integrasikan provider/model di backend.
- Bangun Nara untuk membuat rencana terstruktur dan memilih spesialis.
- Jalankan satu spesialis sungguhan sampai menghasilkan artefak yang dapat diunduh.
- Tambahkan tracing, limit penggunaan, dan approval gate.

**Lulus jika:** satu instruksi menghasilkan run nyata, langkah kerja dapat ditinjau, dan sistem tidak menggunakan status sukses palsu.

### M4 — Multi-agent dan tools
- Handoff manager ke analyst/research/copywriter/finance.
- Dependency antar-subtask, review/QA, penggabungan hasil.
- File upload/download dan artifact viewer.
- Programmer agent dalam sandbox terisolasi; tambahkan tools lain bertahap.

### M5 — Produksi
- HTTPS, konfigurasi deployment, worker process terpisah, database backup, monitoring, rotasi secret, rate limiting, audit, dan pemulihan kegagalan.
- Uji akses, sandbox, beban, browser berbeda dan ukuran layar.
- Dokumentasi operasional serta prosedur backup/restore.

## 10. Kriteria MVP yang benar-benar berfungsi

MVP tidak dianggap selesai hanya karena karakter bergerak. MVP harus memenuhi semua hal ini:

- Pengguna dapat membuat, mengedit, menonaktifkan, dan mengatur agent.
- Agent tetap tersimpan setelah browser ditutup/dibuka kembali.
- Pengguna memasukkan satu instruksi; Nara membuat task/subtask yang terlihat.
- Setidaknya satu spesialis memakai model AI sungguhan dan menghasilkan output/artefak.
- Progres, error, approval dan completion berasal dari backend, bukan angka/animasi dummy.
- Agent yang bekerja berpindah ke area kerja yang benar menggunakan pathfinding.
- Pengguna dapat meninjau output dan menyetujui hasil sebelum tindakan eksternal.
- Riwayat run, error, artefak, penggunaan dan tindakan penting dapat diperiksa.
- Secret tidak muncul di browser atau repository.

## 11. Asumsi implementasi awal

- Mulai sebagai aplikasi single-user/single-workspace untuk mengurangi kompleksitas; arsitektur tetap menyediakan workspace id agar bisa diperluas.
- Kembangkan dan uji secara lokal terlebih dahulu; deployment publik dilakukan setelah keamanan dan worker stabil.
- Prototype HTML yang ada berfungsi sebagai referensi visual dan daftar interaksi, bukan backend produksi.
- Tidak mengaktifkan tindakan eksternal atau eksekusi kode bebas sampai permission/approval dan sandbox tersedia.
- Belum menetapkan biaya operasional: perlu diputuskan provider/model, volume penggunaan, dan layanan video sebelum dapat membuat estimasi yang dapat dipertanggungjawabkan.
