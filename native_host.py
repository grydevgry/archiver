#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Auto-Archiver — Native Messaging Host

Hôte Chrome Native Messaging (stdio) pilotant yt-dlp — inspiré de l'archi
de bellingcat/auto-archiver (generic_extractor) :
  * yt-dlp -J          → analyse lecture seule (metadata, formats)
  * yt-dlp download    → téléchargement bestvideo+bestaudio, remux mp4
  * hash_enricher      → SHA-256 du fichier final + sidecar .hash.txt

Communication stdin/stdout :
    [4 octets: longueur JSON en little-endian uint32][JSON payload]

RPC :
    health   → { ok: True }
    info     → yt-dlp -J (lecture seule), réponse via status <id>
    download → boîte « Enregistrer sous » + yt-dlp + SHA-256
    status   → progression / résultat
    cancel   → annulation
"""

import sys
import os
import json
import time
import subprocess
import tempfile
import threading
import re
import hashlib
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────
HOST_NAME = "auto_archiver_native_host"  # [a-z0-9._] only — dashes invalid (Chromium IsValidName)
OUT_DIR = os.path.join(os.path.expanduser("~"), "Downloads", "Auto-Archiver")
YT_DLP_TIMEOUT = 90        # secondes pour yt-dlp -J
BACKOFFS = [2000, 4000, 6000]  # délais entre retrans anti-bot
HASH_CHUNK = 1024 * 1024   # 1 Mo par bloc

# ── État des tâches ───────────────────────────────────────────────
TASKS = {}   # id → dict
TASK_LOCK = threading.Lock()


# ── Primitives Native Messaging (stdin/stdout) ────────────────────

def write_frame(obj):
    """Envoie une trame : [uint32 LE length][UTF-8 JSON]"""
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    buf = len(data).to_bytes(4, byteorder="little") + data
    sys.stdout.buffer.write(buf)
    sys.stdout.buffer.flush()


def read_frames():
    """Lit et décode les trames du stdin en continu.

    CRITIQUE : utiliser os.read() (pas sys.stdin.buffer.read(n)) !
    read(n) sur un pipe en mode bloquant attend n octets COMPLETS —
    Chrome envoie ~100 octets par frame et ne referme jamais le pipe,
    donc le host attendrait éternellement la 1re frame. os.read()
    renvoie dès que des octets sont disponibles.
    """
    fd = sys.stdin.fileno()
    buffer = b""
    while True:
        chunk = os.read(fd, 4096)
        if not chunk:
            break  # stdin fermé → on quitte
        buffer += chunk
        while len(buffer) >= 4:
            msg_len = int.from_bytes(buffer[:4], byteorder="little")
            if len(buffer) < 4 + msg_len:
                break
            json_bytes = buffer[4:4 + msg_len]
            buffer = buffer[4 + msg_len:]
            try:
                msg = json.loads(json_bytes.decode("utf-8"))
                handle_rpc(msg)
            except Exception as exc:
                print("[host] frame parse error: %s" % exc, file=sys.stderr)


# ── Dispatch RPC ──────────────────────────────────────────────────

def handle_rpc(msg):
    method = (msg.get("method"))
    request_id = msg.get("_request")

    def reply(result):
        write_frame({"_reply": request_id, "result": result or {}})

    def reply_error(err):
        write_frame({"_reply": request_id, "error": str(err or "erreur inconnue")})

    if method == "health":
        reply({"ok": True, "host": HOST_NAME})

    elif method == "info":
        # NON-BLOQUANT : on répond { id } immédiatement, l'analyse tourne
        # dans un thread. Le popup poll « status » (règle MV3 : ne jamais
        # bloquer la réponse initiale).
        args = msg.get("args") or []
        url = args[0] if args else None
        cookies = args[1] if len(args) > 1 else None
        if not url:
            reply_error("URL manquante")
            return
        task_id = _gen_id()
        TASKS[task_id] = {"progress": 0, "status": "queued", "line": "Analyse...",
                          "error": None, "path": None, "title": "", "_proc": None,
                          "_cookies_file": None}
        t = threading.Thread(target=_worker_info, args=(task_id, url, cookies or [],
                                                        msg.get("webpage_url")),
                             daemon=True)
        t.start()
        reply({"id": task_id, "ok": True})

    elif method == "download":
        # NON-BLOQUANT : thread (boîte modale + yt-dlp + hash). Le résultat
        # final (path, sha, title) est stocké dans l'état de tâche → status.
        args = msg.get("args") or []
        url = args[0]
        cookies = args[1]
        title = args[2] if len(args) > 2 else None
        container = args[3] if len(args) > 3 else "mp4"
        if not url:
            reply_error("URL manquante")
            return
        task_id = _gen_id()
        TASKS[task_id] = {"progress": 0, "status": "queued", "line": "",
                          "error": None, "path": None, "title": "", "_proc": None,
                          "_cookies_file": None, "ok": False}
        t = threading.Thread(target=_worker_download,
                             args=(task_id, url, cookies or [], title, container,
                                   msg.get("webpage_url")),
                             daemon=True)
        t.start()
        reply({"id": task_id, "ok": True})

    elif method == "status":
        task_id = (msg.get("args") or [None])[0]
        task = TASKS.get(task_id)
        if not task:
            write_frame({"_reply": request_id, "result": {"error": "inconnu"}})
            return
        # Le snapshot renvoie TOUS les champs que la popup lit : sans ça,
        # l'analyse (title/duration/description/thumbnail/…) stockée par
        # _exec_info ne remonterait jamais et la fiche serait vide.
        snap = {"id": task_id, "progress": task.get("progress", 0),
                "status": task.get("status", "unknown"),
                "line": str(task.get("line", "") or "")[:200],
                "error": task.get("error"), "path": task.get("path"),
                "title": task.get("title", ""), "sha256": task.get("sha256"),
                "ok": task.get("ok", False),
                "extractor": task.get("extractor", ""),
                "uploader": task.get("uploader", ""),
                "channel": task.get("channel", ""),
                "description": task.get("description", ""),
                "thumbnail": task.get("thumbnail", ""),
                "duration": task.get("duration", 0),
                "upload_date": task.get("upload_date", ""),
                "best_total_bytes": task.get("best_total_bytes")}
        write_frame({"_reply": request_id, "result": snap})

    elif method == "cancel":
        task_id = (msg.get("args") or [None])[0]
        existed = False
        proc = None
        with TASK_LOCK:
            if task_id in TASKS:
                existed = True
                proc = TASKS[task_id].get("_proc")
                del TASKS[task_id]
        if proc:
            try:
                proc.terminate()
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        reply({"ok": True, "cancelled": existed})

    else:
        reply_error("methode inconnue: " + str(method))


# ── Workers (threads, non-bloquants) ──────────────────────────────

def _worker_info(task_id, url, cookies, webpage_url):
    """Thread d'analyse yt-dlp -J. Résultat → état de tâche (status)."""
    try:
        _exec_info(task_id, url, cookies, webpage_url)
    except Exception as exc:
        _set_state(task_id, {"status": "error", "error": str(exc)})


def _worker_download(task_id, url, cookies, title, container, webpage_url):
    """Thread download : boîte « Enregistrer sous » → yt-dlp → SHA-256.

    Le résultat final (path, sha, ok) est écrit dans l'état de tâche ;
    le popup le lit via le polling « status » (plus de réponse RPC
    finale : c'est le polling qui est la source de vérité).
    """
    try:
        final_path = _exec_download(task_id, url, cookies, title, container, webpage_url)
        if final_path:
            _set_state(task_id, {"status": "hashing", "line": "Calcul du SHA-256..."})
            sha = _file_sha256(final_path)
            if sha:
                _write_hash_sidecar(final_path, url, sha)
                _set_state(task_id, {"sha256": sha})
            _set_state(task_id, {"ok": True})
        else:
            _set_state(task_id, {"ok": False})
    except Exception as exc:
        _set_state(task_id, {"status": "error", "error": str(exc), "ok": False})


# ── Helpers internes ──────────────────────────────────────────────

def _gen_id():
    return hashlib.sha256(os.urandom(16)).hexdigest()[:32]


def _set_state(task_id, kw):
    with TASK_LOCK:
        t = TASKS.get(task_id)
        if t:
            t.update(kw)


def _sanitize(title, fallback="archive"):
    s = (title or fallback or "archive").strip()
    if not s:
        s = fallback or "archive"
    s = re.sub(r"https?://\S+", " ", s)
    s = re.sub(r"[\/:*?\"<>|]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if s.startswith("."):
        s = s[1:]
    return (s[:90] if len(s) >= 2 else (fallback or "archive"))


def _yt_client_args(url):
    if re.match(r"^(https?://)?(www\.)?(youtube\.com|youtu\.be)/", url or ""):
        return ["--extractor-args", "youtube:player_client=default,android"]
    return []


def _cookies_to_netscape(cookies):
    lines = ["# Netscape HTTP Cookie File"]
    for c in (cookies or []):
        if not c or not c.get("name"):
            continue
        domain = c.get("domain", "")
        lines.append("\t".join([
            domain or "",
            "TRUE" if domain.startswith(".") else "FALSE",
            c.get("path", "/"),
            "TRUE" if c.get("secure") else "FALSE",
            str(int(c.get("expirationDate", 0))),
            c["name"],
            c.get("value", ""),
        ]))
    return "\n".join(lines) + "\n"


def _find_ffmpeg_dir():
    for d in (os.path.join(os.path.expanduser("~"), ".mp4down", "bin"),
              os.path.join(os.path.expanduser("~"), ".auto-archiver", "bin")):
        if os.path.exists(os.path.join(d, "ffmpeg.exe")):
            return d
    return None


def _which(cmd):
    for d in os.environ.get("PATH", "").split(";"):
        full = os.path.join(d, cmd + (".exe" if os.name == "nt" else ""))
        if os.path.exists(full):
            return full
    return None


def _ask_save_path(title, ext):
    """Boîte « Enregistrer sous » via PowerShell (SaveFileDialog).

    CRITIQUE (fiabilité du chemin) : le chemin choisi est rendu par un
    FICHIER TEMPORAIRE UTF-8, PAS par la console. Deux défauts de la console
    ont été constatés sur Windows FR :
      1. encodage ANSI/cp1252 par défaut → un accent cassait la lecture
         UTF-8 (UnicodeDecodeError 0x8a) et le chemin était perdu ;
      2. coupure de ligne du stdout selon la largeur de la console cachée
         → un chemin long renvoyait « Cafétéria\\n-\\né.mp4 ».
    Un fichier évite les deux. Le fichier est unique (id task) et nettoyé.
    """
    fd, out_file = tempfile.mkstemp(prefix="aa_save_", suffix=".txt")
    os.close(fd)
    script = (
        "$out = $args[0]; $title = $args[1]; $ext = $args[2]; "
        "[Windows.Forms.Application]::EnableVisualStyles(); "
        "$fd = New-Object System.Windows.Forms.SaveFileDialog; "
        "$fd.Title = 'Auto-Archiver - Enregistrer sous'; "
        "$fd.Filter = 'Fichier video (*.$ext)|*.$ext'; "
        "$fd.FileName = \"$title.$ext\"; "
        "$fd.AddExtension = $true; $fd.OverwritePrompt = $true; "
        "if ($fd.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {"
        "  [System.IO.File]::WriteAllText($out, $fd.FileName, "
        "      (New-Object System.Text.UTF8Encoding $false)); exit 0"
        "} else { exit 1 }"
    )
    try:
        escaped_title = title.replace("'", "''").replace('"', '\\"')
        escaped_ext = ext.replace("'", "''")
        subprocess.run(
            ["powershell", "-NoProfile", "-WindowStyle", "Hidden",
             "-Command", script, out_file, escaped_title, escaped_ext],
            capture_output=True, timeout=300,
        )
        if os.path.exists(out_file):
            with open(out_file, "r", encoding="utf-8-sig") as f:
                path = f.read().strip()
            return path
        return ""
    except Exception:
        return ""
    finally:
        try:
            if os.path.exists(out_file):
                os.unlink(out_file)
        except Exception:
            pass


def _open_in_explorer(filepath):
    if not filepath or not os.path.exists(filepath):
        return
    try:
        subprocess.Popen(
            ["explorer.exe", "/select,", filepath.replace("&", "^&")],
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except Exception:
        pass


# ── Hash (technique auto-archiver : hash_enricher) ─────────────────

def _file_sha256(path):
    """SHA-256 d'un fichier, par blocs de 1 Mo (fichiers volumineux)."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(HASH_CHUNK)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()
    except Exception as exc:
        print("[host] hash error: %s" % exc, file=sys.stderr)
        return ""


def _write_hash_sidecar(filepath, source_url, sha):
    """Écrit <nom>.hash.txt à côté du média (comme Media['hash'])."""
    try:
        lines = [
            "Auto-Archiver - empreinte SHA-256",
            "date : %s" % time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source : %s" % source_url,
            "fichier : %s" % os.path.basename(filepath),
            "taille : %d octets" % os.path.getsize(filepath),
            "",
            "sha256 = %s" % sha,
            "",
            "Verification (Windows PowerShell) :",
            "  Get-FileHash -Algorithm SHA256 -Path '%s'" % filepath,
        ]
        with open(filepath + ".hash.txt", "w", encoding="utf-8") as f:
            f.write("\r\n".join(lines) + "\r\n")
    except Exception as exc:
        print("[host] sidecar error: %s" % exc, file=sys.stderr)


# ── Erreurs transitoires (anti-bot) ────────────────────────────────

_TRANSIENT_KW = [
    "page needs to be reloaded",
    "sign in to confirm your age",
    "unavailable",
    "requested format is not available",
    "this content is unavailable",
    "member-only content",
]


def _is_transient(line):
    low = (line or "").lower()
    return any(k in low for k in _TRANSIENT_KW)


# ── Exec info : yt-dlp -J (lecture seule) ─────────────────────────

def _exec_info(task_id, url, cookies, webpage_url=None):
    cookies_file = None
    try:
        cmd = ["yt-dlp", "--no-warnings", "--no-colors", "-J"]
        cmd.extend(_yt_client_args(url))
        if webpage_url:
            cmd.extend(["--referer", webpage_url])
        ff = _find_ffmpeg_dir()
        if ff:
            cmd.extend(["--ffmpeg-location", ff])
        if cookies:
            cookies_file = tempfile.mkdtemp(prefix="aa_")
            cf = os.path.join(cookies_file, "cookies.txt")
            with open(cf, "w", encoding="utf-8") as f:
                f.write(_cookies_to_netscape(cookies))
            cmd.extend(["--cookies", cf])
            with TASK_LOCK:
                TASKS[task_id]["_cookies_file"] = cookies_file
        cmd.append(url)

        for a in range(len(BACKOFFS)):
            if a > 0:
                _set_state(task_id, {
                    "line": "Anti-bot transitoire — reessai %d/%d..." % (a, len(BACKOFFS))
                })
                time.sleep(BACKOFFS[a - 1] / 1000)
            try:
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, encoding="utf-8",
                    errors="replace", timeout=YT_DLP_TIMEOUT,
                )
                if proc.returncode == 0 and proc.stdout.strip():
                    info = json.loads(proc.stdout)
                    fmts = [f for f in (info.get("formats") or [])
                            if f and isinstance(f, dict) and f.get("url")]
                    best = _pick_best(info)
                    total = 0
                    have = False
                    for f in (best or []):
                        s = f.get("filesize") or f.get("filesize_approx")
                        if s:
                            total += s
                            have = True
                    duration = info.get("duration") or 0
                    if not duration:
                        # Fallback : Instagram ne donne pas duration →
                        # on lit duration_s dans le param efg de l'URL CDN.
                        duration = _duration_from_efg(info) or 0
                    _set_state(task_id, {
                        "status": "done",
                        "title": info.get("title", ""),
                        "extractor": info.get("extractor_key", ""),
                        "uploader": info.get("uploader") or info.get("uploader_id", ""),
                        "channel": info.get("channel", ""),
                        "description": (info.get("description") or "")[:400],
                        "thumbnail": info.get("thumbnail") or "",
                        "webpage_url": info.get("webpage_url", ""),
                        "duration": duration,
                        "upload_date": info.get("upload_date") or "",
                        "best_total_bytes": total if have else None,
                        "n_formats": len(fmts),
                    })
                    return
                last_err = ((proc.stderr or proc.stdout or "").strip().split("\n")[-1]
                            or ("yt-dlp code %d" % proc.returncode))
                if a < len(BACKOFFS) and _is_transient(last_err):
                    continue
                _set_state(task_id, {"status": "error", "error": last_err})
                return
            except subprocess.TimeoutExpired:
                _set_state(task_id, {"status": "error", "error": "timeout"})
                return
            except Exception as exc:
                if a < len(BACKOFFS) and _is_transient(str(exc)):
                    continue
                _set_state(task_id, {"status": "error", "error": str(exc)})
                return

    finally:
        if cookies_file:
            try:
                cf = os.path.join(cookies_file, "cookies.txt")
                if os.path.exists(cf):
                    os.unlink(cf)
                os.rmdir(cookies_file)
            except Exception:
                pass


# ── Exec download ─────────────────────────────────────────────────

def _exec_download(task_id, url, cookies, title, container, webpage_url=None):
    """Boîte « Enregistrer sous » → yt-dlp (le hash suit dans handle_rpc)."""
    remux = container if container in ("mp4", "mkv") else "mp4"
    cookies_file = None

    try:
        _set_state(task_id, {"status": "choosing", "line": "Choisissez l'emplacement..."})
        chosen = _ask_save_path(_sanitize(title), remux)
        if not chosen:
            _set_state(task_id, {
                "status": "error",
                "error": 'Enregistrement annulé (boîte "Enregistrer sous" fermée).',
            })
            return None

        target_dir = os.path.dirname(os.path.abspath(chosen))
        os.makedirs(target_dir, exist_ok=True)
        base = _sanitize(Path(chosen).stem, str(title or "archive"))

        if cookies:
            cookies_file = tempfile.mkdtemp(prefix="aa_")
            with open(os.path.join(cookies_file, "cookies.txt"), "w", encoding="utf-8") as f:
                f.write(_cookies_to_netscape(cookies))
            with TASK_LOCK:
                TASKS[task_id]["_cookies_file"] = cookies_file

        out_tpl = os.path.join(target_dir, base + ".%(ext)s")
        cmd = [
            "yt-dlp", "--no-warnings", "-f", "bestvideo+bestaudio/best",
            "--remux-video", remux, "-o", out_tpl,
            "--newline", "--no-colors",
        ]
        cmd.extend(_yt_client_args(url))
        ff = _find_ffmpeg_dir()
        if ff:
            cmd.extend(["--ffmpeg-location", ff])
        if cookies_file:
            cmd.extend(["--cookies", os.path.join(cookies_file, "cookies.txt")])
        if webpage_url:
            cmd.extend(["--add-header", "referer:%s" % webpage_url])
        cmd.append(url)

        final_path = None
        last_err = None
        proc = None

        for a in range(len(BACKOFFS)):
            if a > 0:
                _set_state(task_id, {
                    "line": "Anti-bot transitoire — reessai %d/%d..." % (a, len(BACKOFFS))
                })
                time.sleep(BACKOFFS[a - 1] / 1000)

            _set_state(task_id, {"status": "running"})
            last_err = None

            try:
                proc = subprocess.Popen(
                    cmd, cwd=target_dir, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE, text=True, encoding="utf-8",
                    errors="replace",
                )
                with TASK_LOCK:
                    TASKS[task_id]["_proc"] = proc

                for line in proc.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    mp = re.search(r"([\d.]+)%", line)
                    if mp and "[download]" in line:
                        _set_state(task_id, {"progress": float(mp.group(1)), "line": line})
                    elif "ERROR" in line:
                        last_err = line
                        _set_state(task_id, {"error": line})
                    elif any(k in line for k in ("[Merger]", "[ffmpeg]", "[ExtractAudio]")):
                        _set_state(task_id, {"status": "converting", "progress": 100, "line": line})
                    else:
                        _set_state(task_id, {"line": line})

                proc.wait()

            except Exception as exc:
                last_err = str(exc)

            final_path = _find_output_file(target_dir, base)
            if final_path and os.path.exists(final_path):
                break

            if a < len(BACKOFFS) and last_err and _is_transient(last_err):
                continue
            break

        if final_path and os.path.exists(final_path):
            _set_state(task_id, {"status": "done", "progress": 100, "path": final_path})
            _open_in_explorer(final_path)
            return final_path

        _set_state(task_id, {
            "status": "error",
            "error": last_err or ("yt-dlp terminé avec code %s"
                                  % (proc.returncode if proc else "?")),
        })
        return None

    except Exception as exc:
        _set_state(task_id, {"status": "error", "error": str(exc)})
        return None

    finally:
        if cookies_file:
            try:
                cf = os.path.join(cookies_file, "cookies.txt")
                if os.path.exists(cf):
                    os.unlink(cf)
                os.rmdir(cookies_file)
            except Exception:
                pass


# ── pickBest + findOutput ─────────────────────────────────────────

def _duration_from_efg(info):
    """Durée en secondes extraite du paramètre « efg » (base64 JSON) des
    URLs CDN — fallback pour les plateformes (Instagram) où yt-dlp ne
    retourne ni duration ni filesize."""
    import base64
    import urllib.parse
    for f in (info.get("formats") or []):
        url = (f or {}).get("url") or ""
        m = re.search(r"[?&]efg=([A-Za-z0-9_\-]+)", url)
        if not m:
            continue
        try:
            pad = "=" * (-len(m.group(1)) % 4)
            d = json.loads(base64.b64decode(m.group(1) + pad))
            dur = d.get("duration_s")
            if dur:
                return float(dur)
        except Exception:
            continue
    return None


def _pick_best(info):
    if not info or not info.get("formats"):
        return None
    best_v, best_a, best_both = None, None, None
    for f in info["formats"]:
        if not f or not f.get("url"):
            continue
        has_v = f.get("vcodec") and f["vcodec"] != "none"
        has_a = f.get("acodec") and f["acodec"] != "none"

        def w(x, y):
            return ((x.get("filesize") or x.get("tbr") or 0)
                    - (y.get("filesize") or y.get("tbr") or 0)
                    + (x.get("width") or 0) - (y.get("width") or 0)
                    + (x.get("height") or 0) - (y.get("height") or 0))

        if has_v and has_a:
            if not best_both or w(f, best_both) > 0:
                best_both = f
        elif has_v:
            if not best_v or w(f, best_v) > 0:
                best_v = f
        elif has_a:
            if not best_a or w(f, best_a) > 0:
                best_a = f
    result = []
    if best_v:
        result.append(best_v)
    if best_a and best_a is not best_v:
        result.append(best_a)
    if not result and best_both:
        result.append(best_both)
    return result if result else None


def _find_output_file(target_dir, base):
    try:
        candidates = []
        for fn in os.listdir(target_dir):
            if not fn.startswith(base) or re.search(r"\.f\d+\.", fn):
                continue
            fp = os.path.join(target_dir, fn)
            if os.path.isfile(fp):
                candidates.append((os.path.getsize(fp), fp))
        if candidates:
            candidates.sort()
            return candidates[-1][1]
    except Exception:
        pass
    return None


# ── Point d'entrée ────────────────────────────────────────────────

if __name__ == "__main__":
    # Signal d'initialisation (poignée de main)
    write_frame({"_init": True, "host": HOST_NAME, "version": "1.0.0"})

    # Boucle principale : lire stdin, traiter les frames
    read_frames()

    # Nettoyage
    with TASK_LOCK:
        for tid in list(TASKS.keys()):
            proc = TASKS[tid].get("_proc")
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
