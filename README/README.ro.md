# comic-translate-4-free

Limba: [English](../README.md) · [हिन्दी](README.hi.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Español](README.es.md) · [العربية](README.ar.md) · [Français](README.fr.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [Deutsch](README.de.md) · [Română](README.ro.md)

Citește manga în limba ta!
comic-translate-4-free traduce automat manga și benzi desenate în timp ce navighezi. Citește japoneză, engleză, chineză simplificată/tradițională (detectare automată) și traduce în 114 limbi, înlocuind imaginea chiar acolo.

### 📸 Înainte și după

| Înainte (japoneză) | După (engleză) |
| --- | --- |
| ![Pagina originală de manga în japoneză](../docs/images/wikipe-tan-original.jpg) | ![Tradusă în engleză](../docs/images/wikipe-tan-en.jpg) |

<details>
<summary>Vezi traducerile în alte 14 limbi</summary>

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

*Ilustrația originală Wikipe-tan de Kasuga, din [articolul Manga din Wikipedia](https://en.wikipedia.org/wiki/Manga) via Wikimedia Commons — licențiată sub [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Capturile de ecran traduse sunt derivate modificate ale originalului.*

---

## ✨ Funcții

- Traducere automată — deschide o pagină de manga pe un site permis, iar versiunea tradusă apare chiar acolo, fără să fie nevoie să apeși vreun buton.
- Fiecare imagine de pe pagină — traducerea automată gestionează toate imaginile de pe o pagină (până la 50 pe rulare), nu doar imaginea principală.
- Pretradu pagina următoare — în timp ce citești pagina curentă, imaginea paginii următoare este tradusă în fundal, așa că e gata în momentul în care o deschizi (o singură imagine; activat implicit, se poate opri din Setări).
- Clic dreapta pe orice imagine — alege „Trimite la comic-translate-4-free” pentru a traduce o anumită imagine, chiar și una mai mică decât dimensiunea minimă.
- 114 limbi țintă prin Google Translate, Gemini, Azure Translator sau propriul tău server local LM Studio.
- Detectare automată a limbii sursă — japoneza, engleza, chineza simplificată/tradițională sunt identificate automat din textul recunoscut prin OCR.
- Suport pentru benzi lungi / webtoon — paginile înalte sunt procesate în segmente care se suprapun, astfel încât textul rămâne clar.
- 17 limbi pentru interfață — interfața extensiei urmează setarea de limbă a browserului tău.
- Limba țintă urmează implicit limba browserului tău — o poți schimba oricând din Setări.

### 🔒 Confidențialitate

- AI-ul rulează pe calculatorul tău. Detectarea bulelor, OCR-ul și inpainting-ul rulează toate local, în browserul tău. Detectarea și OCR-ul rulează prin WebAssembly. Inpainting-ul rulează pe GPU în Chrome (cu revenire la WebAssembly), iar în Firefox prin WebAssembly. Paginile tale nu părăsesc niciodată dispozitivul tău.
- Doar textul tradus este trimis mai departe — doar șirurile de text extrase ajung la serviciul de traducere pe care îl alegi (Google / Gemini / Azure / LM Studio local).
- Fără cont, fără urmărire, fără telemetrie. Toate setările și modelele stocate în cache rămân în stocarea locală a browserului tău.

---

## 🚀 Instalare

Chrome / Edge / Brave:

[Instalează din Chrome Web Store](https://chromewebstore.google.com/detail/pndooikgcenncdohfggodonniihplppj) — un clic, actualizări automate.

Firefox:

[Instalează din Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/comic-translate-4-free/) — un clic, actualizări automate.

După instalare, modelele se descarcă automat în fundal (~350 MB: detector, OCR, inpainter). Sunt stocate în cache în browser și verificate după dimensiunea în octeți. Dacă o traducere începe înainte ca modelele să termine descărcarea, ea așteaptă.


---

## 💡 Cum se folosește

1. Permite mai întâi site-ul — apasă pe pictograma extensiei și apasă Permite acest site (sau activează Permite toate site-urile). Traducerea rulează doar unde ai acordat permisiunea.

   ![Allow the site from the popup](../docs/images/popup.png)

2. Reîncarcă pagina de manga — începe să traducă automat când se încarcă pagina. O bulină în colțul din dreapta sus arată progresul live (Capturing → Detecting → OCR → …).
3. Gata — imaginile paginii sunt înlocuite chiar acolo cu versiunile traduse.

Sfaturi:
- Clic dreapta pe orice imagine → Trimite la comic-translate-4-free pentru a traduce doar acea imagine.

  ![Right-click to send an image](../docs/images/right-click.png)

- Dacă un site blochează descărcările (HTTP 403), extensia încearcă din nou automat printr-o filă de fundal.
- Alege motorul de traducere în Setări: Google (gratuit, fără cheie), Gemini (cheie API gratuită — traducere manga mai bună, recomandată), Azure Translator (în curs de retragere — 2 milioane de caractere/lună gratuit), sau LM Studio (server local).
- Activează Mod depanare (inspector de etape) în Setări pentru a inspecta fiecare etapă a procesului.

---

## 🔑 Obține o cheie API Gemini

Gemini oferă cele mai bune traduceri de manga. Pentru a-l folosi ca motor de traducere:

1. Deschide [Google AI Studio](https://aistudio.google.com/apikey) și apasă „Create API key” — gratuit, nu este nevoie de card de credit
2. Alege sau creează un proiect Google Cloud, dacă ți se cere
3. Copiază cheia
4. Lipește-o în câmpul Cheie API Gemini din Setările extensiei, apoi apasă „Verifică conexiunea Gemini”
5. Alege Gemini (gratuit, necesită cheie) ca motor de traducere în Setări

---

## ❤️ Sprijină acest proiect

Dacă această extensie îți este utilă, ia în considerare sprijinirea dezvoltării sale:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/S5X627XJQW)

---

## ⚠️ Probleme cunoscute

- Încă nu există OCR pentru coreeană — limbile sursă sunt japoneza, engleza și chineza simplificată/tradițională. (Coreeana rămâne disponibilă ca limbă de traducere.)
- Sesiuni mari — traducerea a zeci de imagini într-o singură sesiune poate reporni extensia în fundal. Dacă se întâmplă asta, rularea reia automat de unde a rămas.
- Firefox — modelele rulează în pagina de fundal (fără documente offscreen), împărțind memoria cu toate celelalte. Repornește browserul dacă vezi mesajul „no available backend found”.
- Firefox este mai lent decât Chrome — extensiile Firefox nu pot folosi memoria partajată pentru multi-threading (SharedArrayBuffer), așa că modelul rulează pe un singur fir CPU. Aceasta este o limită a platformei Firefox, nu o eroare a extensiei. ([Bug Mozilla 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)).
- Google Translate folosește endpointul gratuit neoficial și poate fi limitat ca rată.

---

## 📄 Note privind terții

Acest proiect este inspirat de [ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) — detectorul de bule/text și inpainterul LaMa antrenat pe manga sunt exporturile sale ONNX, iar logica de inferență este portată de acolo. (OCR-ul folosește [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr) de genshiai-daichi.)

Bibliotecile incluse, codul portat și modelele descărcate la rulare sunt listate cu licențele lor în [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

PolyForm Noncommercial License 1.0.0 — vezi [LICENSE](../LICENSE).
