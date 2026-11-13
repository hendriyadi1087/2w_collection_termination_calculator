# Discount AR calculation analysis

- **Chat:** "Discount AR calculation analysis" (claude.ai, uuid `bcf3c861-4828-45f6-a932-9ab813036f9a`)
- **Tanggal:** 20 Okt 2026 – 21 Okt 2026
- **Project:** 2w_collection_termination_calculator (Prepayment Calculator – Kalkulator Pelunasan). Sebagian juga mengubah `generator/` di 2w_collection_daily_report (lihat `2w_collection_daily_report/notes/2026-10_calculator-feed-untuk-kalkulator-pelunasan.md`).
- **Sumber ringkasan:** ekspor chat Claude 13 Nov 2026. Kalau berbeda dengan kode di repo, kode yang berlaku.

## Tujuan
Membongkar cara sistem (layar *Termination Confirm*) menghitung Discount AR dan angka pelunasan, lalu menyamakan rumus kalkulator web app dengan sistem sampai selisih Rp0. Setelah itu kalkulator dihubungkan ke data aging terbaru dan ditambah fitur batch.

## Rumus yang disepakati (cocok Rp0 dengan 3 contoh sistem)
- **Accrued Interest** = OS × `interest_effective`% ÷ 360 × jumlah hari sejak due date terakhir yang terbayar sampai tanggal terminasi/rencana bayar. Basis 360 hari. Tidak dibatasi walau lewat jatuh tempo akhir.
  - Due date terakhir yang terbayar = `EDATE(tanggal_jatuh_tempo, -1)` (bukan tanggal bayar).
- **Pinalti** = 10% × OS.
- **Debt Balance** (sisa angsuran × rental) = (`tenor` − `counter` + 1) × `rental`.
- **Discount AR** = Total AR − Debt Balance = (Accrued Interest − Unearned) + Pinalti + Rental Remain. **Boleh negatif**, jangan dibatasi.
- **Rental Remain:** datanya belum tersedia; kalkulator tetap menyiapkan field ini dan tidak gagal kalau kosong.
- **Denda:**
  - Total denda = **denda historis dari kolom `denda_tertunggak`** + denda berjalan. Kolom `denda` di aging **tidak dipakai**.
  - Denda berjalan dihitung per angsuran yang sudah lewat jatuh tempo, maksimal `tenor − counter + 1` angsuran (angsuran terakhir ikut kalau sudah lewat).
  - Rate per hari × rental: **REFI 0,5%**, **NMC 0,2%**.
  - **NMC** = ppk berawalan "9" **dan** drawdown < 1 Sep 2026. Selain itu REFI (termasuk semua kontrak drawdown ≥ 1 Sep 2026; drawdown tepat 1 Sep diperlakukan REFI).
  - Nomor kontrak untuk aturan ini = **`ppk`** (bukan kolom `no_kontrak`).
- Kontrak yang sudah lunas hari ini ditolak dengan pesan "sudah LUNAS".

## Keputusan lain
- Sumber data: aging harian (lewat spreadsheet `Calculator_Feed` yang diisi job pagi dan job per jam di `generator/`), bukan lagi sheet statis `Data_Calculator_Reference`.
- `SPREADSHEET_DATA_ID` di `code.gs` = `1EMeyYi5Dw95u-ybPVgXC4-96E6ovQ5kruWTDjuO6z-4` (spreadsheet Calculator_Feed). User minta ID ini selalu dipakai saat kode diubah.
- Tema dan tampilan mengikuti Motorcycle Collection Report Dashboard: background image, logo Simasfin kiri atas, judul "Prepayment Calculator - Kalkulator Pelunasan", subjudul "Sinarmas Multifinance", ikon SVG duotone seperti dashboard.
- Menu berupa **tab** di bawah header: Kalkulator, Batch Calc, History, Admin (khusus admin). Nama user + tombol Keluar di kanan atas.
- Tombol Simpan JPEG/PDF/Excel dipindah **di luar** kartu rincian supaya tidak ikut ter-capture; area capture memuat seluruh bingkai kartu.
- Disclaimer di hasil: angka adalah estimasi, angka resmi mengikuti perhitungan sistem, dan bisa berubah kalau tanggal pelunasan tidak sesuai rencana bayar.
- **Batch Calc** (dulu "Hitung Massal"): unggah template (`ppk`, `tanggal_rencana_bayar`), hasil berupa tabel rincian + export Excel. Nama file: `Template_Batch_Check_Pelunasan.xlsx`, `Hasil_Batch_Check_Pelunasan_YYYYMMDD_HHMM.xlsx`.
- **History:** 30 hari terakhir, dibagi per agency (admin lihat semua). Disimpan di sheet "History" pada spreadsheet Prepayment_Calculator_Auth, dibersihkan otomatis (simpan 31 hari). Pengaturan `HISTORY.SCOPE` (`'agency'` atau `'user'`). Export: `Hasil_History_Check_Pelunasan_YYYYMMDD_HHMM.xlsx`.
- **Kelola User:** role Admin boleh tanpa nama agency (tersimpan sebagai "Admin"); ditambah field **Nama** (wajib untuk user baru). Login tetap pakai username, kanan atas menampilkan nama. Kolom `nama` dibuat otomatis di sheet Auth.

## File / fungsi / ID
- Web app: `code.gs`, `Index.html` (di repo: `Code.js`, `Index.html`). Modul uji terpisah `PrepaymentCalc.gs` + `test_prepayment.js` dibuat dulu, lalu rumusnya dipindah ke `code.gs`.
- Fungsi lama yang dipertahankan: `hitungPokok_`, `hitungDenda_`, `hitungPinalti_`, `hitungBungaBerjalan_`, konstanta `RUMUS`.
- `CONFIG.SPREADSHEET_DATA_ID` = `1EMeyYi5Dw95u-ybPVgXC4-96E6ovQ5kruWTDjuO6z-4`.
- Kolom aging yang dipakai: `ppk`, `rental`, `outstanding_balance`, `drawdown_date`, `tenor`, `interest_effective`, `counter`, `tanggal_jatuh_tempo`, `tanggal_bayar_terakhir`, `denda_tertunggak`.

## Selesai
- Rumus Discount AR, accrued interest, pinalti, denda tervalidasi Rp0 terhadap contoh sistem (44–62 pengecekan otomatis lulus).
- `code.gs` + `Index.html` diperbarui: rumus baru, sumber Calculator_Feed, tema dashboard, tab menu, Batch Calc, History, popup rincian, pencarian, perbaikan capture, disclaimer, ikon, field Nama, aturan Admin tanpa agency.
- `calcFeedBackfillManual()` sudah dijalankan user: sheet `Base` terisi 62.764 kontrak dari aging 20 Okt 2026.

## Belum selesai (per akhir chat)
- Job per jam Calculator_Feed dibiarkan jalan otomatis keesokan harinya (belum diverifikasi di chat ini).
- Tambah user dengan field Nama dan login belum dicoba di Apps Script asli.
- Rate denda untuk Rental Remain pada kontrak REFI masih asumsi; kontrak contoh berawalan "2" memakai 0,2% di sistem — perlu dicek kalau denda Rental Remain mulai dihitung.
- Denda tertunggak hanya ter-update di job pagi (file payment per jam tidak memuat denda).

## Keputusan lama yang dibatalkan
- Sumber denda historis: kolom `denda` / sheet Data_Denda_Historis (`os_denda`) → **`denda_tertunggak`** di aging.
- Rate denda REFI 0,2% (chat Sep 2026) → **0,5%**; definisi NMC ditambah syarat drawdown < 1 Sep 2026.
- Klasifikasi NMC/REFI dari kolom `no_kontrak` → dari **`ppk`**.
- Sumber data sheet statis `Data_Calculator_Reference` (terakhir diubah 23 Sep 2026) → **Calculator_Feed**.
- Nama menu "Hitung Massal" → **"Batch Calc"**.
- Menu inline di samping judul → tab di bawah header.
