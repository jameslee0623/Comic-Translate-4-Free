# Comic Translate 4 Free

Langue : [English](../README.md) · [हिन्दी](README.hi.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [Español](README.es.md) · [العربية](README.ar.md) · [Français](README.fr.md) · [বাংলা](README.bn.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [اردو](README.ur.md) · [Deutsch](README.de.md) · [Română](README.ro.md)

Lisez des mangas dans votre langue — directement dans le navigateur.

Comic Translate 4 Free traduit automatiquement les pages de manga et de BD pendant que vous naviguez. Il lit le japonais, l'anglais et le chinois simplifié et traditionnel (avec détection automatique), et traduit vers 114 langues. Ouvrez une page, et la version traduite remplace l'image originale sur place — les bulles sont remplies de votre langue.

### 📸 Avant & Après

| Avant (japonais) | Après (français) |
| --- | --- |
| ![Page de manga japonaise d'origine](../docs/images/wikipe-tan-original.jpg) | ![Traduit en français](../docs/images/wikipe-tan-fr.jpg) |

<details>
<summary>Voir les traductions dans 14 autres langues</summary>

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

*Illustration Wikipe-tan originale par Kasuga, tirée de [l'article Manga de Wikipédia](https://en.wikipedia.org/wiki/Manga) via Wikimedia Commons — sous licence [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Les captures traduites sont des œuvres dérivées modifiées de l'original.*

---

## ✨ Fonctionnalités

- Traduction automatique (Pro) — ouvrez une page de manga sur un site autorisé et la version traduite apparaît sur place, sans avoir besoin de cliquer sur un bouton. Gratuit pour 50 images par jour ; illimité avec Pro.
- Chaque image sur la page — la traduction automatique gère toutes les images d'une page (jusqu'à 50 par exécution), pas seulement l'image principale.
- Prétraduire la page suivante (Pro) — pendant que vous lisez la page actuelle, l'image de la page suivante est traduite en arrière-plan, elle est donc prête dès que vous l'ouvrez (une seule image ; activé par défaut, désactivable dans les Réglages). Gratuit pour 50 images par jour ; illimité avec Pro.
- Bascule de moteur — si le moteur de traduction sélectionné échoue, ou renvoie du texte dans la mauvaise langue, l'extension essaie automatiquement un autre moteur. Gratuit, toujours activé.
- OCR (test) — un moteur OCR de test rapide pour les pages en japonais. Activez-le dans les Réglages, sous Débogage. Beaucoup plus rapide sur téléphone.
- Un onglet à la fois — pendant qu'un onglet traduit, le bouton Traduire de l'autre onglet est grisé. Annuler devient « Annuler l'autre onglet ».
- Clic droit sur n'importe quelle image — choisissez « Envoyer vers Comic Translate 4 Free » pour traduire une image précise, même si elle est plus petite que la taille minimale.
- 114 langues cibles via Google Translator, Gemini, Azure Translator ou votre propre serveur local LM Studio.
- Détection automatique de la langue source — le japonais, l'anglais, le chinois simplifié/traditionnel sont identifiés automatiquement à partir du texte lu par OCR.
- Prise en charge des longues bandes / webtoons — les pages hautes sont traitées en segments qui se chevauchent pour que le texte reste net.
- 17 langues d'interface — l'interface de l'extension suit le réglage de langue de votre navigateur.
- La langue cible est par défaut celle de votre navigateur — changez-la à tout moment dans Paramètres.

### 🔒 Confidentialité

- L'IA tourne sur votre machine. La détection des bulles, l'OCR et l'inpainting tournent tous localement dans votre navigateur. La détection et l'OCR tournent via WebAssembly. L'inpainting tourne sur GPU dans Chrome (avec repli WebAssembly), et via WebAssembly dans Firefox. Vos pages ne quittent jamais votre appareil.
- Seul le texte traduit est envoyé — seules les chaînes extraites vont vers le service de traduction que vous choisissez (Google / Gemini / Azure / votre LM Studio local).
- Aucun compte, aucun suivi, aucune télémétrie. Tous les réglages et modèles en cache restent dans le stockage local de votre navigateur.

---

## 🚀 Installation

Chrome / Edge / Brave :

[Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/pndooikgcenncdohfggodonniihplppj) — en un clic, avec mises à jour automatiques.

Firefox :

[Installer depuis Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/comic-translate-4-free/) — en un clic, mises à jour automatiques.

Après l'installation, les modèles se téléchargent automatiquement en arrière-plan (~350 Mo : détecteur, OCR, inpainter). Ils sont mis en cache dans le navigateur et vérifiés par taille en octets. Si une traduction commence avant qu'ils soient téléchargés, elle attend.


---

## 💡 Comment l'utiliser

1. Autorisez d'abord le site — cliquez sur l'icône de l'extension et appuyez sur Autoriser ce site (ou activez Autoriser tous les sites). La traduction ne s'exécute que là où vous avez accordé l'autorisation.

   ![Autoriser le site depuis la fenêtre popup](../docs/images/popup.png)

2. Rechargez la page de manga — elle commence à traduire automatiquement quand la page se charge. Une pastille en haut à droite montre la progression en direct (Capturing → Detecting → OCR → …).
3. Terminé — les images de la page sont remplacées sur place par les versions traduites.

Conseils :
- Clic droit sur n'importe quelle image → Envoyer vers Comic Translate 4 Free pour traduire juste cette image.

  ![Clic droit pour envoyer une image](../docs/images/right-click.png)

- Si un site bloque les téléchargements (HTTP 403), l'extension réessaie automatiquement via un onglet en arrière-plan.
- Choisissez votre moteur de traduction dans Paramètres : Google Translator (sans clé), Gemini (clé requise, recommandé — meilleure traduction de mangas), Azure Translator (en cours de retrait) ou LM Studio (serveur local).

---

## 🔑 Obtenir une clé API Gemini

Gemini offre les meilleures traductions de manga. Pour l'utiliser comme moteur de traduction :

1. Ouvrez [Google AI Studio](https://aistudio.google.com/apikey) et cliquez sur « Créer une clé API »
2. Choisissez ou créez un projet Google Cloud si demandé
3. Copiez la clé
4. Collez-la dans le champ « Clé API Gemini » dans les Paramètres de l'extension, puis cliquez sur « Vérifier la connexion Gemini »
5. Sélectionnez Gemini comme moteur de traduction dans Paramètres

---

## 💎 Pro

Les traductions comptent dans le quota gratuit de 50 images par jour tant qu'une fonctionnalité Pro est activée. Une image compte pour une, quelle que soit sa hauteur. Désactivez les deux fonctionnalités Pro et la traduction est gratuite et illimitée. La traduction automatique et la prétraduction sont des fonctionnalités Pro — gratuites pour 50 images par jour, illimitées avec un abonnement Pro.

- 3 $/mois ou 30 $/an
- Achetez une clé de licence, collez-la dans le champ « Clé de licence » dans les Paramètres de l'extension, et cliquez sur Activer Pro. La clé fonctionne sur 2 navigateurs.
- Quand vous atteignez la limite gratuite de 50 images, une fenêtre contextuelle vous le rappelle une fois par jour. Après avoir noté l'extension, le bouton Obtenir Pro devient « Copier le code de réduction : 5STARS » — touchez-le pour copier le code et ouvrir la page de paiement.

---

## ⚠️ Problèmes connus

- Pas encore d'OCR coréen — les langues sources sont le japonais, l'anglais et le chinois simplifié/traditionnel. (Le coréen reste disponible comme langue de traduction.)
- Grosses sessions — traduire des dizaines d'images en une session peut redémarrer l'extension en arrière-plan. Si cela arrive, l'exécution reprend automatiquement là où elle s'était arrêtée.
- Firefox — les modèles tournent dans la page d'arrière-plan (sans documents offscreen), en partageant la mémoire avec tout le reste. Redémarrez le navigateur si vous voyez « no available backend found ».
- Firefox est plus lent que Chrome — les extensions Firefox ne peuvent pas utiliser la mémoire partagée pour le multithreading (SharedArrayBuffer), donc le modèle tourne sur un seul thread CPU. C'est une limite de la plateforme Firefox, pas un bug de l'extension. ([Bug Mozilla 1673477](https://bugzilla.mozilla.org/show_bug.cgi?id=1673477)).
- Google Translator utilise le point de terminaison gratuit non officiel et peut être limité en débit.

---

## 📄 Avis de tiers

Ce projet s'inspire de [ogkalu2/comic-translate](https://github.com/ogkalu2/comic-translate) — le détecteur de bulles/texte et l'inpainter LaMa entraîné sur le manga sont ses exports ONNX, et la logique d'inférence en est portée. (L'OCR utilise [Baberu](https://huggingface.co/genshiai-daichi/baberu-ocr) de genshiai-daichi.)

Les bibliothèques incluses, le code porté et les modèles téléchargés à l'exécution sont listés avec leurs licences dans [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

PolyForm Noncommercial License 1.0.0 — voir [LICENSE](../LICENSE).
