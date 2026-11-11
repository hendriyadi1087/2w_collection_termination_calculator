/**
 * ============================================================
 * PREPAYMENT CALCULATOR - Simasfin Motorcycle Collection
 * ============================================================
 * Backend Apps Script. Struktur file ini SENGAJA dipecah per
 * modul kalkulasi (pokok, denda, pinalti, bunga berjalan) supaya
 * kalau rumus salah satu item berubah, cukup edit 1 fungsi saja
 * tanpa menyentuh fungsi lain.
 *
 * Kalau ada revisi rumus bisnis, ubah di sini:
 *   - hitungPokok_()          -> rumus pokok hutang
 *   - hitungDenda_()          -> rumus denda berjalan + historis
 *   - hitungPinalti_()        -> rumus pinalti pelunasan dipercepat
 *   - hitungBungaBerjalan_()  -> rumus bunga berjalan
 * Konstanta rate (denda REFI/NMC, 10%, dst) ada di objek RUMUS di bawah -
 * kalau cuma angkanya yang berubah, gak perlu sentuh logic sama
 * sekali, tinggal ganti angka di situ.
 *
 * REVISI OKT 2026 - semua rumus disamakan dengan hasil Termination
 * Confirm sistem (sudah dicocokkan Rp0 dengan 3 contoh):
 *   - Sumber data CUKUP file aging (Data_Calculator_Reference).
 *     Data_Denda_Historis tidak dipakai lagi - diganti kolom "denda_tertunggak".
 *   - Bunga berjalan = OS x interest_effective% / 360 x hari sejak due
 *     date terakhir terbayar. Tidak lagi pakai OSI / Mature_Date.
 *   - Denda: kolom "denda_tertunggak" aging + denda berjalan; rate REFI 0,5% / NMC 0,2%.
 *     (Kolom "denda" di aging TIDAK dipakai.)
 *   - Rental Remain ikut dihitung bila kolomnya ada (opsional, tidak
 *     pernah membuat kalkulator gagal bila kosong / tidak ada).
 *
 * PENTING soal sheet Prepayment_Calculator_Auth: header baris 1
 * HARUS persis begini (urutan bebas asal semua ada):
 *   username | password_hash | agency_name | role | status | last_login
 * Kolom "role" isinya "admin" atau "agency". Data di sheet ini
 * JANGAN diisi manual - semua lewat menu Kelola User (admin) atau
 * fungsi tambahAgencyManual() di bawah untuk bootstrap admin
 * pertama kali.
 * ============================================================
 */

// ============================================================
// KONFIGURASI - ganti di sini kalau ID spreadsheet berubah
// ============================================================
// Catatan: semua akses sheet di file ini pakai .getSheets()[0] (tab
// PERTAMA di spreadsheet), jadi nama tab bebas apa saja / boleh
// di-rename kapan pun - tidak perlu dicocokkan dengan nama di sini.
// (Data_Denda_Historis sudah tidak dipakai - denda historis kini dibaca
// dari kolom "denda_tertunggak" di Data_Calculator_Reference; kolom "denda" tidak dipakai.)
var CONFIG = {
  // Sumber data = spreadsheet "Calculator_Feed" yang diisi otomatis oleh job pagi & job per jam
  // (Calculator_Feed.gs di project Generate_Data_Daily). Isi dengan ID yang muncul di Logs saat calcFeedSetup() dijalankan.
  SPREADSHEET_DATA_ID: '1EMeyYi5Dw95u-ybPVgXC4-96E6ovQ5kruWTDjuO6z-4', // Calculator_Feed
  SPREADSHEET_AUTH_ID: '16DIXpuCWxrUnF2eFnC7V27fcE6e6GFlel9rGkEPEgBM', // Prepayment_Calculator_Auth
};

// ============================================================
// KONSTANTA RUMUS - gampang diubah tanpa bongkar logic
// ============================================================
var RUMUS = {
  DENDA_RATE_HARIAN: {REFI: 0.005, NMC: 0.002}, // x rental x hari telat, per angsuran overdue
  PINALTI_RATE: 0.10,        // 10% dari sisa pokok (OSP)
  HARI_SETAHUN: 360,         // basis hari bunga berjalan
  // Kontrak dengan drawdown >= tanggal ini SELALU REFI (aturan baru). Tepat 1 Sep 2026
  // belum ditegaskan user -> diperlakukan REFI.
  TANGGAL_BATAS_REFI: new Date(2026, 8, 1),
};

var SESSION_TTL_SECONDS = 21600; // 6 jam - batas maksimal CacheService

// ============================================================
// WEB APP ENTRY POINT
// ============================================================
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Kalkulator Pelunasan - Simasfin')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// SESSION - dasar keamanan semua fitur admin
// ============================================================

/** Bikin sesi baru setelah login sukses, simpan di server (CacheService), balikin token ke client. */
function createSession_(username, role, agencyName, nama) {
  var token = Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put('session_' + token, JSON.stringify({
    username: username, role: role, agencyName: agencyName, nama: nama || '',
  }), SESSION_TTL_SECONDS);
  return token;
}

/** Ambil data sesi dari token. Null kalau tidak valid / sudah habis. */
function getSession_(token) {
  if (!token) return null;
  var raw = CacheService.getScriptCache().get('session_' + token);
  if (!raw) return null;
  return JSON.parse(raw);
}

/** Dipanggil di AWAL setiap fungsi yang butuh login (siapa saja). Throw kalau sesi tidak valid. */
function requireLogin_(token) {
  var session = getSession_(token);
  if (!session) throw new Error('Sesi sudah habis atau tidak valid. Silakan login ulang.');
  return session;
}

/**
 * Dipanggil di AWAL setiap fungsi admin. Ini pengaman sesungguhnya -
 * role diambil dari sesi yang tersimpan di SERVER (bukan dari
 * parameter yang dikirim client), jadi tidak bisa dipalsukan lewat
 * console browser sekalipun.
 */
function requireAdmin_(token) {
  var session = requireLogin_(token);
  if (session.role !== 'admin') throw new Error('Fitur ini khusus admin.');
  return session;
}

function destroySession_(token) {
  if (!token) return;
  CacheService.getScriptCache().remove('session_' + token);
}

// ============================================================
// LOGIN / LOGOUT
// ============================================================

/**
 * Dipanggil dari frontend saat submit form login.
 * Return: {success, agencyName?, role?, sessionToken?, message?}
 */
function login(username, password) {
  username = (username || '').toString().trim();
  password = (password || '').toString();

  if (!username || !password) {
    return {success: false, message: 'Username dan password wajib diisi.'};
  }

  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var col = {};
  header.forEach(function(name, i) { col[name] = i; });

  ['username', 'password_hash', 'agency_name', 'role', 'status', 'last_login'].forEach(function(name) {
    if (col[name] === undefined) {
      throw new Error('Kolom "' + name + '" tidak ada di sheet Auth. Cek header baris 1.');
    }
  });

  var hashInput = hashPassword_(password);

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[col['username']]).trim().toLowerCase() === username.toLowerCase()) {
      if (String(row[col['status']]).trim().toLowerCase() !== 'active') {
        return {success: false, message: 'Akun tidak aktif. Hubungi admin.'};
      }
      if (String(row[col['password_hash']]).trim() !== hashInput) {
        return {success: false, message: 'Username atau password salah.'};
      }
      sheet.getRange(i + 1, col['last_login'] + 1).setValue(new Date());
      var role = String(row[col['role']]).trim() || 'agency';
      var agencyName = row[col['agency_name']];
      var nama = (col['nama'] !== undefined) ? String(row[col['nama']] || '').trim() : '';
      var token = createSession_(username, role, agencyName, nama);
      return {success: true, agencyName: agencyName, role: role, nama: nama, sessionToken: token};
    }
  }
  return {success: false, message: 'Username atau password salah.'};
}

function logout(sessionToken) {
  destroySession_(sessionToken);
  return {success: true};
}

/** Helper hash SHA-256 - dipakai login(), tambahAgencyManual(), dan fungsi admin. */
function hashPassword_(plaintext) {
  var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, plaintext, Utilities.Charset.UTF_8);
  return digest.map(function(b) {
    var v = (b < 0) ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

/**
 * JALANKAN MANUAL dari editor Apps Script (BUKAN dari web) hanya untuk
 * BOOTSTRAP ADMIN PERTAMA KALI, karena menu Kelola User butuh admin
 * yang sudah login untuk dipakai (ayam-telur). Setelah admin pertama
 * ada, semua penambahan user berikutnya cukup lewat menu Kelola User.
 *
 * Cara pakai: tambahkan Script Property ALLOW_ADMIN_BOOTSTRAP = true, ganti
 * nilai di bawah, lalu klik Run > tambahAgencyManual (lihat requireBootstrapFlag_).
 */
function tambahAgencyManual() {
  var props = requireBootstrapFlag_();
  var username = 'admin_utama';
  var plaintextPassword = 'GantiPasswordIni123';
  var agencyName = 'Simasfin - Admin';
  var role = 'admin'; // ganti ke 'agency' kalau mau bikin akun agency biasa lewat sini

  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  sheet.appendRow([username, hashPassword_(plaintextPassword), agencyName, role, 'active', '']);
  props.deleteProperty('ALLOW_ADMIN_BOOTSTRAP');
  Logger.log('User "' + username + '" (' + role + ') berhasil ditambahkan.');
}

/**
 * LUPA PASSWORD ADMIN - JALANKAN MANUAL dari editor Apps Script
 * (Run > resetPasswordAdminManual). Password lama tidak bisa dibaca karena
 * disimpan sebagai hash SHA-256, jadi satu-satunya jalan adalah menimpanya
 * dengan password baru.
 *
 * Cara pakai:
 *  1. Project Settings > Script Properties > tambahkan ALLOW_ADMIN_BOOTSTRAP = true
 *     (pengunci - tanpa ini fungsi menolak jalan).
 *  2. Ganti passwordBaru di bawah, lalu klik Run.
 *  3. SEGERA kembalikan nilainya ke '' (kosong) dan simpan file - jangan
 *     biarkan password tertulis di kode. Pengunci hapus sendiri setelah sukses.
 *  4. Login dengan password baru, lalu ganti lewat menu Kelola User.
 * Fungsi ini hanya mengubah password_hash (status user tidak diubah).
 */
function resetPasswordAdminManual() {
  var props = requireBootstrapFlag_();
  var username = 'admin_utama';
  var passwordBaru = ''; // <-- isi sementara, lalu KOSONGKAN lagi setelah Run

  if (!passwordBaru || passwordBaru.length < 6) {
    throw new Error('Isi passwordBaru dulu (minimal 6 karakter), lalu Run lagi.');
  }
  var found = updateUserRow_(username, function(row, col) {
    row[col['password_hash']] = hashPassword_(passwordBaru);
  });
  if (!found) throw new Error('User "' + username + '" tidak ditemukan di sheet Auth.');
  props.deleteProperty('ALLOW_ADMIN_BOOTSTRAP');
  Logger.log('Password "' + username + '" berhasil direset. Kosongkan lagi passwordBaru di kode.');
}

/**
 * PENGUNCI fungsi bootstrap. Semua fungsi publik di file ini (tanpa "_" di
 * akhir nama) BISA dipanggil siapa saja yang membuka web app lewat
 * google.script.run, termasuk dari console browser tanpa login. Karena itu
 * fungsi yang membuat/mereset akun admin hanya mau jalan bila pemilik script
 * sengaja menyalakan Script Property ALLOW_ADMIN_BOOTSTRAP = true.
 */
function requireBootstrapFlag_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALLOW_ADMIN_BOOTSTRAP') !== 'true') {
    throw new Error('Terkunci. Tambahkan Script Property ALLOW_ADMIN_BOOTSTRAP = true dulu, lalu Run lagi.');
  }
  return props;
}

// ============================================================
// AMBIL DATA KONTRAK
// ============================================================

var FEED = {BASE: 'Base', OVERLAY: 'Overlay', META: 'Meta'};

/** Cari nomor baris (>=2) yang kolom A-nya persis sama dengan ppk. Pakai pencarian sheet (cepat), bukan baca semua baris. */
function cariBarisPpk_(sheet, ppkStr) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var found = sheet.getRange(2, 1, last - 1, 1).createTextFinder(ppkStr).matchEntireCell(true).findAll();
  return found.map(function(r) { return r.getRow(); });
}

function bacaMeta_(ss) {
  var out = {};
  var sh = ss.getSheetByName(FEED.META);
  if (!sh || sh.getLastRow() < 1) return out;
  sh.getRange(1, 1, sh.getLastRow(), 2).getValues().forEach(function(r) { out[String(r[0])] = String(r[1]); });
  return out;
}

/**
 * Baca 1 kontrak by PPK dari Calculator_Feed (data PALING UPDATE):
 *  - sheet "Base"    : posisi semua kontrak dari aging pagi (job pagi)
 *  - sheet "Overlay" : kontrak yang berubah karena pembayaran hari ini (job per jam): sisa pokok, counter, jatuh tempo baru,
 *                      atau status LUNAS
 *  - sheet "Meta"    : tanggal aging & jam data payment terakhir
 * Null kalau PPK tidak ketemu. Kalau spreadsheet belum punya sheet "Base" (format lama), jatuh ke cara lama (tab pertama).
 */
function getContractByPPK_(ppk) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_DATA_ID);
  var ppkStr = String(ppk).trim();
  var base = ss.getSheetByName(FEED.BASE);
  if (!base && ss.getSheetByName(FEED.META)) { // feed ada tapi Base sedang diganti oleh job pagi -> coba lagi sebentar
    Utilities.sleep(2500);
    base = ss.getSheetByName(FEED.BASE);
    if (!base) throw new Error('Data sedang diperbarui oleh sistem. Coba lagi dalam beberapa saat.');
  }
  if (!base) return getContractLama_(ss, ppkStr);

  var lastCol = base.getLastColumn();
  var header = base.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = {};
  header.forEach(function(name, i) { col[String(name).trim()] = i; });
  cekKolomWajib_(col, 'Calculator_Feed (sheet Base)');

  var barisBase = cariBarisPpk_(base, ppkStr);
  if (!barisBase.length) return null;
  var rows = barisBase.map(function(n) { return base.getRange(n, 1, 1, lastCol).getValues()[0]; });
  var result = susunKontrak_(rows, col);

  // --- Overlay: pembayaran hari ini ---
  var meta = bacaMeta_(ss);
  var overlayApplied = false, lunas = false;
  var ov = ss.getSheetByName(FEED.OVERLAY);
  if (ov && ov.getLastRow() >= 2) {
    var ovHeader = ov.getRange(1, 1, 1, ov.getLastColumn()).getValues()[0];
    var oc = {};
    ovHeader.forEach(function(name, i) { oc[String(name).trim()] = i; });
    var barisOv = cariBarisPpk_(ov, ppkStr);
    if (barisOv.length) {
      var o = ov.getRange(barisOv[0], 1, 1, ov.getLastColumn()).getValues()[0];
      var hasilOv = terapkanOverlay_(result, o, oc);
      lunas = hasilOv.lunas;
      overlayApplied = hasilOv.applied;
    }
  }
  result.lunas = lunas;
  result.dataInfo = {
    agingDate: meta.aging_date || '',
    overlayAsOf: meta.overlay_as_of || '',
    overlayApplied: overlayApplied,
    baseGeneratedAt: meta.base_generated_at || '',
  };
  return result;
}

/** Terapkan 1 baris Overlay (pembayaran hari ini) ke objek kontrak. Return {lunas, applied}. */
function terapkanOverlay_(result, o, oc) {
  if (String(o[oc['status']]).trim().toUpperCase() === 'LUNAS') return {lunas: true, applied: false};
  result.outstandingBalance = Number(o[oc['outstanding_balance']]) || 0;
  if (o[oc['counter']] !== '' && o[oc['counter']] !== null) result.counter = Number(o[oc['counter']]) || 0;
  if (o[oc['tanggal_jatuh_tempo']]) result.tanggalJatuhTempo = toDate_(o[oc['tanggal_jatuh_tempo']]);
  return {lunas: false, applied: true};
}

/** Kolom wajib; dipakai Base maupun format lama. */
function cekKolomWajib_(col, namaSumber) {
  var requiredCols = ['ppk', 'nama_customer', 'branch', 'outstanding_balance',
    'tenor', 'counter', 'interest_effective', 'tanggal_jatuh_tempo', 'rental',
    'drawdown_date', 'denda_tertunggak'];
  requiredCols.forEach(function(name) {
    if (col[name] === undefined) {
      throw new Error('Kolom "' + name + '" tidak ditemukan di ' + namaSumber + '. Cek header sheet.');
    }
  });
}

/**
 * Susun objek kontrak dari 1+ baris (PPK ganda: denda_tertunggak & rental_remain dijumlahkan,
 * field lain dari baris pertama). Kolom OPSIONAL (tidak boleh bikin gagal bila tidak ada):
 *   (nomor kontrak = ppk; awalan "9" menentukan NMC - kolom no_kontrak tidak dipakai)
 *   rental_remain -> total kurang bayar angsuran
 */
function susunKontrak_(rows, col) {
  var hasRentalRemain = col['rental_remain'] !== undefined;
  var totalDenda = 0, totalRentalRemain = 0, result = null;
  rows.forEach(function(row) {
    totalDenda += Number(row[col['denda_tertunggak']]) || 0;
    if (hasRentalRemain) totalRentalRemain += Number(row[col['rental_remain']]) || 0;
    if (!result) {
      result = {
        ppk: row[col['ppk']],
        noKontrak: String(row[col['ppk']]).trim(), // nomor kontrak = ppk (dikonfirmasi user 2026-10-21)
        namaCustomer: row[col['nama_customer']],
        branch: row[col['branch']],
        outstandingBalance: Number(row[col['outstanding_balance']]) || 0,
        tenor: Number(row[col['tenor']]) || 0,
        counter: Number(row[col['counter']]) || 0,
        interestEffective: Number(row[col['interest_effective']]) || 0, // % per tahun, mis. 33.70074
        tanggalJatuhTempo: toDate_(row[col['tanggal_jatuh_tempo']]),
        rental: Number(row[col['rental']]) || 0,
        drawdownDate: toDate_(row[col['drawdown_date']]),
      };
    }
  });
  result.dendaTertunggak = totalDenda;
  result.rentalRemain = totalRentalRemain;
  result.rentalRemainTersedia = hasRentalRemain;
  return result;
}

/** Cara LAMA (cadangan): baca seluruh tab pertama lalu cari baris demi baris. Lambat & tidak ada info tanggal data. */
function getContractLama_(ss, ppkStr) {
  var data = ss.getSheets()[0].getDataRange().getValues();
  var col = {};
  data[0].forEach(function(name, i) { col[name] = i; });
  cekKolomWajib_(col, 'Data_Calculator_Reference');
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col['ppk']]).trim() === ppkStr) rows.push(data[i]);
  }
  if (!rows.length) return null;
  var result = susunKontrak_(rows, col);
  result.lunas = false;
  result.dataInfo = {agingDate: '', overlayAsOf: '', overlayApplied: false, baseGeneratedAt: '', formatLama: true};
  return result;
}

// ============================================================
// MODUL KALKULASI - masing-masing item terpisah, gampang direvisi
// ============================================================

/**
 * POKOK HUTANG
 * Saat ini: langsung pakai outstanding_balance (OSP) dari data,
 * statis - tidak berubah walau tanggal rencana bayar mundur.
 */
function hitungPokok_(data) {
  return data.outstandingBalance;
}

/**
 * JENIS KONTRAK (menentukan rate denda)
 *  NMC  = awalan "9" DAN drawdown < 1 Sep 2026
 *  REFI = selain itu (awalan bukan "9", atau drawdown >= 1 Sep 2026)
 * Dasar awalan: nomor kontrak = ppk (dikonfirmasi user 2026-10-21).
 */
function tentukanJenisKontrak_(noKontrak, drawdownDate) {
  var awalan9 = String(noKontrak || '').trim().charAt(0) === '9';
  var sebelumBatas = drawdownDate instanceof Date && !isNaN(drawdownDate.getTime()) &&
      drawdownDate.getTime() < RUMUS.TANGGAL_BATAS_REFI.getTime();
  return (awalan9 && sebelumBatas) ? 'NMC' : 'REFI';
}

/**
 * DENDA
 * Dikonfirmasi user 2026-10-20:
 *  total denda = SUM kolom "denda_tertunggak" di aging (denda historis) + denda berjalan
 *  (kolom "denda" di aging TIDAK dipakai - dikoreksi user 2026-10-21)
 *  Denda berjalan: tiap angsuran yang sudah lewat jatuh tempo (<= tanggal
 *  rencana bayar) = rental x rate x hari telat. Jumlah angsuran yang
 *  dihitung dibatasi sebanyak sisa tenor = (tenor - counter + 1),
 *  termasuk angsuran terakhir bila sudah lewat jatuh tempo.
 *  Rate per hari x rental: REFI 0,5% - NMC 0,2% (lihat tentukanJenisKontrak_).
 */
function hitungDenda_(data, tanggalRencanaBayar) {
  var jenisKontrak = tentukanJenisKontrak_(data.noKontrak, data.drawdownDate);
  var rate = RUMUS.DENDA_RATE_HARIAN[jenisKontrak];

  var maxAngsuran = data.tenor - data.counter + 1;
  var dendaBerjalan = 0;
  var jumlahAngsuranOverdue = 0;

  for (var i = 0; i < maxAngsuran; i++) {
    var dueDateKe_i = edate_(data.tanggalJatuhTempo, i);
    if (dueDateKe_i.getTime() > tanggalRencanaBayar.getTime()) break;

    var hariTelat = daysBetween_(dueDateKe_i, tanggalRencanaBayar);
    dendaBerjalan += data.rental * rate * hariTelat;
    jumlahAngsuranOverdue++;
  }
  dendaBerjalan = Math.round(dendaBerjalan);
  var dendaHistoris = Math.round(data.dendaTertunggak);

  return {
    dendaBerjalan: dendaBerjalan,
    dendaHistoris: dendaHistoris,
    totalDenda: dendaBerjalan + dendaHistoris,
    jumlahAngsuranOverdue: jumlahAngsuranOverdue,
    jenisKontrak: jenisKontrak,
    rateHarian: rate,
  };
}

/**
 * PINALTI
 * Dikonfirmasi user 2026-09-23: 10% dari sisa pokok (OSP), statis.
 */
function hitungPinalti_(data) {
  return Math.round(data.outstandingBalance * RUMUS.PINALTI_RATE);
}

/**
 * RENTAL REMAIN (kurang bayar angsuran)
 * Opsional: dibaca dari kolom "rental_remain" aging kalau ada, 0 kalau tidak.
 * Tidak pernah membuat kalkulator gagal. Denda atas Rental Remain belum
 * dihitung (butuh data per angsuran) - lihat catatan di hasil.
 */
function hitungRentalRemain_(data) {
  return Math.round(data.rentalRemain || 0);
}

/**
 * BUNGA BERJALAN
 * Dikonfirmasi user 2026-10-20 (cocok Rp0 dengan Termination Confirm sistem):
 *  periodeAwal  = EDATE(tanggal_jatuh_tempo, -1)  -> due date angsuran
 *                 terakhir yang SUDAH dibayar (bukan tanggal bayarnya)
 *  hari         = tanggalRencanaBayar - periodeAwal   (min. 0)
 *  bungaBerjalan= OS x interest_effective% / 360 x hari
 *  Tidak dibatasi OSI / Mature_Date - bunga terus berjalan walau kontrak
 *  sudah lewat jatuh tempo terakhir.
 */
function hitungBungaBerjalan_(data, tanggalRencanaBayar) {
  var periodeAwal = edate_(data.tanggalJatuhTempo, -1);
  var hari = Math.max(0, daysBetween_(periodeAwal, tanggalRencanaBayar));
  var bunga = data.outstandingBalance * (data.interestEffective / 100) / RUMUS.HARI_SETAHUN * hari;
  return {
    bungaBerjalan: Math.round(bunga),
    hari: hari,
    periodeAwal: periodeAwal,
  };
}

// ============================================================
// ORKESTRATOR - dipanggil dari frontend
// ============================================================

/**
 * Inti perhitungan 1 kontrak (dipakai kalkulator tunggal & massal).
 * data = hasil getContractByPPK_ / konteks batch; tanggalRencanaBayar = Date.
 */
function hitungRincian_(data, tanggalRencanaBayar) {
  var pokok = hitungPokok_(data);
  var denda = hitungDenda_(data, tanggalRencanaBayar);
  var pinalti = hitungPinalti_(data);
  var bunga = hitungBungaBerjalan_(data, tanggalRencanaBayar);
  var rentalRemain = hitungRentalRemain_(data);

  // Total AR (sistem) = pokok + bunga berjalan + pinalti + rental remain; denda ditambahkan terpisah.
  var totalPelunasan = pokok + bunga.bungaBerjalan + pinalti + rentalRemain + denda.totalDenda;
  return {
    rincian: {
      pokok: pokok,
      bungaBerjalan: bunga.bungaBerjalan,
      denda: denda.totalDenda,
      dendaBerjalan: denda.dendaBerjalan,
      dendaHistoris: denda.dendaHistoris,
      pinalti: pinalti,
      rentalRemain: rentalRemain,
    },
    info: {
      jenisKontrak: denda.jenisKontrak,
      rateDendaHarian: denda.rateHarian,
      hariBunga: bunga.hari,
      rentalRemainTersedia: data.rentalRemainTersedia,
    },
    totalPelunasan: totalPelunasan,
  };
}

/**
 * Dipanggil dari frontend saat klik tombol "Calculate".
 * tanggalRencanaBayarStr format "YYYY-MM-DD" (dari <input type="date">).
 */
function hitungPelunasan(sessionToken, ppk, tanggalRencanaBayarStr) {
  var session = requireLogin_(sessionToken); // siapa saja yang sudah login boleh, admin & agency

  var data = getContractByPPK_(ppk);
  if (!data) {
    return {success: false, message: 'Nomor kontrak (PPK) tidak ditemukan.'};
  }
  if (data.lunas) {
    var infoLunas = bangunInfoData_(data.dataInfo);
    return {success: false, message: 'Kontrak ini sudah LUNAS pada data terbaru (' + infoLunas.teks + '). Tidak ada tagihan pelunasan.'};
  }

  var tanggalInquiry = new Date();
  var tanggalRencanaBayar = parseDateInput_(tanggalRencanaBayarStr);
  var h = hitungRincian_(data, tanggalRencanaBayar);
  h.info.dataInfo = bangunInfoData_(data.dataInfo);
  catatHistory_(session, [{
    ppk: data.ppk, tanggal: tanggalRencanaBayarStr, namaCustomer: data.namaCustomer, branch: data.branch,
    tanggalFmt: formatDate_(tanggalRencanaBayar), jenisKontrak: h.info.jenisKontrak, rateDendaHarian: h.info.rateDendaHarian,
    rincian: h.rincian, totalPelunasan: h.totalPelunasan, dataTeks: h.info.dataInfo.teks, dataKedaluwarsa: h.info.dataInfo.kedaluwarsa,
    rentalRemainTersedia: h.info.rentalRemainTersedia,
  }]);

  return {
    success: true,
    ppk: data.ppk,
    namaCustomer: data.namaCustomer,
    branch: data.branch,
    tanggalInquiry: formatDate_(tanggalInquiry) + ' ' + formatTime_(tanggalInquiry),
    tanggalRencanaBayar: formatDate_(tanggalRencanaBayar),
    rincian: h.rincian,
    info: h.info,
    totalPelunasan: h.totalPelunasan,
  };
}

// ============================================================
// HITUNG MASSAL (UPLOAD EXCEL)
// ============================================================
var BATCH = {
  MAX_PER_CALL: 500, // batas baris per panggilan server (frontend memecah upload per 500 baris)
};

/**
 * Muat Base + Overlay + Meta SEKALI untuk satu panggilan batch (lebih murah daripada mencari per PPK).
 * Return {baseMap, col, ovMap, oc, meta, lama}. baseMap/ovMap: ppk -> array baris.
 */
function muatKonteksBatch_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_DATA_ID);
  var base = ss.getSheetByName(FEED.BASE);
  if (!base && ss.getSheetByName(FEED.META)) {
    Utilities.sleep(2500);
    base = ss.getSheetByName(FEED.BASE);
    if (!base) throw new Error('Data sedang diperbarui oleh sistem. Coba lagi dalam beberapa saat.');
  }
  var lama = !base;
  var sheet = base || ss.getSheets()[0];
  var vals = sheet.getDataRange().getValues();
  var col = {};
  vals[0].forEach(function(name, i) { col[String(name).trim()] = i; });
  cekKolomWajib_(col, lama ? 'Data_Calculator_Reference' : 'Calculator_Feed (sheet Base)');

  var baseMap = {};
  for (var i = 1; i < vals.length; i++) {
    var k = String(vals[i][col['ppk']]).trim();
    if (!k) continue;
    (baseMap[k] = baseMap[k] || []).push(vals[i]);
  }

  var ovMap = {}, oc = {};
  var meta = {};
  if (!lama) {
    meta = bacaMeta_(ss);
    var ov = ss.getSheetByName(FEED.OVERLAY);
    if (ov && ov.getLastRow() >= 2) {
      var ovVals = ov.getDataRange().getValues();
      ovVals[0].forEach(function(name, i) { oc[String(name).trim()] = i; });
      for (var j = 1; j < ovVals.length; j++) {
        var kk = String(ovVals[j][oc['ppk']]).trim();
        if (kk && !ovMap[kk]) ovMap[kk] = ovVals[j];
      }
    }
  }
  return {baseMap: baseMap, col: col, ovMap: ovMap, oc: oc, meta: meta, lama: lama};
}

/** Satu kontrak dari konteks batch (sama dengan getContractByPPK_, tanpa akses sheet). Null bila tidak ada. */
function kontrakDariKonteks_(ctx, ppkStr) {
  var rows = ctx.baseMap[ppkStr];
  if (!rows) return null;
  var result = susunKontrak_(rows, ctx.col);
  result.lunas = false;
  var o = ctx.ovMap[ppkStr];
  if (o) {
    var h = terapkanOverlay_(result, o, ctx.oc);
    result.lunas = h.lunas;
  }
  return result;
}

/** Validasi "YYYY-MM-DD" yang benar-benar ada di kalender. Return Date atau null. */
function parseTanggalKetat_(str) {
  var m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

/**
 * Hitung banyak kontrak sekaligus. items = [{ppk, tanggal:'YYYY-MM-DD'}] (maks BATCH.MAX_PER_CALL).
 * Baris yang bermasalah (PPK kosong/tidak ditemukan/lunas, tanggal tidak valid) TIDAK menggagalkan baris lain:
 * tiap baris dikembalikan dengan success true/false + message.
 */
function hitungPelunasanBatch(sessionToken, items) {
  var session = requireLogin_(sessionToken);
  if (!Array.isArray(items) || items.length === 0) {
    return {success: false, message: 'Tidak ada baris untuk dihitung.'};
  }
  if (items.length > BATCH.MAX_PER_CALL) {
    return {success: false, message: 'Terlalu banyak baris dalam satu proses (maks ' + BATCH.MAX_PER_CALL + ').'};
  }

  var ctx = muatKonteksBatch_();
  var infoData = bangunInfoData_(ctx.lama
    ? {formatLama: true}
    : {agingDate: ctx.meta.aging_date || '', overlayAsOf: ctx.meta.overlay_as_of || ''});
  var out = [];
  items.forEach(function(it) {
    var ppk = String((it && it.ppk) === undefined || (it && it.ppk) === null ? '' : it.ppk).trim();
    var row = {ppk: ppk, tanggal: String((it && it.tanggal) || ''), success: false, message: ''};
    if (!ppk) { row.message = 'PPK kosong.'; out.push(row); return; }
    var tgl = parseTanggalKetat_(row.tanggal);
    if (!tgl) { row.message = 'Tanggal rencana bayar tidak valid.'; out.push(row); return; }
    var data = kontrakDariKonteks_(ctx, ppk);
    if (!data) { row.message = 'PPK tidak ditemukan.'; out.push(row); return; }
    row.namaCustomer = data.namaCustomer;
    row.branch = data.branch;
    if (data.lunas) { row.message = 'Sudah LUNAS pada data terbaru.'; out.push(row); return; }
    try {
      var h = hitungRincian_(data, tgl);
      row.success = true;
      row.tanggalFmt = formatDate_(tgl);
      row.jenisKontrak = h.info.jenisKontrak;
      row.rateDendaHarian = h.info.rateDendaHarian;
      row.rincian = h.rincian;
      row.totalPelunasan = h.totalPelunasan;
      row.rentalRemainTersedia = h.info.rentalRemainTersedia;
    } catch (e) {
      row.message = 'Gagal menghitung: ' + (e.message || e);
    }
    out.push(row);
  });

  catatHistory_(session, out.filter(function(r) { return r.success; }).map(function(r) {
    r.dataTeks = infoData.teks; r.dataKedaluwarsa = infoData.kedaluwarsa;
    return r;
  }));

  var inq = new Date();
  return {
    success: true,
    rows: out,
    tanggalInquiry: formatDate_(inq) + ' ' + formatTime_(inq),
    dataInfo: infoData,
  };
}

// ============================================================
// HISTORY INQUIRY (30 hari terakhir)
// ============================================================
// Setiap perhitungan yang berhasil (kalkulator tunggal & hitung massal) dicatat di sheet "History" pada spreadsheet
// Prepayment_Calculator_Auth (dibuat otomatis). Tab pertama (Auth) tidak disentuh.
//  - Agency  : melihat history milik AGENCY-nya sendiri (HISTORY.SCOPE = 'agency') atau hanya akun-nya ('user').
//  - Admin   : melihat semua.
//  - Data lebih dari HISTORY.HARI_SIMPAN hari dihapus otomatis (sekali per hari, saat ada pencatatan baru).
var HISTORY = {
  SHEET: 'History',
  HEADER: ['waktu', 'username', 'agency', 'ppk', 'tanggal_rencana_bayar', 'data'],
  HARI_TAMPIL: 30,
  HARI_SIMPAN: 31,
  MAX_BARIS_KEMBALI: 5000,
  SCOPE: 'agency', // 'agency' = semua akun dalam agency yang sama; 'user' = hanya akun sendiri
};

function zonaWaktu_() { return Session.getScriptTimeZone() || 'Asia/Jakarta'; }

function sheetHistory_() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID);
  var sh = ss.getSheetByName(HISTORY.SHEET);
  if (!sh) {
    sh = ss.insertSheet(HISTORY.SHEET);
    sh.getRange(1, 1, 1, HISTORY.HEADER.length).setValues([HISTORY.HEADER]);
    sh.getRange(1, 1, 1, 5).setNumberFormat('@'); // waktu/username/agency/ppk/tanggal sebagai teks
  }
  return sh;
}

/** Ringkas hasil 1 kontrak jadi JSON kecil untuk disimpan. */
function ringkasHistory_(row) {
  var r = row.rincian;
  return JSON.stringify({
    n: row.namaCustomer || '', b: row.branch || '', tf: row.tanggalFmt || '',
    j: row.jenisKontrak || '', r: row.rateDendaHarian,
    p: [r.pokok, r.bungaBerjalan, r.dendaBerjalan, r.dendaHistoris, r.denda, r.pinalti, r.rentalRemain || 0],
    t: row.totalPelunasan, d: row.dataTeks || '', k: row.dataKedaluwarsa ? 1 : 0, rt: row.rentalRemainTersedia === false ? 0 : 1,
  });
}

/** Catat banyak hasil sekaligus. rows = [{ppk, tanggal, ...hasil}]. TIDAK PERNAH melempar error (history bukan fitur utama). */
function catatHistory_(session, rows) {
  if (!rows || !rows.length) return;
  var lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var sh = sheetHistory_();
    var waktu = Utilities.formatDate(new Date(), zonaWaktu_(), 'yyyy-MM-dd HH:mm:ss');
    var vals = rows.map(function(r) {
      return [waktu, String(session.username || ''), String(session.agencyName || ''), String(r.ppk), String(r.tanggal), ringkasHistory_(r)];
    });
    var start = Math.max(sh.getLastRow(), 1) + 1;
    var need = start + vals.length - 1;
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
    sh.getRange(start, 1, vals.length, 5).setNumberFormat('@');
    sh.getRange(start, 1, vals.length, HISTORY.HEADER.length).setValues(vals);
    bersihkanHistoryLama_(sh);
  } catch (e) {
    Logger.log('PERINGATAN history gagal dicatat (perhitungan tetap berhasil): ' + (e.message || e));
  } finally {
    try { if (lock) lock.releaseLock(); } catch (e2) { /* abaikan */ }
  }
}

/** Hapus baris lebih tua dari HARI_SIMPAN (data kronologis -> cukup cari baris pertama yang masih baru). Maks sekali per hari. */
function bersihkanHistoryLama_(sh) {
  var props = PropertiesService.getScriptProperties();
  var hariIni = Utilities.formatDate(new Date(), zonaWaktu_(), 'yyyy-MM-dd');
  if (props.getProperty('HISTORY_LAST_PURGE') === hariIni) return;
  var last = sh.getLastRow();
  if (last >= 2) {
    var batas = Utilities.formatDate(new Date(new Date().getTime() - HISTORY.HARI_SIMPAN * 86400000), zonaWaktu_(), 'yyyy-MM-dd HH:mm:ss');
    var waktu = sh.getRange(2, 1, last - 1, 1).getValues();
    var lama = 0;
    while (lama < waktu.length && String(waktu[lama][0]) < batas) lama++;
    if (lama > 0) sh.deleteRows(2, lama);
  }
  props.setProperty('HISTORY_LAST_PURGE', hariIni);
}

/** Ambil history 30 hari terakhir milik pemanggil (admin: semua). Terbaru di atas. */
function getHistory(sessionToken) {
  var session = requireLogin_(sessionToken);
  var sh = sheetHistory_();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2) {
    var batas = Utilities.formatDate(new Date(new Date().getTime() - HISTORY.HARI_TAMPIL * 86400000), zonaWaktu_(), 'yyyy-MM-dd HH:mm:ss');
    var vals = sh.getRange(2, 1, last - 1, HISTORY.HEADER.length).getValues();
    var admin = session.role === 'admin';
    var ag = String(session.agencyName || '').trim().toLowerCase();
    var us = String(session.username || '').trim().toLowerCase();
    for (var i = vals.length - 1; i >= 0 && out.length < HISTORY.MAX_BARIS_KEMBALI; i--) {
      var v = vals[i];
      var waktu = String(v[0]);
      if (waktu < batas) break; // data kronologis: yang lebih lama pasti sudah di luar rentang
      if (!admin) {
        var cocok = HISTORY.SCOPE === 'user'
          ? String(v[1]).trim().toLowerCase() === us
          : String(v[2]).trim().toLowerCase() === ag;
        if (!cocok) continue;
      }
      var d;
      try { d = JSON.parse(v[5]); } catch (e) { continue; }
      out.push({
        success: true, waktu: waktu, username: String(v[1]), agency: String(v[2]),
        ppk: String(v[3]), tanggal: String(v[4]), tanggalFmt: d.tf, namaCustomer: d.n, branch: d.b,
        jenisKontrak: d.j, rateDendaHarian: d.r,
        rincian: {pokok: d.p[0], bungaBerjalan: d.p[1], dendaBerjalan: d.p[2], dendaHistoris: d.p[3], denda: d.p[4], pinalti: d.p[5], rentalRemain: d.p[6]},
        totalPelunasan: d.t, dataTeks: d.d, dataKedaluwarsa: !!d.k, rentalRemainTersedia: d.rt === 1,
      });
    }
  }
  return {success: true, rows: out, hari: HISTORY.HARI_TAMPIL, semua: session.role === 'admin', scope: HISTORY.SCOPE};
}

// ============================================================
// ADMIN - KELOLA USER (semua fungsi di bawah WAJIB requireAdmin_
// di baris pertama - ini yang bikin menu admin beneran aman, bukan
// cuma disembunyikan di tampilan)
// ============================================================

/** List semua user (tanpa password_hash) untuk ditampilkan di tabel admin. */
function adminListUsers(sessionToken) {
  requireAdmin_(sessionToken);

  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var col = {};
  header.forEach(function(name, i) { col[name] = i; });

  var users = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[col['username']]) continue; // skip baris kosong
    var lastLoginRaw = row[col['last_login']];
    users.push({
      username: row[col['username']],
      nama: (col['nama'] !== undefined) ? row[col['nama']] : '',
      agencyName: row[col['agency_name']],
      role: row[col['role']],
      status: row[col['status']],
      lastLogin: lastLoginRaw ? (formatDate_(toDate_(lastLoginRaw)) + ' ' + formatTime_(toDate_(lastLoginRaw))) : '-',
    });
  }
  return {success: true, users: users};
}

/** Tambah user baru. role: "admin" atau "agency". */
function adminAddUser(sessionToken, newUsername, newPassword, agencyName, role, nama) {
  requireAdmin_(sessionToken);

  newUsername = (newUsername || '').toString().trim();
  agencyName = (agencyName || '').toString().trim();
  nama = (nama || '').toString().trim();
  role = (role === 'admin') ? 'admin' : 'agency';

  if (role === 'admin' && !agencyName) agencyName = 'Admin';
  if (!newUsername || !newPassword || !agencyName || !nama) {
    return {success: false, message: 'Semua field wajib diisi.'};
  }
  if (newPassword.length < 6) {
    return {success: false, message: 'Password minimal 6 karakter.'};
  }

  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idxUsername = header.indexOf('username');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idxUsername]).trim().toLowerCase() === newUsername.toLowerCase()) {
      return {success: false, message: 'Username sudah dipakai.'};
    }
  }

  // Kolom "nama" ditambahkan otomatis di ujung kanan header kalau belum ada
  var idxNama = header.indexOf('nama');
  if (idxNama < 0) {
    idxNama = header.length;
    sheet.getRange(1, idxNama + 1).setValue('nama');
  }
  var baris = [newUsername, hashPassword_(newPassword), agencyName, role, 'active', ''];
  while (baris.length < idxNama) baris.push('');
  baris[idxNama] = nama;
  sheet.appendRow(baris);
  return {success: true};
}

/** Reset password user tertentu ke password baru (admin yang tentukan). */
function adminResetPassword(sessionToken, targetUsername, newPassword) {
  requireAdmin_(sessionToken);

  if (!newPassword || newPassword.length < 6) {
    return {success: false, message: 'Password baru minimal 6 karakter.'};
  }

  var found = updateUserRow_(targetUsername, function(row, col) {
    row[col['password_hash']] = hashPassword_(newPassword);
  });
  return found ? {success: true} : {success: false, message: 'User tidak ditemukan.'};
}

/** Aktifkan/nonaktifkan user. newStatus: "active" atau "inactive". */
function adminSetStatus(sessionToken, targetUsername, newStatus) {
  requireAdmin_(sessionToken);
  newStatus = (newStatus === 'active') ? 'active' : 'inactive';

  if (newStatus === 'inactive') {
    var guard = guardLastActiveAdmin_(targetUsername);
    if (!guard.ok) return {success: false, message: guard.message};
  }

  var found = updateUserRow_(targetUsername, function(row, col) {
    row[col['status']] = newStatus;
  });
  return found ? {success: true} : {success: false, message: 'User tidak ditemukan.'};
}

/** Hapus user permanen dari sheet. */
function adminDeleteUser(sessionToken, targetUsername) {
  requireAdmin_(sessionToken);

  var guard = guardLastActiveAdmin_(targetUsername);
  if (!guard.ok) return {success: false, message: guard.message};

  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var idxUsername = header.indexOf('username');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idxUsername]).trim().toLowerCase() === String(targetUsername).trim().toLowerCase()) {
      sheet.deleteRow(i + 1);
      return {success: true};
    }
  }
  return {success: false, message: 'User tidak ditemukan.'};
}

/** Pengaman: cegah admin aktif TERAKHIR dihapus/dinonaktifkan (jangan sampai terkunci sendiri). */
function guardLastActiveAdmin_(targetUsername) {
  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var col = {};
  header.forEach(function(name, i) { col[name] = i; });

  var targetRow = null;
  var activeAdminCount = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[col['role']]).trim() === 'admin' &&
        String(row[col['status']]).trim().toLowerCase() === 'active') {
      activeAdminCount++;
    }
    if (String(row[col['username']]).trim().toLowerCase() === String(targetUsername).trim().toLowerCase()) {
      targetRow = row;
    }
  }

  var targetIsActiveAdmin = targetRow &&
      String(targetRow[col['role']]).trim() === 'admin' &&
      String(targetRow[col['status']]).trim().toLowerCase() === 'active';

  if (targetIsActiveAdmin && activeAdminCount <= 1) {
    return {ok: false, message: 'Tidak bisa menonaktifkan/menghapus admin aktif terakhir.'};
  }
  return {ok: true};
}

/** Helper generik: cari 1 baris by username, ubah lewat mutateFn, simpan balik. */
function updateUserRow_(targetUsername, mutateFn) {
  var sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_AUTH_ID)
      .getSheets()[0];
  var data = sheet.getDataRange().getValues();
  var header = data[0];
  var col = {};
  header.forEach(function(name, i) { col[name] = i; });
  var idxUsername = col['username'];

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idxUsername]).trim().toLowerCase() === String(targetUsername).trim().toLowerCase()) {
      var row = data[i].slice();
      mutateFn(row, col);
      sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
      return true;
    }
  }
  return false;
}

// ============================================================
// HELPER TANGGAL
// ============================================================

/** Tambah/kurang N bulan dari sebuah Date, mirip EDATE() di spreadsheet. */
function edate_(date, months) {
  var d = new Date(date.getTime());
  var targetMonth = d.getMonth() + months;
  var originalDay = d.getDate();
  d.setDate(1); // hindari overflow bulan saat setMonth
  d.setMonth(targetMonth);
  var lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  return d;
}

/** Selisih hari (bulat) antara 2 Date, d2 - d1. */
function daysBetween_(d1, d2) {
  var MS_PER_DAY = 24 * 60 * 60 * 1000;
  var utc1 = Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
  var utc2 = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.round((utc2 - utc1) / MS_PER_DAY);
}

function toDate_(value) {
  if (value instanceof Date) return value;
  var m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/); // "YYYY-MM-DD" -> tanggal lokal (hindari geser zona waktu)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

/**
 * Keterangan "data per kapan" untuk ditampilkan di hasil.
 *  agingDate  = tanggal aging (posisi akhir hari tsb, diproses pagi hari berikutnya)
 *  overlayAsOf= "YYYY-MM-DD HH:mm" = jam file payment terakhir yang sudah diterapkan
 */
function bangunInfoData_(d) {
  d = d || {};
  var BLN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var fmt = function(str) {
    var m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?/);
    if (!m) return '';
    return Number(m[3]) + ' ' + BLN[Number(m[2]) - 1] + ' ' + m[1] + (m[4] ? ' pukul ' + m[4] : '');
  };
  if (d.formatLama || !d.agingDate) {
    return {teks: 'tanggal data tidak diketahui', basah: false, kedaluwarsa: false, formatLama: !!d.formatLama};
  }
  var teks = 'aging ' + fmt(d.agingDate);
  if (d.overlayAsOf) teks += ' + pembayaran s.d. ' + fmt(d.overlayAsOf);
  var umurHari = daysBetween_(toDate_(d.agingDate), new Date());
  return {teks: teks, basah: !!d.overlayAsOf, kedaluwarsa: umurHari > 2, umurHari: umurHari, formatLama: false};
}

function parseDateInput_(str) {
  var parts = str.split('-'); // "YYYY-MM-DD"
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

/** Format tanggal jadi "dd - Mmm - yyyy", misal "23 - Sep - 2026". */
function formatDate_(date) {
  var BULAN_SINGKAT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var dd = ('0' + date.getDate()).slice(-2);
  var mmm = BULAN_SINGKAT[date.getMonth()];
  var yyyy = date.getFullYear();
  return dd + ' - ' + mmm + ' - ' + yyyy;
}

function formatTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone() || 'Asia/Jakarta', 'HH:mm');
}