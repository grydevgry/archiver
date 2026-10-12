// ===================================================================
// Auto-Archiver — build SEA (Node.js Single Executable Application)
//
// Pipeline :
//   1. esbuild bundle host-native/host.cjs → sea-build/host.bundled.cjs
//      (requis : require() relatif ne fonctionne PAS dans un SEA)
//   2. node --experimental-sea-config → blob (config JSON)
//   3. copie de node.exe (du nvm/winget) → auto-archiver-host.exe
//   4. postject injection du blob (+ fuse si le build exige)
//
// Le SENTINEL / FUSE dépend du build Node installé : on le DÉTECTE en
// lisant la chaîne "NODE_SEA_FUSE_..." dans node.exe (le fuse officiel
// de la doc est obsolète pour certains builds).
//
// Usage :
//   node build-sea.mjs [dossier-sortie]   (défaut : dist/)
// ===================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'dist');

function sh(cmd, args, opts = {}) {
  // Windows : ne JAMAIS passer par un shell ici. Avec shell:true, Node
  // émet le warning DEP0190 sur STDERR, et sous PowerShell 5.1 +
  // $ErrorActionPreference='Stop' ce stderr devient une NativeCommandError
  // FATALE (l'install mourait au step registre). Et un .cmd ne se lance
  // pas directement sans shell (code null). → appeler l'entrée JS réelle
  // avec node (esbuild/postject sont des outils JS) : zéro shell, zéro
  // warning.
  if (cmd === 'npx' && process.platform === 'win32') {
    const idx = args.indexOf('-y');
    const name = idx !== -1 ? args[idx + 1] : args[0];
    const rest = idx !== -1 ? [...args.slice(0, idx), ...args.slice(idx + 2)] : args.slice(1);
    // Cache npx : %LOCALAPPDATA%\npm-cache\_npx\<hash>\node_modules\<name>.
    // On résout l'entrée JS réelle (bin du package.json, sinon main) et on
    // l'exécute avec node — même zéro shell que pour esbuild.
    const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
    if (existsSync(cacheRoot)) {
      for (const h of readdirSync(cacheRoot)) {
        const pkgDir = path.join(cacheRoot, h, 'node_modules', name);
        const pj = path.join(pkgDir, 'package.json');
        if (!existsSync(pj)) continue;
        const meta = JSON.parse(readFileSync(pj, 'utf8'));
        let entry = null;
        if (typeof meta.bin === 'string') entry = path.join(pkgDir, meta.bin);
        else if (meta.bin && typeof meta.bin === 'object') entry = path.join(pkgDir, Object.values(meta.bin)[0]);
        if (!entry) entry = path.join(pkgDir, meta.main || 'index.js');
        if (existsSync(entry)) return sh(nodeExe, [entry, ...rest], opts);
      }
    }
    throw new Error(`npx ${name} : entrée JS introuvable (cache npm-cache/_npx vide ?)`);
  }
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  const out = (r.stdout || Buffer.alloc(0)).toString('utf8');
  const err = (r.stderr || Buffer.alloc(0)).toString('utf8');
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`[${cmd}] ${args.join(' ')} -> code ${r.status}\n${err}`);
  }
  return { code: r.status, out, err };
}

function findNodeHome() {
  // node.exe courant (celui qui exécute ce script) → son dossier.
  const exe = process.execPath;
  if (/node\.exe$/.test(exe)) return path.dirname(exe);
  // Sinon : chercher dans le profil WinGet.
  const homedir = process.env.USERPROFILE || '';
  const wingetRoot = path.join(homedir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(wingetRoot)) {
    for (const d of readdirSync(wingetRoot)) {
      if (d.toLowerCase().startsWith('openjs.nodejs')) {
        const base = path.join(wingetRoot, d);
        for (const sub of readdirSync(base)) {
          const exe2 = path.join(base, sub, 'node.exe');
          if (existsSync(exe2)) return path.join(base, sub);
        }
      }
    }
  }
  throw new Error('node.exe introuvable (installez Node via winget).');
}

function detectFuse(nodeExe) {
  // Le fuse dans le binaire est « NODE_SEA_FUSE_ » + 32 hex, suivi de
  // suffixes non-terminés (ex: ":0.src\tracing") — on ne peut PAS
  // chercher le 0x00 : on prend exactement 14+32 caractères.
  const buf = readFileSync(nodeExe);
  const i = buf.indexOf('NODE_SEA_FUSE_');
  if (i === -1) return null; // build sans SEA : on ne fera qu'un SEA "sans fuse"
  const s = buf.toString('latin1', i, i + 14 + 32);
  return /^NODE_SEA_FUSE_[0-9a-f]{32}$/.test(s) ? s : null;
}

const nodeHome = findNodeHome();
const nodeExe = path.join(nodeHome, 'node.exe');
console.log('[1/5] Node :', nodeExe);

const seaDir = path.join(__dirname, 'sea-build');
mkdirSync(seaDir, { recursive: true });
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. esbuild (bundle → un seul fichier, cjs).
console.log('[2/5] esbuild bundle…');
sh('npx', ['-y', 'esbuild', 'host-native/host.cjs', '--bundle',
  '--platform=node', '--format=cjs', `--outfile=${path.join(seaDir, 'host.bundled.cjs')}`],
  { cwd: __dirname });

// 2. config SEA + blob.
const configPath = path.join(seaDir, 'sea-config.json');
writeFileSync(configPath, JSON.stringify({
  main: 'host.bundled.cjs',
  output: 'host.blob',
  disableExperimentalSEAWarning: true,
}, null, 2));
sh(nodeExe, ['--experimental-sea-config', 'sea-config.json'], { cwd: seaDir, allowFail: true });
const blob = path.join(seaDir, 'host.blob');
if (!existsSync(blob)) throw new Error('blob SEA non généré');
console.log('[3/5] blob OK', statSync(blob).size, 'octets');

// 3. base = copie de node.exe.
const outExe = path.join(OUT, 'auto-archiver-host.exe');
console.log('[4/5] copie node.exe → auto-archiver-host.exe…');
copyFileSync(nodeExe, outExe);

// 4. postject (blob) — OBLIGATOIRE : sans le blob l'exe est juste un
// node.exe qui parsirait le stdin en script. On NE masque PAS l'échec.
const fuse = detectFuse(nodeExe);
const sentinelArg = fuse ? ['--sentinel-fuse', fuse] : [];
console.log('  sentinel/fuse détecté :', fuse || '(aucun)');
sh('npx', ['-y', 'postject', outExe, 'NODE_SEA_BLOB', ...sentinelArg, blob]);

// Le fuse est FACULTATIF si l'exe est signé (cas constaté) : on tente,
// on ignore l'échec (l'exe tourne quand même — validé au spike).
if (fuse) {
  const fuseFile = path.join(seaDir, 'sea-fuse.bin');
  writeFileSync(fuseFile, fuse);
  sh('npx', ['-y', 'postject', outExe, 'NODE_SEA_FUSE_V1', fuseFile, ...sentinelArg],
     { allowFail: true });
}

// 5. smoke test : le SEA répond-il à « health » ?
console.log('[5/5] smoke test (health)…');
const ok = smokeTest(outExe);
const size = (statSync(outExe).size / (1024 * 1024)).toFixed(1);
if (!ok) throw new Error('smoke test SEA en échec');
console.log(`\n✅ auto-archiver-host.exe (${size} Mo) → ${outExe}`);

function smokeTest(exe) {
  // Synchronisé : envoie la trame health (après le _init), lit la réponse.
  const health = JSON.stringify({ method: 'health', _request: -1, args: [] });
  const hb = Buffer.from(health, 'utf8');
  const hl = Buffer.alloc(4); hl.writeUInt32LE(hb.length, 0);
  const input = Buffer.concat([hl, hb]);
  const r = spawnSync(exe, [], {
    input, encoding: 'latin1', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).toString('latin1');
  return out.includes('_init') && out.includes('auto_archiver_native_host');
}
