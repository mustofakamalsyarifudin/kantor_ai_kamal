KANTORAI M4.1 — AGENT COLLABORATION & FINAL REVIEW
=================================================

Tujuan
------
M4.1 memperbaiki alur kolaborasi setelah rencana Manager AI diluncurkan:
1. Subtugas pertama (riset/analisis) masuk antrean lebih dulu.
2. Setelah pemilik menyetujui subtugas pertama sebagai selesai, artefak Markdown-nya diteruskan ke subtugas berikutnya sebagai konteks.
3. Subtugas lanjutan lalu masuk antrean; dua tugas lanjutan dapat berjalan paralel.
4. Setelah semua subtugas selesai dan disetujui pemilik, Nara dapat menyusun dokumen sintesis final dari artefak yang tersimpan.
5. Dokumen final disimpan sebagai artefak tugas induk dan dapat diunduh. Tidak ada publikasi otomatis.

PENTING
-------
- Patch tidak mengganti .env, API key, schema Prisma, atau database.
- Patch membuat cadangan .m41-backup-* untuk file source yang diubah.
- Build lengkap belum bisa diverifikasi di komputer lokal pengguna; wajib jalankan build setelah patch.
- Final review memanggil OpenAI satu kali untuk setiap paket final yang belum memiliki review tersimpan; dapat menggunakan kredit API.
- Patch tidak menghapus task duplikat atau task lama.
- Mekanisme penerusan konteks berlaku untuk rencana M4.1 baru. Untuk subtugas lama yang sudah diproses, hasil tersimpan dapat digunakan untuk final review setelah semuanya disetujui selesai.

CARA PASANG
-----------
1. Hentikan KantorAI pada terminal yang menjalankan npm.cmd run dev dengan Ctrl+C.
2. Ekstrak isi ZIP ini ke folder root proyek:
   D:\KantorAI_kamal
   Pastikan lokasi skrip menjadi:
   D:\KantorAI_kamal\tools\patch-manager-collaboration.cjs

3. Buka PowerShell dan jalankan:
   cd D:\KantorAI_kamal
   node .\tools\patch-manager-collaboration.cjs

4. Pastikan muncul pesan:
   [M4.1] Kolaborasi dan final review berhasil dipasang.

   Jika skrip mengatakan pola tidak dikenali atau file tidak cocok, HENTIKAN proses.
   Jangan memaksa patch atau mengedit endpoint secara manual. Salin pesan lengkapnya
   untuk pemeriksaan, sebab patch harus sesuai dengan source aktual proyek.

5. Build:
   npm.cmd run build

6. Jika build berhasil, nyalakan kembali:
   npm.cmd run dev

UJI WORKFLOW M4.1
-----------------
A. Rencana baru:
   - Pada halaman Manager AI, buat rencana baru.
   - Urutkan subtugas riset/analisis yang menjadi sumber konteks sebagai subtugas nomor 1.
   - Tinjau agent, instruksi, prioritas, lalu luncurkan sekali.
   - Hanya subtugas pertama yang masuk antrean saat peluncuran.
   - Tunggu subtugas pertama menghasilkan artefak Markdown; buka Papan Tugas dan tekan
     “Setujui selesai”. Backend lalu meneruskan isi artefak ke subtugas lanjutan dan
     memasukkannya ke antrean. Pastikan status/riwayatnya tercatat.
   - Jalankan dan setujui subtugas lainnya.

B. Final review:
   - Semua subtugas di bawah tugas induk harus berstatus COMPLETED (telah disetujui).
   - Buka menu Manager AI. Pada panel “Kolaborasi & review final”, klik
     “Susun paket final dengan Nara”.
   - Konfirmasi dialog. Nara akan membaca artefak Markdown dari setiap subtugas dan
     menyusun satu dokumen sintesis final pada tugas induk.
   - Unduh “Review final” untuk memeriksa hasilnya. Tidak ada publikasi otomatis.

CATATAN SUMBER TUGAS LAMA
------------------------
Jika sudah ada tugas Bima/Maya/Dika dari pengujian sebelumnya, jangan jalankan ulang hanya
untuk membuat ulang artefak. Review final dapat memakai artefak lama hanya jika tugas-tugas
tersebut memang tersimpan sebagai subtugas (parentTaskId) dari tugas induk Manager AI yang
sama. Tugas independen yang tidak memiliki relasi induk tidak otomatis digabung oleh panel.
Penerusan konteks berantai berlaku untuk rencana baru; hasil tugas lama yang sudah dieksekusi
tidak otomatis dijalankan ulang atau diberi konteks baru.

Jika build gagal, salin error lengkap dari terminal. Jangan menghapus database, volume
Docker, .env, atau folder node_modules sebagai langkah pertama.
