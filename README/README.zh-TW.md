# Comic Translate 4 Free

語言： [English](../README.md) · [हिन्दी](README.hi.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Español](README.es.md) · [العربية](README.ar.md) · [Français](README.fr.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [Deutsch](README.de.md) · [Română](README.ro.md)

用你的語言讀漫畫——就在瀏覽器中。

Comic Translate 4 Free 會在你瀏覽時自動翻譯漫畫和連環畫頁面。它能辨識日語、英語、簡體和繁體中文（自動偵測），並翻譯成 114 種語言。開啟一個頁面，翻譯後的版本就會在原地取代原始圖片——對話氣泡裡填滿你的語言。

### 📸 翻譯前後對比

| 之前（日語） | 之後（繁體中文） |
| --- | --- |
| ![原版日語漫畫頁面](../docs/images/wikipe-tan-original.jpg) | ![翻譯成繁體中文](../docs/images/wikipe-tan-zh-TW.jpg) |

<details>
<summary>查看其他 14 種語言的翻譯</summary>

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

*Wikipe-tan 原畫由 Kasuga 創作，取自[維基百科 Manga 條目](https://en.wikipedia.org/wiki/Manga)，經 Wikimedia Commons 發布 — 採用 [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) 授權。翻譯後的截圖為原圖的修改衍生作品。*

---

## ✨ 功能

- 自動翻譯 (Pro) — 在已允許的網站上開啟漫畫頁面，翻譯後的版本就會在原地出現，無需點擊按鈕。每天免費 50 張圖片；Pro 無限量。
- 頁面上的每張圖片 — 自動翻譯會處理頁面上的所有圖片（每次最多 50 張），而不只是主圖。
- 預先翻譯下一頁 (Pro) — 在您閱讀目前頁面時，下一頁的圖片會在背景翻譯好，打開時即可直接查看（僅限一幅圖片；預設開啟，可在設定中關閉）。每天免費 50 張圖片；Pro 無限量。
- 引擎故障轉移 — 如果所選翻譯引擎失敗，或傳回了錯誤語言的文字，擴充功能會自動嘗試另一個引擎。免費，始終開啟。
- OCR（測試版）— 一個用於日語頁面的快速測試版 OCR 引擎。在設定中的 Debug 下開啟。在手機上快得多。
- 一次只翻譯一個分頁 — 當一個分頁正在翻譯時，另一個分頁的 Translate 會變灰。Cancel 上顯示 "Cancel other tab"。
- 在任意圖片上按右鍵 — 選擇「傳送到 Comic Translate 4 Free」來翻譯特定圖片，即使它小於最小尺寸也可以。
- 透過 Google Translator、Gemini、Azure Translator 或你自己的本機 LM Studio 伺服器，支援 114 種目標語言。
- 來源語言自動偵測 — 根據 OCR 辨識的文字自動辨識日語、英語、簡體/繁體中文。
- 長條 / 網路漫畫支援 — 高頁面按重疊分段處理，文字保持清晰。
- 17 種介面語言 — 擴充功能介面遵循瀏覽器的語言設定。
- 目標語言預設為你瀏覽器的語言 — 可隨時在設定中更改。

### 🔒 隱私

- AI 在你的電腦上執行。氣泡偵測、OCR 和修補填充（inpainting）都在瀏覽器中本機執行。偵測和 OCR 透過 WebAssembly 執行。修補填充在 Chrome 上透過 GPU 執行（可退回 WebAssembly），在 Firefox 上透過 WebAssembly 執行。你的頁面永遠不會離開你的裝置。
- 只有翻譯後的文字會被傳送出去 — 只有擷取出的字串會傳送到你選擇的翻譯服務（Google / Gemini / Azure / 你本機的 LM Studio）。
- 無帳號、無追蹤、無遙測。所有設定和快取的模型都保留在瀏覽器的本機儲存空間中。

---

## 🚀 安裝

Chrome / Edge / Brave：

[從 Chrome Web Store 安裝](https://chromewebstore.google.com/detail/pndooikgcenncdohfggodonniihplppj) —— 一鍵安裝，自動更新。

Firefox:

[從 Firefox 附加元件安裝](https://addons.mozilla.org/en-US/firefox/addon/comic-translate-4-free/) — 一鍵安裝，自動更新。

安裝後，模型會在背景自動下載（約 350 MB：偵測器、OCR、修補器）。它們會快取在瀏覽器中，並按位元組大小驗證。如果翻譯在模型下載完成前開始，翻譯會等模型下載完成。


---

## 💡 使用方式

1. 先允許該網站 — 點擊擴充功能圖示，按允許此網站（或啟用允許所有網站）。翻譯只在你授予權限的地方執行。

   ![在彈出視窗中授權網站](../docs/images/popup.png)

2. 重新載入漫畫頁面 — 頁面載入時會自動開始翻譯。右上角的氣泡會顯示即時進度（Capturing → Detecting → OCR → …）。
3. 完成 — 頁面圖片會在原地取代為翻譯後的版本。

小提示：
- 在任意圖片上按右鍵 → 傳送到 Comic Translate 4 Free，只翻譯那張圖片。

  ![按右鍵傳送圖片](../docs/images/right-click.png)

- 如果網站封鎖下載（HTTP 403），擴充功能會自動透過背景分頁重試。
- 在設定中選擇你的翻譯引擎：Google Translator（不需金鑰）、Gemini（需要金鑰，建議使用——漫畫翻譯效果更好）、Azure Translator（即將停用）或 LM Studio（本機伺服器）。

---

## 🔑 取得 Gemini API 金鑰

Gemini 的漫畫翻譯效果最好。要將其用作翻譯引擎：

1. 開啟 [Google AI Studio](https://aistudio.google.com/apikey)，點選「Create API key」
2. 如果被要求，請選擇或建立 Google Cloud 專案
3. 複製金鑰
4. 把它貼到擴充功能設定中的 Gemini API 金鑰欄位，然後點選「檢查 Gemini 連線」
5. 在設定中選擇 Gemini 作為翻譯引擎。

---

## 💎 Pro

當任何 Pro 功能開啟時，翻譯會計入每天免費的 50 張圖片。一張圖片計為一張，無論它有多高。關閉兩個 Pro 功能後，翻譯即免費且無限量。自動翻譯和預先翻譯是 Pro 功能——每天免費 50 張圖片，訂閱 Pro 後無限量。

- $3/月或 $30/年
- 購買授權金鑰，將其貼到擴充功能設定中的 License key 欄位，然後點選 Activate Pro。該金鑰可在 2 個瀏覽器上使用。
- 當你達到 50 張圖片的免費上限時，彈出視窗每天會提醒你一次。給擴充功能評分後，Get Pro 會變成「Copy Discount Code: 5STARS」——點按它即可複製折扣碼並開啟結帳頁面。

---

## ⚠️ 已知問題

- 暫無韓語 OCR — 來源語言為日語、英語和簡體/繁體中文。（韓語仍可作為翻譯目標語言使用。）
- 大型工作階段 — 在一次工作階段翻譯數十張圖片，可能會在背景重新啟動擴充功能。若發生這種情況，執行會自動從中止處繼續。
- Firefox — 模型在背景頁面中執行（沒有離屏文件），與其他所有內容共用記憶體。如果看到「no available backend found」，請重新啟動瀏覽器。
- Firefox 比 Chrome 慢 — Firefox 擴充功能無法使用共享記憶體進行多執行緒處理（SharedArrayBuffer），因此模型只在一個 CPU 執行緒上執行。這是 Firefox 平台的限制，不是擴充功能的錯誤。([Mozilla 錯誤 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477))
- Google Translator 使用非官方免費端點，可能會受到速率限制。

---

## 📄 第三方聲明

本專案受 [ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) 啟發 — 氣泡/文字偵測器和漫畫微調的 LaMa 修補器是它的 ONNX 匯出，推論邏輯也是從它移植而來。（OCR 使用 genshiai-daichi 的 [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr)。）

捆綁的程式庫、移植的程式碼和執行時下載的模型及其授權列在 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) 中。

PolyForm Noncommercial License 1.0.0 — 見 [LICENSE](../LICENSE)。
