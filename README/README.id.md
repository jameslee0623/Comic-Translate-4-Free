# Comic Translate 4 Free

Bahasa: [English](../README.md) · [हिन्दी](README.hi.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Español](README.es.md) · [العربية](README.ar.md) · [Français](README.fr.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [Deutsch](README.de.md) · [Română](README.ro.md)

Baca manga dalam bahasamu — langsung di browser.

Comic Translate 4 Free menerjemahkan halaman manga dan komik secara otomatis saat Anda menjelajah. Aplikasi ini membaca bahasa Jepang, Inggris, Tionghoa Sederhana dan Tradisional (dengan deteksi otomatis), dan menerjemahkan ke 114 bahasa. Buka sebuah halaman, dan versi terjemahannya menggantikan gambar asli di tempatnya — gelembung percakapan terisi dalam bahasamu.

### 📸 Sebelum & Sesudah

| Sebelum (Jepang) | Sesudah (Indonesia) |
| --- | --- |
| ![Halaman manga Jepang asli](../docs/images/wikipe-tan-original.jpg) | ![Diterjemahkan ke Bahasa Indonesia](../docs/images/wikipe-tan-id.jpg) |

<details>
<summary>Lihat terjemahan dalam 14 bahasa lainnya</summary>

| Hindi | Korean | Simplified Chinese |
| --- | --- | --- |
| ![Hindi](../docs/images/wikipe-tan-hi.jpg) | ![Korean](../docs/images/wikipe-tan-ko.jpg) | ![Simplified Chinese](../docs/images/wikipe-tan-zh-CN.jpg) |

| Traditional Chinese | Spanish | Arabic |
| --- | --- | --- |
| ![Traditional Chinese](../docs/images/wikipe-tan-zh-TW.jpg) | ![Spanish](../docs/images/wikipe-tan-es.jpg) | ![Arabic](../docs/images/wikipe-tan-ar.jpg) |

| French | Bengali | Portuguese |
| --- | --- | --- |
| ![French](../docs/images/wikipe-tan-fr.jpg) | ![Bengali](../docs/images/wikipe-tan-bn.jpg) | ![Portuguese](../docs/images/wikipe-tan-pt.jpg) |

| Russian | Vietnamese | Indonesian |
| --- | --- | --- |
| ![Russian](../docs/images/wikipe-tan-ru.jpg) | ![Vietnamese](../docs/images/wikipe-tan-vi.jpg) | ![Indonesian](../docs/images/wikipe-tan-id.jpg) |

| Urdu | German |
| --- | --- |
| ![Urdu](../docs/images/wikipe-tan-ur.jpg) | ![German](../docs/images/wikipe-tan-de.jpg) |

</details>

*Ilustrasi Wikipe-tan asli oleh Kasuga, dari [artikel Manga Wikipedia](https://en.wikipedia.org/wiki/Manga) via Wikimedia Commons — berlisensi [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Tangkapan layar yang diterjemahkan adalah karya turunan yang dimodifikasi dari aslinya.*

---

## ✨ Fitur

- Terjemahan otomatis (Pro) — buka halaman manga di situs yang diizinkan dan versi terjemahannya akan muncul di tempatnya, tanpa perlu mengeklik tombol. Gratis untuk 50 gambar per hari; tanpa batas dengan Pro.
- Setiap gambar di halaman — terjemahan otomatis menangani semua gambar di sebuah halaman (hingga 50 per proses), bukan hanya gambar utama.
- Terjemahkan halaman berikutnya terlebih dahulu (Pro) — saat Anda membaca halaman ini, gambar halaman berikutnya diterjemahkan di latar belakang, jadi sudah siap begitu Anda membukanya (hanya satu gambar; aktif secara default, bisa dimatikan di Pengaturan). Gratis untuk 50 gambar per hari; tanpa batas dengan Pro.
- Failover mesin — jika mesin terjemahan yang dipilih gagal, atau menghasilkan teks dalam bahasa yang salah, ekstensi secara otomatis mencoba mesin lain. Gratis, selalu aktif.
- OCR (pengujian) — mesin OCR uji yang cepat untuk halaman Jepang. Aktifkan di Pengaturan, di bawah Debug. Jauh lebih cepat di ponsel.
- Satu tab dalam satu waktu — saat satu tab sedang menerjemahkan, tombol Terjemahkan di tab lain menjadi abu-abu. Batal menjadi "Batalkan tab lain".
- Klik kanan pada gambar apa pun — pilih "Kirim ke Comic Translate 4 Free" untuk menerjemahkan gambar tertentu, bahkan yang lebih kecil dari ukuran minimum.
- 114 bahasa target melalui Google Translator, Gemini, Azure Translator, atau server LM Studio lokal Anda sendiri.
- Deteksi otomatis bahasa sumber — bahasa Jepang, Inggris, Tionghoa Sederhana/Tradisional dikenali secara otomatis dari teks hasil OCR.
- Dukungan strip panjang / webtoon — halaman tinggi diproses dalam segmen yang tumpang tindih sehingga teks tetap tajam.
- 17 bahasa UI — antarmuka ekstensi mengikuti pengaturan bahasa browser Anda.
- Bahasa target secara default adalah bahasa browser Anda — ubah kapan saja di Pengaturan.

### 🔒 Privasi

- AI berjalan di komputer Anda. Deteksi gelembung, OCR, dan inpainting semuanya berjalan secara lokal di browser Anda. Deteksi dan OCR berjalan melalui WebAssembly. Inpainting berjalan di GPU di Chrome (dengan fallback WebAssembly), dan melalui WebAssembly di Firefox. Halaman Anda tidak pernah meninggalkan perangkat Anda.
- Hanya teks terjemahan yang dikirim keluar — hanya string yang diekstrak yang dikirim ke layanan terjemahan yang Anda pilih (Google / Gemini / Azure / LM Studio lokal Anda).
- Tanpa akun, tanpa pelacakan, tanpa telemetri. Semua pengaturan dan model yang di-cache tetap berada di penyimpanan lokal browser Anda.

---

## 🚀 Instalasi

Chrome / Edge / Brave:

[Instal dari Chrome Web Store](https://chromewebstore.google.com/detail/pndooikgcenncdohfggodonniihplppj) — sekali klik, pembaruan otomatis.

Firefox:

[Pasang dari Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/comic-translate-4-free/) — sekali klik, pembaruan otomatis.

Setelah menginstal, model diunduh secara otomatis di latar belakang (~350 MB: detektor, OCR, inpainter). Model-model itu di-cache di browser dan diverifikasi berdasarkan ukuran byte. Jika penerjemahan dimulai sebelum model selesai diunduh, penerjemahan akan menunggu.


---

## 💡 Cara Menggunakan

1. Izinkan situsnya terlebih dahulu — klik ikon ekstensi dan tekan Izinkan situs ini (atau aktifkan Izinkan semua situs). Terjemahan hanya berjalan di tempat Anda memberikan izin.

   ![Allow the site from the popup](../docs/images/popup.png)

2. Muat ulang halaman manga — terjemahan dimulai secara otomatis saat halaman dimuat. Sebuah pil di kanan atas menunjukkan progres langsung (Capturing → Detecting → OCR → …).
3. Selesai — gambar-gambar halaman diganti di tempatnya dengan versi terjemahan.

Kiat:
- Klik kanan pada gambar apa pun → Kirim ke Comic Translate 4 Free untuk menerjemahkan hanya gambar itu.

  ![Right-click to send an image](../docs/images/right-click.png)

- Jika sebuah situs memblokir unduhan (HTTP 403), ekstensi akan otomatis mencoba lagi melalui tab latar belakang.
- Pilih mesin terjemahan Anda di Pengaturan: Google Translator (tanpa kunci), Gemini (perlu kunci, direkomendasikan — terjemahan manga lebih baik), Azure Translator (akan dihentikan), atau LM Studio (server lokal).

---

## 🔑 Dapatkan kunci API Gemini

Gemini memberikan terjemahan manga terbaik. Untuk menggunakannya sebagai mesin terjemahan:

1. Buka [Google AI Studio](https://aistudio.google.com/apikey) dan klik "Create API key"
2. Pilih atau buat proyek Google Cloud jika diminta
3. Salin kunci
4. Tempelkan ke kolom 'Kunci API Gemini' di Pengaturan ekstensi, lalu klik 'Periksa koneksi Gemini'
5. Pilih Gemini sebagai mesin terjemahan di Pengaturan

---

## 💎 Pro

Terjemahan dihitung dalam kuota gratis 50 gambar per hari selama ada fitur Pro yang aktif. Satu gambar dihitung satu, berapa pun tingginya. Matikan kedua fitur Pro dan penerjemahan menjadi gratis dan tanpa batas. Terjemahan otomatis dan pra-terjemahan adalah fitur Pro — gratis untuk 50 gambar per hari, tanpa batas dengan langganan Pro.

- $3/bulan atau $30/tahun
- Beli kunci lisensi, tempelkan ke kolom 'Kunci lisensi' di Pengaturan ekstensi, lalu klik Aktifkan Pro. Kunci ini berfungsi di 2 browser.
- Saat Anda mencapai batas gratis 50 gambar, sebuah popup mengingatkan Anda sekali sehari. Setelah Anda memberi rating pada ekstensi, Dapatkan Pro berubah menjadi "Salin Kode Diskon: 5STARS" — ketuk untuk menyalin kode dan membuka checkout.

---

## ⚠️ Masalah yang Diketahui

- Belum ada OCR Korea — bahasa sumbernya adalah Jepang, Inggris, dan Tionghoa Sederhana/Tradisional. (Bahasa Korea tetap tersedia sebagai bahasa target terjemahan.)
- Sesi besar — menerjemahkan puluhan gambar dalam satu sesi dapat memulai ulang ekstensi di latar belakang. Jika itu terjadi, proses akan dilanjutkan secara otomatis dari tempat terakhir berhenti.
- Firefox — model berjalan di halaman latar belakang (tanpa dokumen offscreen), berbagi memori dengan yang lain. Restart browser jika Anda melihat "no available backend found".
- Firefox lebih lambat daripada Chrome — ekstensi Firefox tidak dapat menggunakan memori bersama untuk multi-threading (SharedArrayBuffer), jadi model berjalan pada satu thread CPU. Ini adalah batasan platform Firefox, bukan bug ekstensi. ([Bug Mozilla 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)).
- Google Translator menggunakan endpoint gratis tidak resmi dan mungkin dibatasi kecepatannya.

---

## 📄 Pemberitahuan pihak ketiga

Proyek ini terinspirasi oleh [ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) — detektor gelembung/teks dan inpainter LaMa yang dilatih manga adalah ekspor ONNX-nya, dan logika inferensinya diporting darinya. (OCR menggunakan [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr) oleh genshiai-daichi.)

Pustaka yang dibundel, kode yang diporting, dan model yang diunduh saat runtime dicantumkan beserta lisensinya di [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

PolyForm Noncommercial License 1.0.0 — lihat [LICENSE](../LICENSE).
