# ============================================================
# Auto-Archiver - Installer (PowerShell, no admin required)
#   Two native-host engines, SAME Native Messaging protocol:
#     -Engine node (v2, default) :
#       host-native/*.cjs -> auto-archiver-host.exe (Node SEA,
#       self-contained ~89 Mo) via build-sea.mjs
#     -Engine python (v1) :
#       native_host.py -> auto-archiver-host.exe (PyInstaller)
#   The registry SUBKEY (default value) points to the same manifest
#   either way. Chrome reads a per-host subkey, NOT a named value.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1                (node)
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Engine python
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 + accented
#       (cp1252/UTF-8) strings caused parse errors on this machine.
# ============================================================

param(
    [switch]$Uninstall,
    [switch]$Force,
    [ValidateSet('node', 'python')]
    [string]$Engine = 'node'
)

$ErrorActionPreference = "Stop"

# Host name: [a-z0-9._] ONLY (Chromium NativeMessagingHostManifest::IsValidName).
# Dashes are REJECTED by connectNative() BEFORE any registry lookup:
# "Invalid native messaging host name specified".
$HostName     = "auto_archiver_native_host"
$ExeName      = "auto-archiver-host.exe"
$InstallDir   = Join-Path $env:USERPROFILE ".auto-archiver\bin"
$ExePath      = Join-Path $InstallDir $ExeName
$ManifestPath = Join-Path $InstallDir "native-host-manifest.json"
# NB: le ':' du PSDrive est OBLIGATOIRE pour les cmdlets PS (Test-Path,
# Get-ItemProperty, Remove-Item) — sans, ca devient un chemin fichier
# relatif (bug corrige 05/10).
$RegParent    = "HKCU:\Software\Google\Chrome\NativeMessagingHosts"
# Chrome (launch_context_win.cc) : Open(NativeMessagingHosts) ->
# OpenKey(host_name) -> ReadValue(NULL) : la valeur PAR DEFAUT d'une
# SOUS-CLE porte le chemin du manifest. Une valeur nommee sous la cle
# parente est INVISIBLE pour Chrome (cause historique : le host etait
# enregistre comme valeur, Chrome le cherchait comme sous-cle).
$RegKey       = "$RegParent\$HostName"
$ExtensionId  = "bjhpppaijndghboidohfgmamfelbbefi"

# --- Registre via le provider .NET (PS), PAS reg.exe (05/10) --------
# reg.exe a ete abandonne : (a) un reg.exe "zombie" (lance par une
# instance d'install tuee en cours de route) SPINNE dans ses entrees
# (des heures de CPU) et bloque la suite ; (b) tout stderr natif devient
# une NativeCommandError fatale sous $ErrorActionPreference='Stop',
# meme avec 2>$null. Le provider PS est in-process : ni process enfant,
# ni stderr, ni EAP; les absences sont de simples erreurs gerees.
function Remove-RegTarget($key, $valueName) {
    try {
        if (Test-Path $key) {
            if ($null -ne $valueName) { Remove-ItemProperty $key -Name $valueName -Force }
            else { Remove-Item $key -Recurse -Force }
        }
    } catch { }
}
# NB 4 (05/10) : ecrire la valeur PAR DEFAUT ne marche PAS avec le
# provider PS 5.1 (Set-ItemProperty '(default)' = no-op/erreur ;
# New-ItemProperty = "IDynamicPropertyCmdletProvider n'est pas
# implemente"). On passe par P/Invoke RegSetKeyValueW (Win32, in-process : plus de
# process enfant, donc plus de zombie reg.exe non plus).
Add-Type -Namespace AA -Name RegW -MemberDefinition @'
[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern int RegSetKeyValueW(int hKey, string lpSubKey, string lpValue, int dwType, string lpData, int cbData);
'@
function Set-DefaultRegValue($subKey, $value) {
    # HKCU = 0x80000001, REG_SZ = 1
    $rc = [AA.RegW]::RegSetKeyValueW(0x80000001, $subKey, $null, 1, $value, ([System.Text.Encoding]::Unicode.GetByteCount($value) + 2))
    if ($rc -ne 0) { throw "RegSetKeyValueW rc=$rc" }
}

if ($Uninstall) {
    Write-Host "[1/2] Uninstalling..." -ForegroundColor Yellow
    # Les deux formes + le vieux nom (tirets) pour le nettoyage des
    # machines installees avant la correction du nom. (Remove-RegTarget
    # ci-dessus : provider .NET, pas de process enfant.)
    Remove-RegTarget $RegKey $null
    Remove-RegTarget $RegParent $HostName
    Remove-RegTarget "$RegParent\auto-archiver-native-host" $null
    Remove-RegTarget $RegParent "auto-archiver-native-host"
    Write-Host "     Registry entries removed."
    $base = Join-Path $env:USERPROFILE ".auto-archiver"
    if (Test-Path $base) {
        Remove-Item $base -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "     .auto-archiver folder removed."
    }
    Write-Host "Uninstall DONE." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " Auto-Archiver - Install (engine: $Engine, no admin)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$ExtDir = $PSScriptRoot

Write-Host "[1/6] Prerequisites..." -ForegroundColor Cyan
$ytdlp = Get-Command yt-dlp -ErrorAction SilentlyContinue
if (-not $ytdlp) {
    Write-Host "  [WARN] yt-dlp not found - run: pip install -U yt-dlp" -ForegroundColor Yellow
} else {
    Write-Host "  yt-dlp OK"
}

$ffOk = Test-Path (Join-Path $env:USERPROFILE ".mp4down\bin\ffmpeg.exe")
$ffOk = $ffOk -or (Test-Path (Join-Path $env:USERPROFILE ".auto-archiver\bin\ffmpeg.exe"))
if ($ffOk) { Write-Host "  ffmpeg OK (reused)" } else { Write-Host "  [WARN] ffmpeg not found (MP4 remux will fail)" -ForegroundColor Yellow }

if ($Engine -eq "node") {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Host "  [ERROR] node not found in PATH (winget install OpenJS.NodeJS.LTS)." -ForegroundColor Red
        exit 1
    }
    Write-Host "  node OK ($($node.Version))"
} else {
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        Write-Host "  [ERROR] python not found in PATH." -ForegroundColor Red
        exit 1
    }
    Write-Host "  python OK ($($python.Source))"
}

Write-Host "[2/6] Building host (engine $Engine)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Set-Location $ExtDir
if ($Engine -eq "node") {
    # build-sea.mjs : esbuild -> blob SEA -> postject -> dist\exe
    # (+ smoke test interne "health"). SEA autonome : aucun runtime
    # Node requis sur la machine cible.
    node (Join-Path $ExtDir "build-sea.mjs") (Join-Path $ExtDir "dist")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Node SEA build failed." -ForegroundColor Red
        exit 1
    }
} else {
    $srcHost = Join-Path $ExtDir "native_host.py"
    if (-not (Test-Path $srcHost)) {
        Write-Host "  [ERROR] native_host.py not found." -ForegroundColor Red
        exit 1
    }
    python -m PyInstaller --noconfirm --onefile --noconsole --name auto-archiver-host $srcHost
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] PyInstaller failed (pip install pyinstaller)." -ForegroundColor Red
        exit 1
    }
}
$built = Join-Path $ExtDir "dist\auto-archiver-host.exe"
if (-not (Test-Path $built)) {
    Write-Host "  [ERROR] exe not produced in dist\" -ForegroundColor Red
    exit 1
}
Copy-Item $built $ExePath -Force
$size = [math]::Round((Get-Item $ExePath).Length / 1MB, 1)
Write-Host "  auto-archiver-host.exe ($size MB, $Engine) -> $InstallDir"

Write-Host "[3/6] Manifest..." -ForegroundColor Cyan
$manifestLines = @(
    "{"
    '  "name": "' + $HostName + '",',
    '  "description": "Native Messaging Host for Auto-Archiver extension",',
    # .Replace() et PAS -replace : -replace est une regex, et le motif '\'
    # (un seul backslash) est une regex invalete .NET -> erreur parse ici.
    '  "path": "' + $ExePath.Replace('\','\\') + '",',
    '  "type": "stdio",',
    '  "allowed_origins": ["chrome-extension://' + $ExtensionId + '/"]'
    "}"
)
$manifestText = $manifestLines -join "`r`n"
Set-Content -Path $ManifestPath -Value $manifestText -Encoding ASCII -NoNewline
Write-Host "  $ManifestPath"

Write-Host "[4/6] Chrome Native Messaging registry..." -ForegroundColor Cyan
# Chrome lit : Open(NativeMessagingHosts) -> OpenKey(host_name) ->
# ReadValue(NULL) : le manifest est la valeur PAR DEFAUT d'une SOUS-CLE
# nommee d'apres le host (chrome/browser/extensions/api/messaging/
# launch_context_win.cc). La forme "valeur nommee sous la cle parente"
# (utilisee avant 2026-10) est IGNOREE par Chrome : nettoyage des deux
# formes puis ecriture de la sous-cle (reg add sans /v, avec /ve).
# NB 1: reg delete retourne 1 si la cible n'existe pas, l'isoler dans son
# appel, sinon $LASTEXITCODE reflechit le DELETE et masque un add reussi.
# NB 2: reg delete sur cible ABSENTE ecris "cle introuvable" sur STDERR ;
# sous $ErrorActionPreference='Stop' (PS 5.1) ligne stderr native = erreur
# TERMINANTE, MEME avec 2>$null. On baisse EAP autour des delete puis on
# le restaure avant le reg add (dont on lit $LASTEXITCODE).
# NB 3 (correction 2026-10-05) : reg.exe est ABANDONNE : des instances
# d'install tuees en cours de route laissaient des reg.exe "zombies"
# qui spinnaient des heures et bloquaient le step. On utilise le provider
# .NET de PS (in-process : ni process enfant, ni stderr, ni EAP).
Remove-RegTarget $RegKey $null
Remove-RegTarget $RegParent $HostName
# Reliquats de l'ancienne forme (valeur nommee, nom a tirets) :
# Chrome les ignore (nom invalide) mais on nettoie quand meme.
Remove-RegTarget "$RegParent\auto-archiver-native-host" $null
Remove-RegTarget $RegParent "auto-archiver-native-host"
# NB 4 (05/10) : ecrire la valeur PAR DEFAUT echoue avec le provider PS
# 5.1 (Set-ItemProperty = no-op/erreur, New-ItemProperty = erreur
# IDynamicPropertyCmdletProvider) : P/Invoke RegSetKeyValueW (in-process).
try {
    $sub = $RegKey.Substring('HKCU:\'.Length).TrimStart('\')
    Set-DefaultRegValue $sub $ManifestPath
} catch {
    Write-Host "  [ERROR] registry write failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
$regVal = (Get-ItemProperty -Path $RegKey -ErrorAction Stop).'(default)'
if ($regVal -ne $ManifestPath) {
    Write-Host "  [ERROR] registry default value mismatch: $regVal" -ForegroundColor Red
    exit 1
}
Write-Host "  HKCU subkey created and verified: $RegKey (default = $regVal)" -ForegroundColor Green

Write-Host "[5/6] Smoke test (health frame)..." -ForegroundColor Cyan
# Framing [uint32 LE][JSON] : on envoie une trame health et on attend la
# reponse du host (meme contrat que test/test-e2e.cjs). Le host quitte
# quand stdin est ferme (ici : redirige vers un fichier, pas un pipe).
$inBin  = Join-Path $env:TEMP "aa_smoke_in_$Engine.bin"
$outBin = Join-Path $env:TEMP "aa_smoke_out_$Engine.bin"
$health = '{"method":"health","_request":-1,"args":[]}'
$hb = [System.Text.Encoding]::UTF8.GetBytes($health)
$hl = New-Object byte[] 4
[BitConverter]::GetBytes([uint32]$hb.Length).CopyTo($hl, 0)
Set-Content -Path $inBin -Value ($hl + $hb) -Encoding Byte
try {
    $p = Start-Process -FilePath $ExePath `
        -RedirectStandardInput $inBin -RedirectStandardOutput $outBin `
        -NoNewWindow -Wait -PassThru -ErrorAction Stop
    if (Test-Path $outBin) {
        $out = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($outBin))
        if ($out -match 'auto_archiver_native_host') {
            Write-Host "  host repond au health: OK" -ForegroundColor Green
        } else {
            Write-Host "  [WARN] smoke test: pas de reponse health (verifier la popup)." -ForegroundColor Yellow
        }
    } else {
        Write-Host "  [WARN] smoke test: sortie vide." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [WARN] smoke test: lancement en echec ($($_.Exception.Message))" -ForegroundColor Yellow
}
Remove-Item $inBin -ErrorAction SilentlyContinue
Remove-Item $outBin -ErrorAction SilentlyContinue

Write-Host "[6/6] Cleanup..." -ForegroundColor Cyan
Remove-Item (Join-Path $ExtDir "build") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $ExtDir "auto-archiver-host.spec") -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Install DONE! (engine: $Engine)" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Close ALL Chrome windows (host cache)"
Write-Host "  2. chrome://extensions/ -> enable Developer mode"
Write-Host "  3. Load unpacked extension -> this folder"
Write-Host "  4. Check the extension ID. If it differs from \$ExtensionId in"
Write-Host "     install.ps1, update it and re-run."
Write-Host "  5. Reopen the popup: badge must show 'host OK'."
Write-Host ""
Write-Host "Tests aller-retour (sans Chrome):  npm test" -ForegroundColor White
Write-Host ""
