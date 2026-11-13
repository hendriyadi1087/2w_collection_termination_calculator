# Web apps kalkulator pelunasan dengan Apps Script

- **Chat:** "Web apps kalkulator pelunasan dengan Apps Script" (claude.ai, uuid `7e64f29f-afba-43f5-92a6-312bfd1d208d`)
- **Tanggal:** 22 Sep 2026 – 23 Sep 2026
- **Project:** 2w_collection_termination_calculator (dulu disebut *Prepayment Calculator* / `prepayment_calc`)
- **Sumber ringkasan:** ekspor chat Claude 13 Nov 2026. Kalau berbeda dengan kode di repo, kode yang berlaku.

## Tujuan
Web app Apps Script untuk agency eksternal mengecek jumlah pelunasan kontrak yang mereka pegang. Data diambil dari file aging, tetapi beberapa komponen dihitung ulang manual karena isi kolom di aging kurang tepat.

## Keputusan
- **Login:** kredensial berbeda per agency, supaya akses bisa dilacak dan dicabut per agency. Password disimpan dalam bentuk hash (`Utilities.computeDigest`), login diproses di server.
- **Sesi:** setelah login, server membuat session token acak (disimpan di Cache). Fungsi admin menolak panggilan tanpa sesi valid.
- **Data referensi:** rencananya sinkron otomatis dari file aging, meniru pola `Sync_Data_Aging.gs` / `Generate_Daily_Data.gs`. Sementara diisi manual.
- **Kolom dari aging:** `ppk`, `nama_customer`, `branch`, `outstanding_balance`, `tenor`, `counter`, `interest_effective`, `tanggal_jatuh_tempo`, `bunga`, `denda_tertunggak`, `denda`, `penalties`, ditambah `rental` dan `drawdown_date`.
- **Komponen pelunasan:** pokok hutang, bunga berjalan, denda, pinalti. Tiap komponen punya fungsi sendiri supaya rumus mudah diganti:
  - `hitungPokok_()`, `hitungDenda_()`, `hitungPinalti_()`, `hitungBungaBerjalan_()`. Orkestratornya `hitungPelunasan`.
  - Angka rate (0,2%, 10%, dst.) dikumpulkan di objek `RUMUS` di atas `Code.gs`.
- **Rumus denda (NMC = kontrak berawalan "9", REFI = selain itu):** 0,2% × rental × hari telat, **dihitung per angsuran** yang sudah lewat jatuh tempo sampai tanggal rencana bayar.
  - Jumlah angsuran overdue dihitung iteratif per due date (EDATE dari `tanggal_jatuh_tempo`), bukan selisih bulan kalender. Contoh: JT 5 Jul, rencana bayar 7 Agu → 2 angsuran; rencana bayar 1 Agu → 1 angsuran.
  - Total denda = denda berjalan + `os_denda` historis (dari sheet Data_Denda_Historis, 0 kalau tidak ada).
- **Export rincian:** dua tombol terpisah, gambar/PDF (`html2canvas` + `jsPDF`) dan Excel (SheetJS), hanya area rincian.
- **Tema:** mengikuti web app "Simasfin Budget Submission" (dikirim sebagai `Prepayment_Calc.rar`).
- **Tampilan:** field Nomor Kontrak dan Tanggal Rencana Bayar disusun atas-bawah; format tanggal `dd - Mmm - yyyy` dengan singkatan bulan Indonesia (contoh 23 - Sep - 2026).
- **Deploy:** Execute as Me, akses Anyone. Update lewat *Manage deployments → Edit → New version*, bukan deployment baru.

## File / fungsi / ID
- File: `Code.gs`, `Index.html` (di repo sekarang `Code.js`, `Index.html`).
- Fungsi: `tambahAgencyManual()` (tambah agency dari editor), `hitungPelunasan`, `hitungPokok_`, `hitungDenda_`, `hitungPinalti_`, `hitungBungaBerjalan_`, objek `RUMUS`.
- Spreadsheet di Drive (folder `Motorcycle_Collection/Source/`):
  - Data_Calculator_Reference — `1S3f7T63v6sOM7Ldvj0CPsPmwZv0YqY5skm-wd8_b9oo`
  - Prepayment_Calculator_Auth (hash password, jangan diisi manual) — `16DIXpuCWxrUnF2eFnC7V27fcE6e6GFlel9rGkEPEgBM`
  - Data_Denda_Historis (kolom `ppk`, `os_denda`) — `1hCw1L_yoZ23wUSdxFGoWM9ppZsE3E1L1eOr6KzkfIrs`

## Selesai
- `Code.gs` + `Index.html` versi pertama: login, kalkulator, export, menu admin **Kelola User** (tambah user, reset/set password, hapus user).
- Perbaikan error `tambahAgencyManual` (`Cannot read properties of null (reading 'appendRow')`): kode sekarang selalu mengambil tab pertama spreadsheet, bukan nama "Sheet1".
- Tombol lihat/sembunyikan password di halaman login.
- Error `getDataRange` saat login dijelaskan sebagai deployment lama (perlu New version), bukan bug kode.

## Belum selesai (per akhir chat)
- Sinkron otomatis Data_Calculator_Reference dari file aging (masih manual).
- Data_Denda_Historis baru berisi header.
- Rumus pinalti dan bunga berjalan dikonfirmasi lebih lanjut di chat "Discount AR calculation analysis" (lihat `2026-10_discount-ar-calculation.md`).

## Keputusan lama yang dibatalkan
- Menambah agency lewat kode (`tambahAgencyManual`) diganti menu admin Kelola User di web app. Fungsi manual tetap ada untuk admin pertama.
- Membaca tab `Sheet1` berdasarkan nama diganti membaca tab pertama.
