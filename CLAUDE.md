# 2w_collection_termination_calculator

> **STATUS: DRAF** — disusun dari catatan diskusi s.d. Nov 2026, belum direview user.
> Kalau isi catatan berbeda dengan kode, **kode yang berlaku**. Perbaiki file ini sambil jalan.

Web app **kalkulator pelunasan (prepayment/termination)** untuk **agency eksternal** mengecek jumlah
pelunasan customer motorcycle collection yang mereka tangani. Terdiri dari `Code.js` dan `Index.html`.

---

## Tugas Claude di sesi pertama

1. Pelajari kode, lalu isi bagian **Peta kode**.
2. Tandai di **Selisih catatan vs kode** setiap hal di file ini yang tidak sesuai kode.
3. Jangan ubah kode dan jangan jalankan `clasp` untuk tugas ini.

## Aturan kerja untuk Claude

- Jelaskan ke user dalam Bahasa Indonesia, sederhana; hindari penjelasan yang penuh nama fungsi.
- Nama file dan fungsi dalam kode: **bahasa Inggris**.
- Fungsi yang dijalankan manual dari dropdown Apps Script: tidak diakhiri `_`, **tanpa parameter**.
- Instruksi ke user step-by-step: file/fungsi mana, ID spreadsheet mana (dan asalnya).
- **Selalu pakai `SPREADSHEET_DATA_ID` = `1EMeyYi5Dw95u-ybPVgXC4-96E6ovQ5kruWTDjuO6z-4`**
  (Calculator_Feed) setiap `Code.js` diubah.
- **Jangan `clasp push` tanpa persetujuan user.** `/exec` berubah hanya setelah New version di Deploy.
- Link dibagikan ke pihak eksternal: data seminimal mungkin, jangan tampilkan data di luar kebutuhan.
- Bila balasan berisi pertanyaan untuk user, ulangi daftar pertanyaannya di akhir balasan.
- Tampilan mengikuti tema "Motorcycle Collection Report Dashboard"; font Century Gothic, Helvetica
  Neue, Arial.

## Alur & fitur

- Login per agency (kredensial berbeda per agency, untuk tracking akses).
- Input nomor kontrak (PPK) + tombol Calculate → rincian nominal pelunasan.
- Rincian menampilkan **tanggal inquiry** dan **tanggal rencana pembayaran** (memengaruhi bunga
  berjalan dan denda).
- Ekspor rincian: screenshot area rincian (JPEG/PDF) dan Excel, dua opsi terpisah.

## Sumber data

- Data dari file aging harian, disalin ke spreadsheet **Calculator_Feed** oleh generator di
  `2w_collection_daily_report/generator` (file `calculator_feed.js`), diisi di job pagi dan job per jam
  (Data Skala Rental Payment) agar selalu terbaru.
  Catatan Nov 2026: sambungan feed ke job pagi/per jam **hilang karena penimpaan kode ±5 Nov**
  (bukan belum pernah dipasang) — lihat Pekerjaan terbuka butir 1.
- Kolom: ppk, nama_customer, branch, outstanding_balance, tenor, counter, interest_effective,
  tanggal_jatuh_tempo, bunga, denda_tertunggak, denda, penalties, rental, drawdown_date.
- Di file Data Skala Rental Payment, kolom counter = nomor angsuran yang dibayar.

## Rumus

- Komponen: pokok hutang, bunga berjalan, denda, pinalti. Semua kalkulasi disesuaikan dengan hasil
  **Termination Confirm** sistem.
- OSP dan interest_effective langsung dari aging. Due date terakhir terbayar = EDATE(tanggal_jatuh_tempo, −1).
  Sisa angsuran × rental = (tenor − counter + 1) × rental.
- **Denda** = `denda_tertunggak` (denda historis; kolom `denda` tidak dipakai) + denda berjalan.
  Denda berjalan dihitung per angsuran yang sudah lewat jatuh tempo, maksimal sebanyak sisa tenor;
  rate per hari × rental: **REFI 0,5%**, **NMC 0,2%**.
- NMC = kontrak awalan "9" dengan drawdown < 1 Sep 2026. REFI = awalan bukan "9" dengan drawdown
  < 1 Sep 2026, atau semua kontrak drawdown > 1 Sep 2026.
- **Pinalti** = 10% dari sisa pokok (OSP).
- Rental Remain: data belum tersedia; komponen tetap disertakan, tapi kalkulator tidak boleh gagal
  bila datanya kosong.
- Discount AR dari sistem bisa bernilai negatif.

## Pekerjaan terbuka

1. **Data kalkulator berhenti di aging 4 Nov + payment 5 Nov 2026** (dicek 18 Nov 2026). Penyebab: kode
   generator (project daily_report, Apps Script *Generate_Data_Daily*) tertimpa versi lama ±5 Nov, sehingga
   3 sambungan ke Calculator_Feed hilang (tulis Base di job pagi, tulis Overlay di job per jam, field
   `interest_effective` + `denda_tertunggak` di pengolahan aging). Kode kalkulator sendiri tidak bermasalah.
   - Perbaikan dikerjakan **di sesi project daily_report**: butir 2 dan 3 "pemulihan kode yang tertimpa"
     (lihat `notes/recovery_2026-11.md` di sana), lalu `calcFeedBackfillManual` sekali.
   - **Jangan jalankan `calcFeedBackfillManual` sebelum sambungan dipulihkan**: bunga efektif dan denda
     tertunggak akan tertulis kosong, dan kalkulator membaca kosong sebagai 0 (bunga berjalan & denda
     historis jadi 0, hasil salah tanpa error). Lebih aman tetap memakai data lama sementara.
   - Setelah pulih: cek di kalkulator keterangan data menunjukkan aging kemarin + jam payment terbaru.
2. **Perubahan domain kantor `simasfinance.co.id` → `simasfin.id`** (dicek 24 Nov 2026). Kode tidak
   memeriksa domain email; login agency = username/password di sheet Auth. Akun hanya berganti nama
   (pemilik spreadsheet Auth & Calculator_Feed = akun yang sama, kini tampil @simasfin.id) → file,
   script, dan izin berbagi ikut aman.
   - Deployment live (dicek user 24 Nov): "Execute as: User accessing", "Who has access: Anyone with
     Google account". Akibatnya hanya akun yang diberi akses edit ke kedua spreadsheet (pemilik + 3 user
     internal) yang bisa memakai web app; agency eksternal tidak.
   - **Keputusan:** ganti ke "Execute as: Me" (`executeAs: USER_DEPLOYING` di `appsscript.json`, sudah
     diubah di repo 24 Nov, **belum diterapkan di Apps Script**). User mengubahnya lewat Deploy →
     Manage deployments → Edit → Execute as: Me → New version (link `/exec` tetap).
   - Konsekuensi "Me": app berjalan atas akun pemilik; kalau akun itu dinonaktifkan, app berhenti.

## Peta kode

_(Diisi Claude Code dari kode aktual.)_

## Selisih catatan vs kode

_(Diisi Claude Code.)_
