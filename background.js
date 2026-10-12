// ===================================================================
// Auto-Archiver — background service worker (MV3)
//
// Archi bellingcat/auto-archiver, traduite en extension :
//   * feeder   → l'onglet courant (URL + titre + cookies)
//   * generic_extractor → yt-dlp piloté par le NATIVE MESSAGING HOST
//     (native_host.py) : analyse -J + téléchargement bestvideo+bestaudio
//   * hash_enricher → SHA-256 du fichier final (calculé dans le host)
//   * local_storage → boîte « Enregistrer sous » du host
//
// Aucune détection MSE/webRequest : c'est le principe même de
// auto-archiver — yt-dlp résout TOUT, la page n'est qu'une source d'URL.
//
// Native Messaging (transport inline — le SW ne peut pas charger de
// script externe pour cette API) :
//   - connectNative(HOST) → port persistant
//   - requête : { method, _request: id, args }
//   - réponse : { _reply: id, result | error }
// ===================================================================

'use strict';

// Le nom de host natif ne doit contenir QUE [a-z0-9._] (Chromium
// NativeMessagingHostManifest::IsValidName) — TIRETS interdits. Un tiret
// ici fait échouer connectNative() AVANT la lecture du registre :
// « Invalid native messaging host name specified ».
var _NM_HOST = 'auto_archiver_native_host';
var _NM_conn = null;
var _NM_nextReq = 1;
var _NM_pending = {};

function _NM_onMsg(msg) {
  if (!msg || msg._reply === undefined) return;
  var id = msg._reply;
  var h = _NM_pending[id];
  if (!h) return;
  clearTimeout(h._t);
  delete _NM_pending[id];
  if (msg.error) h._rj(new Error(msg.error));
  else h._rs(msg.result || {});
}

function _NM_onDisc() {
  // lastError lu SYNCHRONEMENT : c'est lui qui porte le vrai message
  // (« host not found », « manifest not found »…).
  var le = '';
  try { le = (chrome.runtime.lastError && chrome.runtime.lastError.message) || ''; } catch (e) {}
  if (le) try { console.log('[AA NM] disconnect: ' + le); } catch (e) {}
  _NM_conn = null;
  for (var k in _NM_pending) {
    var h = _NM_pending[k];
    clearTimeout(h._t);
    h._rj(new Error('host natif déconnecté' + (le ? ' — ' + le : '')));
    delete _NM_pending[k];
  }
}

function _NM_rpc(method, args, timeoutMs, webpageUrl) {
  timeoutMs = timeoutMs || 90000;
  return new Promise(function(rs, rj) {
    var id = _NM_nextReq++;
    var t = setTimeout(function() {
      delete _NM_pending[id];
      rj(new Error('délai dépassé (' + method + ')'));
    }, timeoutMs);
    _NM_pending[id] = { _rs: rs, _rj: rj, _t: t };
    try {
      var msg = { method: method, _request: id, args: args || [] };
      if (webpageUrl) msg.webpage_url = webpageUrl;
      _NM_conn.postMessage(msg);
    } catch (e) {
      clearTimeout(t);
      delete _NM_pending[id];
      rj(new Error('envoi échoué: ' + e.message));
    }
  });
}

function _ensureConnected() {
  return new Promise(function(resolve, reject) {
    if (_NM_conn) { resolve(); return; }
    try {
      _NM_conn = chrome.runtime.connectNative(_NM_HOST);
      _NM_conn.onMessage.addListener(_NM_onMsg);
      _NM_conn.onDisconnect.addListener(_NM_onDisc);
      resolve();
    } catch (e) {
      _NM_conn = null;
      reject(new Error('connectNative échoué: ' + e.message));
    }
  });
}

// Santé du host : connexion ponctuelle, dernière réponse = la bonne
// (le host ferme la connexion après le health, donc on n'ignore
// AUCUNE réponse _reply: -1 — mais on ne résout qu'à la 1re).
// Résout { ok, tools } : tools = { ytdlp, ffmpeg, saveDialog } pour le
// badge diagnostic du popup (« host OK, yt-dlp ✗ » au lieu d'un OK
// trompeur quand l'outil manque).
function nativeHealth() {
  return new Promise(function(resolve) {
    try {
      var conn = chrome.runtime.connectNative(_NM_HOST);
      var decided = false;
      conn.onMessage.addListener(function(msg) {
        if (decided) return;
        if (msg && msg._reply === -1) {
          decided = true;
          try { conn.disconnect(); } catch (_) {}
          resolve({
            ok: !!(msg.result && msg.result.ok),
            tools: (msg.result && msg.result.tools) || null,
          });
        }
      });
      conn.onDisconnect.addListener(function() {
        if (!decided) { decided = true; resolve(false); }
      });
      conn.postMessage({ method: 'health', _request: -1, args: [] });
      setTimeout(function() {
        if (!decided) { decided = true; try { conn.disconnect(); } catch (_) {} resolve(false); }
      }, 5000);
    } catch (e) {
      resolve(false);
    }
  });
}

// ===================================================================
// Onglet courant + cookies (le « feeder » de auto-archiver)
// ===================================================================

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      resolve(tabs && tabs[0]);
    });
  });
}

// Cookies du domaine de l'URL (pour les pages derrière login —
// même mécanisme que le service mp4-downloader).
// chrome.cookies.getAll({ url }) applique déjà les règles exactes du
// cookie jar (domain-match, path, Secure, expiration) — un filtre
// manuel par-dessus pouvait ÉCARTER des cookies légitimes (ex: cookie
// .instagram.com posé pour un sous-domaine). On se fie au filtre natif.
async function getURLCookies(pageUrl) {
  try {
    return await chrome.cookies.getAll({ url: pageUrl });
  } catch (e) {
    return [];
  }
}

// ===================================================================
// API exposée au popup (chrome.runtime.onMessage)
// ===================================================================
//   aa_health  → { ok }
//   aa_getTab  → { url, title, cookies }
//   aa_info    → { id }            (yt-dlp -J, lecture seule, non bloquant)
//   aa_status  → snapshot de tâche
//   aa_download→ { id, ok, path, sha256, title } | { id, ok:false, error }
//   aa_cancel  → { ok, cancelled }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'aa_health': {
      // { ok, tools } : le popup affiche le badge + le diagnostic des outils.
      nativeHealth().then((h) => sendResponse(h || { ok: false }));
      return true;
    }

    case 'aa_getTab': {
      (async () => {
        try {
          const tab = await getActiveTab();
          if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
            sendResponse({ ok: false, error: 'Aucune page http(s) dans l’onglet courant.' });
            return;
          }
          const cookies = await getURLCookies(tab.url);
          sendResponse({ ok: true, url: tab.url, title: tab.title || '', cookies: cookies });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }

    case 'aa_info': {
      // Non bloquant : on répond { id } puis le popup poll via aa_status
      // (règle d'or : jamais bloquer → sinon « service worker en veille »).
      (async () => {
        try {
          await _ensureConnected();
          const r = await _NM_rpc('info', [msg.url, msg.cookies || []], 95000, msg.url);
          sendResponse({ ok: true, id: r.id });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }

    case 'aa_status': {
      (async () => {
        try {
          await _ensureConnected();
          const snap = await _NM_rpc('status', [msg.id], 10000);
          sendResponse({ ok: true, snap: snap });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }

    case 'aa_download': {
      // Bloquant côté host : boîte « Enregistrer sous » + yt-dlp + SHA-256.
      // Timeout généreux (30 min) — le polling aa_status suit la progression.
      (async () => {
        try {
          await _ensureConnected();
          const r = await _NM_rpc(
            'download',
            [msg.url, msg.cookies || [], msg.title || '', msg.container || 'mp4'],
            1800000,
            msg.url
          );
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }

    case 'aa_cancel': {
      (async () => {
        try {
          await _ensureConnected();
          const r = await _NM_rpc('cancel', [msg.id], 5000);
          sendResponse(r);
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
      })();
      return true;
    }
  }
  sendResponse({ ok: false, error: 'message inconnu: ' + msg.type });
});
