# Comic Translate 4 Free

Sprache: [English](../README.md) · [हिन्दी](README.hi.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Español](README.es.md) · [العربية](README.ar.md) · [Français](README.fr.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [Deutsch](README.de.md) · [Română](README.ro.md)

Lies Manga in deiner Sprache — direkt im Browser.

Comic Translate 4 Free übersetzt Manga- und Comicseiten automatisch beim Surfen. Es liest Japanisch, Englisch, Vereinfachtes und Traditionelles Chinesisch (mit Auto-Erkennung) und übersetzt in 114 Sprachen. Öffne eine Seite, und die übersetzte Version ersetzt das Originalbild an Ort und Stelle — die Sprechblasen sind mit deiner Sprache gefüllt.

### 📸 Vorher & Nachher

| Vorher (Japanisch) | Nachher (Deutsch) |
| --- | --- |
| ![Japanische Manga-Originalseite](../docs/images/wikipe-tan-original.jpg) | ![Ins Deutsche übersetzt](../docs/images/wikipe-tan-de.jpg) |

<details>
<summary>See translations in 14 more languages</summary>

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

*Original-Wikipe-tan-Illustration von Kasuga, aus [Wikipedias Manga-Artikel](https://en.wikipedia.org/wiki/Manga) via Wikimedia Commons — lizenziert unter [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Die übersetzten Screenshots sind bearbeitete abgeleitete Werke des Originals.*

---

## ✨ Funktionen

- Automatische Übersetzung (Pro) — öffne eine Mangaseite auf einer erlaubten Website, und die übersetzte Version erscheint an Ort und Stelle, ganz ohne Klick. Kostenlos für 50 Bilder pro Tag; unbegrenzt mit Pro.
- Jedes Bild auf der Seite — die automatische Übersetzung verarbeitet alle Bilder einer Seite (bis zu 50 pro Durchlauf), nicht nur das Hauptbild.
- Nächste Seite vorab übersetzen (Pro) — während du die aktuelle Seite liest, wird das Bild der nächsten Seite im Hintergrund übersetzt und ist bereit, sobald du sie öffnest (nur ein Bild; standardmäßig an, in den Einstellungen abschaltbar). Kostenlos für 50 Bilder pro Tag; unbegrenzt mit Pro.
- Engine-Failover — wenn die gewählte Übersetzungs-Engine fehlschlägt oder Text in der falschen Sprache liefert, versucht die Erweiterung automatisch eine andere. Kostenlos, immer an.
- OCR (testing) — eine schnelle Test-OCR-Engine für japanische Seiten. Schalte sie in den Einstellungen unter Debug ein. Auf Handys deutlich schneller.
- Ein Tab nach dem anderen — während ein Tab übersetzt, ist „Translate" im anderen Tab ausgegraut. Der Abbrechen-Button heißt „Cancel other tab".
- Rechtsklick auf ein beliebiges Bild — wähle „An Comic Translate 4 Free senden“, um ein bestimmtes Bild zu übersetzen, auch wenn es kleiner als die Mindestgröße ist.
- 114 Zielsprachen über Google Translator, Gemini, Azure Translator oder deinen eigenen lokalen LM-Studio-Server.
- Automatische Quellspracherkennung — Japanisch, Englisch, Vereinfachtes/Traditionelles Chinesisch werden automatisch aus dem per OCR gelesenen Text erkannt.
- Unterstützung für lange Strips / Webtoons — hohe Seiten werden in überlappenden Abschnitten verarbeitet, damit der Text scharf bleibt.
- 17 UI-Sprachen — die Oberfläche der Erweiterung folgt der Spracheinstellung deines Browsers.
- Die Zielsprache ist standardmäßig die Sprache deines Browsers — du kannst sie jederzeit in den Einstellungen ändern.

### 🔒 Datenschutz

- Die KI läuft auf deinem Rechner. Blasenerkennung, OCR und Inpainting laufen alle lokal in deinem Browser. Erkennung und OCR laufen über WebAssembly. Inpainting läuft in Chrome auf der GPU (mit WebAssembly-Fallback) und in Firefox über WebAssembly. Deine Seiten verlassen dein Gerät nie.
- Nur übersetzter Text wird nach außen gesendet — nur die extrahierten Zeichenketten gehen an den Übersetzungsdienst deiner Wahl (Google / Gemini / Azure / dein lokales LM Studio).
- Kein Konto, kein Tracking, keine Telemetrie. Alle Einstellungen und zwischengespeicherten Modelle bleiben im lokalen Speicher deines Browsers.

---

## 🚀 Installation

Chrome / Edge / Brave:

[Im Chrome Web Store installieren](https://chromewebstore.google.com/detail/pndooikgcenncdohfggodonniihplppj) — mit einem Klick und automatischen Updates.

Firefox:

[Aus Firefox Add-ons installieren](https://addons.mozilla.org/en-US/firefox/addon/comic-translate-4-free/) — ein Klick, automatische Updates.

Nach der Installation laden die Modelle automatisch im Hintergrund herunter (~350 MB: Detektor, OCR, Inpainter). Sie werden im Browser zwischengespeichert und anhand der Byte-Größe geprüft. Beginnt eine Übersetzung, bevor sie fertig sind, wartet sie, bis sie da sind.


---

## 💡 So benutzt du es

1. Erlaube zuerst die Website — klicke auf das Erweiterungssymbol und drücke Diese Website zulassen (oder aktiviere Alle Websites zulassen). Die Übersetzung läuft nur dort, wo du die Erlaubnis erteilt hast.

   ![Die Website über das Popup freigeben](../docs/images/popup.png)

2. Lade die Mangaseite neu — sie beginnt automatisch zu übersetzen, sobald die Seite lädt. Eine Pille oben rechts zeigt den Live-Fortschritt (Capturing → Detecting → OCR → …).
3. Fertig — die Bilder der Seite werden an Ort und Stelle durch die übersetzten Versionen ersetzt.

Tipps:
- Rechtsklick auf ein beliebiges Bild → An Comic Translate 4 Free senden, um nur dieses Bild zu übersetzen.

  ![Rechtsklick, um ein Bild zu senden](../docs/images/right-click.png)

- Wenn eine Website Downloads blockiert (HTTP 403), versucht es die Erweiterung automatisch über einen Hintergrund-Tab erneut.
- Wähle deine Übersetzungs-Engine in den Einstellungen: Google Translator (kostenlos, kein Schlüssel), Gemini (Schlüssel erforderlich, empfohlen — bessere Manga-Übersetzung), Azure Translator (wird eingestellt) oder LM Studio (lokaler Server).

---

## 🔑 Gemini-API-Schlüssel erhalten

Gemini liefert die besten Manga-Übersetzungen. Um es als Übersetzungs-Engine zu verwenden:

1. Öffne [Google AI Studio](https://aistudio.google.com/apikey) und klicke auf „Create API key“
2. Wähle ein Google-Cloud-Projekt aus oder erstelle eins, falls danach gefragt wird
3. Kopiere den Schlüssel
4. Füge ihn in das Feld Gemini-API-Schlüssel in den Einstellungen der Erweiterung ein und klicke dann auf „Gemini-Verbindung prüfen“
5. Wähle Gemini als Übersetzungs-Engine in den Einstellungen

---

## 💎 Pro

Übersetzungen zählen zum kostenlosen Limit von 50 Bildern pro Tag, solange eine Pro-Funktion an ist. Ein Bild zählt als eins, egal wie hoch es ist. Schalte beide Pro-Funktionen aus, und das Übersetzen ist kostenlos und unbegrenzt. Automatisches Übersetzen und Vorab-Übersetzen sind Pro-Funktionen — kostenlos für 50 Bilder pro Tag, unbegrenzt mit einem Pro-Abo.

- $3/Monat oder $30/Jahr
- Kaufe einen Lizenzschlüssel, füge ihn in das Feld „License key" in den Einstellungen der Erweiterung ein und klicke auf „Activate Pro". Der Schlüssel funktioniert in 2 Browsern.
- Wenn du das kostenlose Limit von 50 Bildern erreichst, erinnert dich ein Popup einmal am Tag daran. Nachdem du die Erweiterung bewertet hast, wird aus Get Pro „Copy Discount Code: 5STARS" — tippe darauf, um den Code zu kopieren und den Checkout zu öffnen.

---

## ⚠️ Bekannte Probleme

- Noch kein koreanisches OCR — Quellsprachen sind Japanisch, Englisch und Vereinfachtes/Traditionelles Chinesisch. (Koreanisch bleibt als Übersetzungssprache verfügbar.)
- Große Sitzungen — das Übersetzen von Dutzenden Bildern in einer Sitzung kann die Erweiterung im Hintergrund neu starten. Wenn das passiert, wird der Lauf automatisch von dort fortgesetzt, wo er aufgehört hat.
- Firefox — die Modelle laufen auf der Hintergrundseite (ohne Offscreen-Dokumente) und teilen sich den Speicher mit allem anderen. Starte den Browser neu, wenn du „no available backend found“ siehst.
- Firefox ist langsamer als Chrome — Firefox-Erweiterungen können keinen gemeinsamen Speicher für Multithreading (SharedArrayBuffer) verwenden, daher läuft das Modell auf einem einzigen CPU-Thread. Das ist eine Grenze der Firefox-Plattform, kein Fehler der Erweiterung. ([Mozilla-Bug 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)).
- Google Translator nutzt den inoffiziellen kostenlosen Endpunkt und kann ratenbegrenzt sein.

---

## 📄 Hinweise zu Drittanbietern

Dieses Projekt ist inspiriert von [ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) — der Blasen-/Textdetektor und der manga-trainierte LaMa-Inpainter sind dessen ONNX-Exporte, und die Inferenzlogik ist daraus portiert. (OCR verwendet [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr) von genshiai-daichi.)

Gebündelte Bibliotheken, portierter Code und zur Laufzeit heruntergeladene Modelle sind mit ihren Lizenzen in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) aufgeführt.

PolyForm Noncommercial License 1.0.0 — siehe [LICENSE](../LICENSE).
