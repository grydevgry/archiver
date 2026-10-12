// ===================================================================
// Auto-Archiver — popup
//
// Flux (comme auto-archiver) :
//   onglet courant -> 🔬 analyse (yt-dlp -J, lecture seule) ->
//   ⬇ Archiver (boîte « Enregistrer sous » + yt-dlp) -> SHA-256
//
// Le host est NON-BLOQUANT : « info »/« download » répondent { id }
// immédiatement ; le travail tourne dans un thread du host. Le popup
// POLL « status » jusqu'à l'état terminal (done / error).
// ===================================================================

'use strict';

// --- DOM ---
const $ = (id) => document.getElementById(id);
const hostBadge = $('hostBadge');
const tabUrl = $('tabUrl');
const infoSection = $('infoSection');
const infoThumb = $('infoThumb');
const infoTitle = $('infoTitle');
const infoMeta = $('infoMeta');
const infoDesc = $('infoDesc');
const refineWaiting = $('refineWaiting');
const refineLine = $('refineLine');
const infoError = $('infoError');
const progressSection = $('progressSection');
const progressFill = $('progressFill');
const progressLabel = $('progressLabel');
const progressLine = $('progressLine');
const resultSection = $('resultSection');
const resultOk = $('resultOk');
const resultErr = $('resultErr');
const resultPath = $('resultPath');
const resultErrorMsg = $('resultErrorMsg');
const hashValue = $('hashValue');
const copyHashBtn = $('copyHash');
const btnInfo = $('btnInfo');
const btnDownload = $('btnDownload');
const btnCancel = $('btnCancel');
const statusBar = $('statusBar');

// --- état ---
let tab = null;          // { url, title, cookies }
let busy = false;        // analyse OU download en cours
let pollTimer = null;
let lastId = null;       // id de la tâche en cours (annulation)

// ===================================================================
// Message bus -> background
// ===================================================================

function sendBg(type, extra) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), (resp) => {
        void chrome.runtime.lastError; // absorber
        resolve(resp || { ok: false, error: 'pas de réponse' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
    }
  });
}

function setStatus(text) {
  statusBar.textContent = text || '';
  statusBar.classList.toggle('hidden', !text);
}

function fmtBytes(n) {
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' Ko';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
}

// ===================================================================
// Démarrage : état du host + onglet courant
// ===================================================================

async function init() {
  const h = await sendBg('aa_health');
  if (h && h.ok) {
    const tools = h.tools || {};
    // Host joignable : OK, MAIS si l'outil yt-dlp manque, l'analyse
    // échouerait systématiquement → badge d'alerte plutôt que « OK »
    // trompeur.
    if (tools.ytdlp === false) {
      hostBadge.textContent = 'host OK · yt-dlp ✗';
      hostBadge.classList.add('err');
      hostBadge.title = 'Host joignable mais yt-dlp introuvable sur le PATH. '
        + 'Installez yt-dlp (pip install yt-dlp) puis réessayez.';
      setStatus('yt-dlp introuvable — installez-le (pip install yt-dlp).');
    } else {
      hostBadge.textContent = 'host OK';
      hostBadge.classList.add('ok');
    }
  } else {
    hostBadge.textContent = 'host hors ligne';
    hostBadge.classList.add('err');
    hostBadge.title = 'Lancez l’installateur (install.ps1) puis redémarrez Chrome.';
    setStatus('Hôte local introuvable. Exécutez install.ps1 puis relancez Chrome.');
  }

  const t = await sendBg('aa_getTab');
  if (t && t.ok) {
    tab = t;
    tabUrl.textContent = t.url;
  } else {
    tabUrl.textContent = (t && t.error) || 'Aucune page.';
    btnInfo.disabled = true;
    btnDownload.disabled = true;
  }

  // Tâche en cours qui a survécu à la fermeture du popup → reprendre
  // le polling (sinon le téléchargement continuerait côté host sans
  // qu'on puisse le voir ni l'annuler).
  try {
    const active = await chrome.storage.local.get('aa_active');
    const act = active && active.aa_active;
    if (act && act.id) {
      busy = true;
      if (act.kind === 'info') {
        infoError.classList.add('hidden');
        refineWaiting.classList.remove('hidden');
      } else {
        progressSection.classList.remove('hidden');
      }
      startPoll(act.id, act.kind || 'info');
    }
  } catch (_) {}
}

// ===================================================================
// Polling d'une tâche (analyse OU download)
// ===================================================================

function startPoll(id, kind) {
  stopPoll();
  lastId = id;
  // Persiste l'id de tâche : si le popup est refermé/réouvert en cours de
  // téléchargement, le polling reprend et « Annuler » reste fonctionnel.
  try { chrome.storage.local.set({ aa_active: { id: id, kind: kind } }); } catch (_) {}
  pollTimer = setInterval(() => {
    sendBg('aa_status', { id: id }).then((s) => {
      if (!s || !s.ok || !s.snap) return;
      const snap = s.snap;

      // Pas de status valide → tâche inconnue (annulée, supprimée, ou hôte
      // redémarré). Le host répond { error:'inconnu' } sans status dans ce cas.
      if (!snap.status) {
        stopPoll();
        finishBusy('Tâche terminée (annulée ou hôte redémarré).');
        return;
      }
      // État intermédiaire : afficher progression / ligne
      if (snap.status !== 'done' && snap.status !== 'error') {
        paintProgress(snap, kind);
        return;
      }
      // État terminal
      stopPoll();
      try { chrome.storage.local.remove('aa_active'); } catch (_) {}
      if (snap.status === 'error') {
        if (kind === 'info') {
          refineWaiting.classList.add('hidden');
          showError(snap.error || 'Analyse en erreur.');
        } else {
          progressSection.classList.add('hidden');
          showFail(snap.error || 'Téléchargement échoué.');
        }
        finishBusy();
        return;
      }
      // done
      if (kind === 'info') {
        refineWaiting.classList.add('hidden');
        showInfo(snap);
        setStatus('Analyse terminée — « Archiver » pour télécharger + SHA-256.');
      } else {
        if (snap.ok) {
          showResult({ path: snap.path, sha256: snap.sha256 });
        } else {
          progressSection.classList.add('hidden');
          showFail(snap.error || 'Téléchargement échoué.');
        }
      }
      finishBusy();
    }).catch(() => {});
  }, 1000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function finishBusy(msg) {
  busy = false;
  btnInfo.disabled = false;
  btnDownload.disabled = false;
  btnCancel.disabled = true;
  if (msg) setStatus(msg);
}

function paintProgress(snap, kind) {
  if (kind === 'info') {
    // textContent : snap.line vient de yt-dlp (données non fiables),
    // jamais de HTML.
    refineLine.textContent = snap.line || 'Analyse…';
    return;
  }
  progressSection.classList.remove('hidden');
  let pct = 0, label = '…', line = snap.line || '';
  if (snap.status === 'queued') { line = 'En file d’attente…'; }
  else if (snap.status === 'choosing') { line = 'Boîte « Enregistrer sous » — choisissez l’emplacement.'; }
  else if (snap.status === 'running') { pct = snap.progress || 0; label = Math.floor(pct) + '%'; }
  else if (snap.status === 'converting') { pct = 100; line = 'Assemblage / remux MP4…'; }
  else if (snap.status === 'hashing') { pct = 100; label = 'SHA-256'; line = 'Calcul de l’empreinte…'; }
  progressFill.style.width = pct + '%';
  progressLabel.textContent = label;
  progressLine.textContent = line;
  btnCancel.disabled = false;
}

// ===================================================================
// Analyse (yt-dlp -J, lecture seule)
// ===================================================================

async function doInfo() {
  if (!tab || busy) return;
  busy = true;
  resetUI('info');
  infoError.classList.add('hidden');
  refineWaiting.classList.remove('hidden');
  refineLine.textContent = 'Analyse de la vidéo (yt-dlp)…';
  setStatus('yt-dlp analyse la page (lecture seule, aucun téléchargement)…');

  const r = await sendBg('aa_info', { url: tab.url, cookies: tab.cookies });
  if (!r || !r.ok || !r.id) {
    refineWaiting.classList.add('hidden');
    showError((r && r.error) || 'Analyse impossible.');
    finishBusy();
    return;
  }
  startPoll(r.id, 'info');
}

// Métadonnées de la dernière analyse (titre réel, pour le nom de fichier)
let lastInfo = null;

function fmtDuration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(ss).padStart(2, '0');
}

function showInfo(snap) {
  // Titre affiché : LA LÉGENDE (description) d'abord — c'est le vrai titre
  // d'un post (IG : « Video by x » est un placeholder). Fallback : title.
  const cap = (snap.description || '').trim();
  const t = (snap.title || '').trim();
  infoTitle.textContent = cap ? cap.split('\n')[0].slice(0, 90)
                               : (t || '(sans titre)');
  const bits = [];
  if (snap.extractor) bits.push(snap.extractor);
  if (snap.uploader || snap.channel) bits.push(snap.uploader || snap.channel);
  if (snap.duration) bits.push(fmtDuration(snap.duration));
  if (snap.best_total_bytes) bits.push(fmtBytes(snap.best_total_bytes));
  infoMeta.textContent = bits.join('  ·  ');
  // Si la légende est le titre, ne pas la répéter en description
  infoDesc.textContent = (cap && t && cap.split('\n')[0].slice(0, 90) === infoTitle.textContent)
    ? '' : cap;
  // Vignette (yt-dlp thumbnail) — cachée proprement si elle ne charge pas
  infoThumb.onerror = function () {
    infoThumb.classList.add('hidden');
    infoThumb.removeAttribute('src');
  };
  if (snap.thumbnail) {
    infoThumb.classList.remove('hidden');
    infoThumb.src = snap.thumbnail;
  } else {
    infoThumb.classList.add('hidden');
    infoThumb.removeAttribute('src');
  }
  lastInfo = { title: t, description: cap };
  infoSection.classList.remove('hidden');
}

function showError(msg) {
  infoError.textContent = '⚠️ ' + msg;
  infoError.classList.remove('hidden');
}

// ===================================================================
// Téléchargement + SHA-256
// ===================================================================

async function doDownload() {
  if (!tab || busy) return;
  busy = true;
  resetUI('download');
  progressSection.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressLabel.textContent = '…';
  progressLine.textContent = 'Ouverture de la boîte « Enregistrer sous »…';
  btnCancel.disabled = false;
  setStatus('Le hôte local ouvre la boîte Windows — choisissez l’emplacement et le nom.');

  // Nom de fichier : légende (titre réel du post) > titre yt-dlp > titre d'onglet.
  // (IG : le titre yt-dlp est « Video by x » = générique.)
  let title = tab.title || '';
  if (lastInfo) {
    const cap = (lastInfo.description || '').split('\n')[0].trim();
    title = cap || lastInfo.title || tab.title || '';
  }

  const r = await sendBg('aa_download', {
    url: tab.url,
    cookies: tab.cookies,
    title: title,
    container: 'mp4',
  });
  if (!r || !r.ok || !r.id) {
    progressSection.classList.add('hidden');
    showFail((r && r.error) || 'Lancement impossible.');
    finishBusy();
    return;
  }
  startPoll(r.id, 'download');
}

function showResult(r) {
  progressSection.classList.add('hidden');
  resultSection.classList.remove('hidden');
  resultOk.classList.remove('hidden');
  resultPath.textContent = r.path || '';
  const sha = r.sha256 || '';
  hashValue.textContent = sha || '(non calculé)';
  copyHashBtn.disabled = !sha;
  setStatus('Vidéo archivée + empreinte SHA-256 (« .hash.txt » à côté du fichier).');
}

function showFail(msg) {
  resultSection.classList.remove('hidden');
  resultErr.classList.remove('hidden');
  resultErrorMsg.textContent = msg;
}

async function copyHash() {
  const sha = hashValue.textContent;
  if (!sha || sha === '(non calculé)') return;
  // writeText est asynchrone : sans .catch, un refus (permission / focus
  // perdu du popup) échouerait en SILENCE et le bouton dirait « copié »
  // à tort.
  try {
    await navigator.clipboard.writeText(sha);
    copyHashBtn.textContent = '✓ copié';
    setTimeout(() => { copyHashBtn.textContent = '⧉ copier'; }, 1500);
  } catch (e) {
    setStatus('Copie impossible : ' + (e.message || e));
  }
}

// ===================================================================
// Annulation
// ===================================================================

async function doCancel() {
  if (!lastId) return;
  await sendBg('aa_cancel', { id: lastId });
  stopPoll();
  finishBusy('Téléchargement annulé.');
}

// ===================================================================
// UI reset
// ===================================================================

function resetUI(mode) {
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  resultOk.classList.add('hidden');
  resultErr.classList.add('hidden');
  if (mode !== 'info') infoSection.classList.add('hidden');
  progressFill.style.width = '0%';
  btnInfo.disabled = true;
  btnDownload.disabled = true;
  btnCancel.disabled = true;
}

// ===================================================================
// Boutons
// ===================================================================

btnInfo.addEventListener('click', doInfo);
btnDownload.addEventListener('click', doDownload);
btnCancel.addEventListener('click', doCancel);
copyHashBtn.addEventListener('click', copyHash);

init();
