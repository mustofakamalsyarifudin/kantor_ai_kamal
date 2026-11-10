# KantorAI M4.1 — Agent Collaboration & Final Review

Paket ini dibuat berdasarkan source bundle KantorAI yang diunggah. Paket hanya mengganti tiga file source dan tidak berisi `.env`, API key, database, `node_modules`, atau volume Docker.

## Isi paket

- `apps/api/src/server.ts`
  - Saat rencana diluncurkan, hanya subtugas 1 yang masuk antrean.
  - Subtugas 2 dan seterusnya tetap Draft dan tidak dapat diantrekan manual sebelum dependensinya terpenuhi.
  - Setelah subtugas 1 memiliki artefak Markdown yang dapat dibaca dan pengguna menyetujui tugas tersebut, isi artefak disisipkan sebagai konteks ke subtugas yang bergantung pada sequence 1; subtugas itu lalu dimasukkan ke antrean.
  - Menambahkan endpoint final review `POST /api/manager/tasks/:id/final-review`.
  - Nara menyusun paket final dari artefak aktual semua subtugas yang sudah berstatus `COMPLETED`.
  - Artefak final disimpan pada tugas induk dan permintaan ulang akan menggunakan artefak final yang ada tanpa pemanggilan OpenAI baru.
  - Tugas induk tidak otomatis diselesaikan: manusia harus memeriksa paket final dan menyetujuinya.
  - Perlindungan `launchKey` yang sudah ada dipertahankan.
- `apps/web/src/App.tsx`
  - Menampilkan daftar rencana Manager AI persisten, status subtugas dan informasi konteks.
  - Menambahkan tombol untuk meminta final review, melihat preview, mengunduh paket final, dan menyetujui paket final.
- `apps/web/src/lib/api.ts`
  - Menambahkan tipe respons workflow dan final review.

## Pemasangan

1. Hentikan KantorAI pada terminal pengembangan (`Ctrl+C`).
2. Cadangkan file berikut di luar folder `src`:
   - `apps/api/src/server.ts`
   - `apps/web/src/App.tsx`
   - `apps/web/src/lib/api.ts`
3. Ekstrak ZIP ini ke `D:\KantorAI_kamal` dan izinkan tiga file tersebut ditimpa.
4. Jalankan dari PowerShell:

   ```powershell
   cd D:\KantorAI_kamal
   npm.cmd run build
   ```

5. Jika build berhasil, jalankan:

   ```powershell
   npm.cmd run dev
   ```

6. Buka `http://127.0.0.1:5173` lalu masuk ke menu **Manager AI**.

## Uji workflow baru

1. Buat rencana dengan **subtugas 1 sebagai pekerjaan analisis/riset**. Untuk paket konten, tempatkan Bima pada tahap analisis sebagai subtugas pertama, Maya pada carousel, dan Dika pada video.
2. Tinjau dan luncurkan rencana satu kali. Hanya subtugas 1 yang seharusnya masuk antrean; subtugas berikutnya tetap Draft dengan catatan menunggu prasyarat.
3. Tunggu subtugas 1 menghasilkan artefak Markdown. Pada Papan Tugas, periksa hasilnya lalu klik **Setujui selesai**.
4. API akan menyisipkan artefak yang disetujui ke instruksi subtugas lanjutan, kemudian memasukkan subtugas tersebut ke antrean. Maya dan Dika dapat berjalan paralel setelah tahap pertama disetujui.
5. Setelah semua subtugas selesai dan disetujui, buka Manager AI. Klik **Susun paket final dengan Nara**.
6. Periksa preview dan unduh artefak. Setelah peninjauan manusia selesai, klik **Setujui paket final** untuk menandai tugas induk selesai.

Penyusunan rencana, eksekusi subtugas, dan final review memanggil OpenAI sesuai tahapnya dan dapat menggunakan kredit API. Final review tidak akan memanggil OpenAI ulang jika artefak final untuk tugas induk tersebut sudah tersimpan.

## Catatan

- Tidak ada perubahan skema Prisma atau migrasi database pada paket ini.
- Workflow dependensi baru berlaku pada rencana yang diluncurkan setelah pembaruan dipasang. Tugas lama tidak diubah secara retroaktif; final review dapat membaca artefak lama jika subtugas tersebut merupakan anak dari tugas induk Manager AI yang sama dan semuanya sudah selesai.
- Full build belum dapat dijalankan dalam lingkungan penyusunan paket karena unduhan paket npm mengalami kegagalan DNS (`EAI_AGAIN`). Sintaks TypeScript/TSX untuk ketiga file sudah diperiksa. Jalankan `npm.cmd run build` di komputer proyek sebelum mengandalkan pembaruan.
- Jika build gagal, jangan klik ulang peluncuran. Simpan pesan error lengkap dari terminal.
