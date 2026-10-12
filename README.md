# Auto-Archiver — extension Chrome

Archive la vidéo de l'onglet courant via **yt-dlp** et en génère l'empreinte
**SHA-256** — les techniques de [bellingcat/auto-archiver](https://github.com/bellingcat/auto-archiver)
traduites en extension Chrome MV3.

## Principe

L'extension ne scrape pas le DOM : elle confie l'URL de la page à yt-dlp
(« generic_extractor » d'auto-archiver), qui sait résoudre n'importe quelle
plateforme. La page n'est qu'une source d'URL ; les cookies de l'onglet sont
transmis pour les pages derrière login.

```
Onglet courant (URL + cookies)
   │  🔬 Analyser          →  yt-dlp -J        (lecture seule, non bloquant)
   │  ⬇ Archiver           →  boîte « Enregistrer sous » (Windows)
   │                        →  yt-dlp bestvideo+bestaudio → remux MP4
   └  ✓ résultat           →  SHA-256 du fichier final
                              →  <nom>.hash.txt (empreinte + source + date)
```

### Étapes auto-archiver reprises

| auto-archiver | ici |
|---|---|
| `generic_extractor` (yt-dlp) | le host natif pilote `yt-dlp -J` + `yt-dlp -f bestvideo+bestaudio/best --remux-video mp4` |
| `hash_enricher` (SHA-256) | le host calcule le SHA-256 du fichier final (blocs de 1 Mo) et écrit le sidecar `.hash.txt` |
| `feeder` (URL) | l'onglet courant (pas de CSV en v1) |
| `local_storage` | boîte « Enregistrer sous » Windows (PowerShell SaveFileDialog) |
| retry anti-bot | backoff 2/4/6 s sur erreurs transitoires (même heuristique que mp4-downloader) |

### Titre + vignette (reel Instagram)

Le titre affiché est **la légende du post** (`description`), pas le titre
yt-dlp générique (« Video by x ») — c'est le vrai titre d'un reel. La **vignette**
est le `thumbnail` renvoyé par yt-dlp. Le nom de fichier suit la légende.

**Spécificité Instagram** : yt-dlp ne renvoie ni `duration` ni `filesize` pour
les reels. La **durée** est donc lue en fallback dans le paramètre `efg`
(base64 JSON) des URLs CDN (`duration_s`) — voir `_duration_from_efg` (Python)
/ `durationFromEfg` (Node). Le poids, absent, est simplement masqué dans la
popup.

**Pas repris (choix v1)** : rapport HTML, Wayback Machine (clé IA déjà notée),
commentaires/sous-titres, stockage multi-emplacements.

## Architecture (pattern mp4-downloader v4)

```
Chrome (MV3)                                   Windows
┌─────────────────────────────┐   Native Messaging (stdio, trames
│ popup.html / popup.js        │   [uint32 LE][JSON])
│ background.js  (service      │◄────────────────────────────────────►  auto-archiver-host.exe
│   worker, connectNative)     │   HKCU\Software\Google\Chrome\          (Node SEA OU PyInstaller,
│   permissions: tabs,cookies, │   NativeMessagingHosts\                 --noconsole)
│   nativeMessaging            │   auto_archiver_native_host             └ yt-dlp (PATH)
└─────────────────────────────┘                                         └ ffmpeg (~/.mp4down/bin)
                                                                        └ PowerShell (boîte save)
                                                                        ~/.auto-archiver/bin/
```

- Le **host est non-bloquant** : `info`/`download` répondent `{ id }`
  immédiatement ; le travail tourne en tâche asynchrone (Node) ou dans un
  thread (Python) ; la popup **poll** `status` (règle d'or MV3 : ne jamais
  bloquer la réponse initiale).
- **Deux moteurs host, même protocole** :
  - **Node SEA (v2, défaut)** — `host-native/*.cjs` → esbuild → blob SEA →
    postject : un `.exe` autonome (~89 Mo, runtime Node embarqué).
  - **Python (v1)** — `native_host.py` → PyInstaller `--noconsole` (~9 Mo).
  Les deux parlent exactement le même RPC (`health`/`info`/`download`/
  `status`/`cancel`) : l'extension est identique, seule la source du host
  change. `install.ps1 -Engine node|python` bascule.
- **Enregistrement registre** : Chrome lit les hosts comme **VALEURS
  REG_SZ** directement sous `HKCU\Software\Google\Chrome\NativeMessagingHosts`
  (nom de la valeur = nom du host). Une *sous-clé* avec valeur par défaut
  est **invisible** pour Chrome → `connectNative` échoue avec « Invalid
  native messaging host name specified » (bug corrigé le 25/09/2026,
  même forme que mp4-downloader).
- `--noconsole` PyInstaller / SEA sans console est **obligatoire** (console
  buffer stdin par blocs de 4 Ko → le host bloquerait sur la 1re trame).
- Le lecteur de trames lit dès que des octets sont disponibles (jamais une
  lecture « n octets complets » qui bloquerait sur un pipe jamais refermé).

## Build SEA — pièges validés (29/09/2026)

Le pipeline est dans `build-sea.mjs` (esbuild → `--experimental-sea-config`
→ copie de `node.exe` → `postject`). Ce qui a cassé et comment c'est géré :

1. **Le sentinel de la doc est faux pour ce build.** Le fuse de
   `node.exe` v24.19.0 (WinGet) est
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` (pas `…c292`).
   `build-sea.mjs` le **détecte** dans le binaire : `NODE_SEA_FUSE_` +
   32 hex — il ne faut PAS chercher le 0x00 (le fuse est suivi de
   `:0.src` non terminé dans le binaire, d'où les faux positifs).
2. **`require()` relatif ne fonctionne pas dans un SEA** (`ERR_UNKNOWN_
   BUILTIN_MODULE`) → le bundle esbuild (un seul `.cjs`) est obligatoire.
3. **L'étape `NODE_SEA_FUSE_V1` est facultative** quand l'exe est signé :
   l'injection du blob suffit, l'exe démarre (validé au spike).
4. **L'injection du blob n'est PAS à tolérer** : avec `allowFail` le build
   « passait » en silence avec un node.exe brut (qui parsait le stdin en
   script). Le smoke test interne (`health`) est le garde-fou.

## Installation

Prérequis : `yt-dlp` (pip), `ffmpeg.exe` (réutilisé depuis `~/.mp4down/bin/`
de MP4 Downloader, sinon à fournir). Moteur **node** : `node` (v20+) dans
le PATH (`winget install OpenJS.NodeJS.LTS`). Moteur **python** : Python
3.10+ et `pyinstaller`.

```powershell
cd C:\Users\gry\.claude\Claudy\auto-archiver-extension
powershell -ExecutionPolicy Bypass -File install.ps1                # host Node (défaut)
powershell -ExecutionPolicy Bypass -File install.ps1 -Engine python # host Python (v1)
```

Puis :
1. Fermer **toutes** les fenêtres Chrome (cache des hosts).
2. `chrome://extensions/` → Mode développeur → **Charger l'extension non empaquetée** → ce dossier.
3. **Vérifier l'ID** de l'extension (visible sur sa carte) : il est
   déterministe depuis le **chemin** du dossier (sha256 UTF-16LE du chemin
   → 32 lettres a-p) — pour ce dossier il vaut
   `bjhpppaijndghboidohfgmamfelbbefi`, déjà écrit dans `install.ps1` et
   `native-host-manifest.json`. Il ne change que si le dossier est déplacé.
   ⚠️ Ne pas confondre avec `egnlidcigkbklfnmlkeklekcdppjgfhj`, l'ID de
   **mp4-downloader** (erreur corrigée le 25/09/2026).
4. Ouvrir la popup : le badge doit afficher **host OK**.

L'installateur inclut un **smoke test** : il envoie une trame `health` au
host installé et vérifie la réponse avant de se terminer.

Désinstallation : `install.ps1 -Uninstall` (+ retirer l'extension de
`chrome://extensions/`).

## Tests (Node, sans Chrome)

`npm test` — 27 tests, 3 suites :

- **framing** : codec NMH — aller-retour, trame partielle octet par octet,
  trames multiples dans un chunk, payload 2 Mo, UTF-8 accents, trame
  corrompue (longueur folle → reset puis reprise).
- **média** : SHA-256 (vecteurs FIPS 180 + gros fichier en blocs 1 Mo),
  sidecar `.hash.txt`, sanitize, cookies Netscape (7 colonnes), `ytClientArgs`,
  `durationFromEfg` (fallback Instagram), `pickBest`, `findOutputFile`,
  heuristique transitoire.
- **E2E aller-retour** : lance le host **SEA réel** (`dist/auto-archiver-
  host.exe`) et joue le protocole comme `chrome.runtime.connectNative` :
  handshake `_init` → `health` (engine node) → `info` (URL factice `.invalid`,
  réponse `{ id }` immédiate < 3 s, polling `status` → `error` remonté) →
  `download` (dialogue annulé → état « annulé ») → erreurs RPC (URL
  manquante, méthode inconnue) → trames partielles/multiples (ids 100/101/102)
  → gros payload (~60 Ko de cookies) → 12 `status` parallèles.

`npm run build:sea` reconstruit le SEA (esbuild → blob → postject → smoke).

## Fichiers

| Fichier | Rôle |
|---|---|
| `manifest.json` | MV3, permissions minimales (tabs, cookies, storage, nativeMessaging) |
| `background.js` | service worker : transport native messaging + onglet + cookies |
| `popup.html/css/js` | UI : onglet, analyse, progression, SHA-256 |
| `host-native/*.cjs` | **host Node (v2)** : framing, tasks, workers, save-dialog, media, host |
| `native_host.py` | **host Python (v1)** : source unique de l'exe PyInstaller |
| `build-sea.mjs` | pipeline SEA (esbuild → blob → postject → smoke test) |
| `install.ps1` | `-Engine node\|python` : build + manifest + registre HKCU + smoke |
| `test/client.cjs` | client NMH de test (même contrat que connectNative) |
| `test/test-*.cjs` | suites framing / média / E2E (27 tests) |
| `make_icons.py` | génère les icônes PNG |

## Limites connues

- **Boîte « Enregistrer sous »** : la fenêtre PowerShell peut s'ouvrir
  *derrière* Chrome (un process non au premier plan n'a pas le droit Windows
  de se placer devant — même piège que mp4-downloader, qui l'a corrigé avec
  `AttachThreadInput`). v1 : la tâche attend la boîte ; si rien ne s'affiche,
  vérifier la barre des tâches.
- L'ID d'extension en dev peut changer (réimport de profil) → ré-exécuter
  `install.ps1`.
- YouTube : `player_client=default,android` + retry transitoires (heuristique
  mp4-downloader). Les vidéos protégées/limitées restent hors de portée.
- SEA (~89 Mo) vs PyInstaller (~9 Mo) : le SEA embarque le runtime Node
  (aucune dépendance) ; le Python est plus léger mais nécessite la chaîne
  Python/PyInstaller au build.
