// npm run refcheck [-- --build]
// Fails if any reference file (Docs/refs/** when present + every hash in tools/refs.manifest.json)
// appears in dist/ (whole-file SHA-256, embedded data:image literals, and text snippets of local
// text refs), if dist/ ships ANY image file (the game ships zero images), or if a reference file
// was copied anywhere else in the project (src/, look/, lab/, Docs/ minus Docs/refs/, tools/, ...).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { updateChecks } from './lib/checks.mjs';
import { distHasGame, ensureDist } from './lib/server.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { PHASH_EXT, aHashFiles, hamming } from './lib/phash.mjs';
import { ROOT, num, parseArgs, writeJsonAtomic, rel, runTool, sha256, sha256File, utcIso, verdict, walkFiles } from './lib/util.mjs';

const TOOL = 'refcheck';
const args = parseArgs(undefined, { booleans: ['build', 'phash'] });
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.oga', '.m4a', '.flac', '.aac', '.opus', '.mid', '.midi']);
const PHASH_DIRS = ['look', 'Docs/progress', 'Docs/captures', 'lab', 'src'];
const PHASH_MAX = num(args.phashMax, 6);
const PHASH_FILE = join(ROOT, 'tools', 'refs.phash.json');
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp', '.ico', '.svg', '.tif', '.tiff']);
const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.md', '.svg', '.map']);

runTool(TOOL, async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'tools', 'refs.manifest.json'), 'utf8'));
  /** sha256 -> source description */
  const refs = new Map();
  for (const f of manifest.files || []) refs.set(f.sha256, `${f.path} (manifest)`);

  const refsDir = join(ROOT, 'Docs', 'refs');
  const local = walkFiles(refsDir);
  const manifestPaths = new Set((manifest.files || []).map((f) => f.path));
  const notInManifest = [];
  const snippets = []; // distinctive text snippets of local text refs
  for (const f of local) {
    const h = await sha256File(f);
    const r = rel(f);
    if (!refs.has(h)) notInManifest.push(r);
    refs.set(h, r);
    if (['.md', '.txt', '.json'].includes(extname(f).toLowerCase())) {
      const lines = readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.length >= 60 && !/^[|#>*-]/.test(l));
      for (const l of lines.slice(0, 6)) snippets.push({ from: r, text: l.slice(0, 60) });
    }
  }
  const missingLocally = existsSync(refsDir) ? [...manifestPaths].filter((p) => !existsSync(join(ROOT, p))) : [];

  const build = await ensureDist({ force: !!args.build });
  const distDir = join(ROOT, 'dist');
  const distFiles = walkFiles(distDir);
  const audio = [];
  const inBuild = [], images = [], dataImages = [], textHits = [];
  let dataImageLiterals = 0, dataAudio = 0;
  for (const f of distFiles) {
    const buf = readFileSync(f);
    const h = sha256(buf);
    if (refs.has(h)) inBuild.push(`${rel(f)} == ${refs.get(h)}`);
    const ext = extname(f).toLowerCase();
    if (IMAGE_EXT.has(ext)) images.push(`${rel(f)} (${buf.length} B)`);
    if (AUDIO_EXT.has(ext)) audio.push(`${rel(f)} (${buf.length} B)`);
    if (TEXT_EXT.has(ext)) {
      const text = buf.toString('utf8');
      dataAudio += (text.match(/data:audio\/[a-z0-9.+-]+;base64,/g) || []).length;
      for (const m of text.matchAll(/data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=]{16,})/g)) {
        dataImageLiterals++;
        const dh = sha256(Buffer.from(m[1], 'base64'));
        if (refs.has(dh)) dataImages.push(`${rel(f)} embeds ${refs.get(dh)}`);
      }
      for (const s of snippets) if (text.includes(s.text)) textHits.push(`${rel(f)} contains text of ${s.from}`);
    }
  }

  // Reference files copied elsewhere in the project (private/ is the sanctioned gitignored place).
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'private', '.vite'].map((d) => join(ROOT, d)));
  const repoFiles = walkFiles(ROOT, (p, isDir) => isDir && (skipDirs.has(p) || p === refsDir || p.startsWith(join(ROOT, 'dist-')) || p.split(sep).includes('node_modules')));
  const inRepo = [];
  for (const f of repoFiles) {
    if (statSync(f).size > 64 * 1024 * 1024) continue;
    const h = await sha256File(f);
    if (refs.has(h) && !f.endsWith('refs.manifest.json')) inRepo.push(`${rel(f)} == ${refs.get(h)}`);
  }


  // Perceptual near-duplicates of reference images (re-encoded/resized copies escape SHA-256).
  // Reference aHashes come from Docs/refs/ when present and are cached in tools/refs.phash.json
  // (hashes only, no content) so clones without the private pack still run this check.
  const phashHits = [];
  let phashInfo = { status: 'skipped (--no-phash)' };
  if (args.phash !== false) {
    const browser = await launchBrowser();
    try {
      let refHashes = {};
      const refImgs = local.filter((f) => PHASH_EXT.has(extname(f).toLowerCase()));
      if (refImgs.length) {
        const m = await aHashFiles(browser, refImgs);
        for (const [f, h] of m) if (h) refHashes[rel(f)] = h;
        await writeJsonAtomic(PHASH_FILE, { note: '16x16 average-hash (aHash) of each reference image in Docs/refs/ (hashes only). Used by npm run refcheck.', generated_utc: utcIso(), count: Object.keys(refHashes).length, hashes: refHashes });
      } else if (existsSync(PHASH_FILE)) refHashes = JSON.parse(readFileSync(PHASH_FILE, 'utf8')).hashes || {};
      const bits = (h) => [...h].reduce((a, c) => a + [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][parseInt(c, 16)], 0);
      const usable = Object.entries(refHashes).filter(([, h]) => bits(h) >= 16 && bits(h) <= 240); // near-flat hashes carry no signal
      const project = PHASH_DIRS.flatMap((d) => walkFiles(join(ROOT, d))).filter((f) => PHASH_EXT.has(extname(f).toLowerCase()));
      const ph = usable.length ? await aHashFiles(browser, project) : new Map();
      let flat = 0;
      for (const [f, h] of ph) {
        if (!h) continue;
        if (bits(h) < 16 || bits(h) > 240) {
          flat++;
          continue;
        }
        let best = null;
        for (const [r, rh] of usable) {
          const d = hamming(h, rh);
          if (!best || d < best.d) best = { r, d };
        }
        if (best && best.d <= PHASH_MAX) phashHits.push(`${rel(f)} ~ ${best.r} (aHash distance ${best.d}/256)`);
      }
      phashInfo = { status: usable.length ? 'checked' : 'no reference hashes (no Docs/refs/ and no tools/refs.phash.json)', ref_hashes: usable.length, images_checked: ph.size, near_flat_skipped: flat, max_distance: PHASH_MAX, dirs: PHASH_DIRS };
    } finally {
      await browser.close();
    }
  }

  const failures = [];
  if (inBuild.length) failures.push(`${inBuild.length} reference file(s) in dist/`);
  if (dataImages.length) failures.push(`${dataImages.length} reference image(s) embedded as data: URLs in dist/`);
  if (textHits.length) failures.push(`${textHits.length} reference text excerpt(s) in dist/`);
  if (images.length) failures.push(`${images.length} image file(s) in dist/ (the game ships zero images)`);
  if (inRepo.length) failures.push(`${inRepo.length} reference file(s) copied outside Docs/refs/`);
  if (audio.length || dataAudio) failures.push(`${audio.length + dataAudio} audio file(s)/data:audio literal(s) in dist/ (the game ships zero audio files)`);
  if (phashHits.length) failures.push(`${phashHits.length} image(s) perceptually match a reference (aHash <= ${PHASH_MAX})`);
  const passed = failures.length === 0;
  await updateChecks({
    refcheck: {
      utc: utcIso(),
      passed,
      status: passed ? 'pass' : 'fail',
      ref_files_in_build: inBuild.length + dataImages.length + textHits.length,
      images_in_build: images.length,
      ref_files_in_repo: inRepo.length,
      audio_in_build: audio.length + dataAudio,
      phash_matches: phashHits.length,
      phash: phashInfo,
      manifest_entries: (manifest.files || []).length,
      refs_local: existsSync(refsDir) ? local.length : null,
      refs_not_in_manifest: notInManifest,
      manifest_missing_locally: missingLocally,
      dist_files: distFiles.length,
      dist_game_built: distHasGame(),
      lab_only_build: build.labOnly,
      data_image_literals: dataImageLiterals,
      text_snippets_checked: snippets.length,
      matches: [...inBuild, ...dataImages, ...textHits, ...images, ...audio, ...inRepo, ...phashHits].slice(0, 50),
    },
  });
  console.log(`hashes: ${refs.size} reference (${(manifest.files || []).length} manifest, ${local.length} local), ${distFiles.length} dist files, ${repoFiles.length} project files scanned${build.labOnly ? ' [lab-only build: game entry pending]' : ''}`);
  if (notInManifest.length) console.log(`note: ${notInManifest.length} local ref file(s) not in the manifest (regenerate tools/refs.manifest.json): ${notInManifest.slice(0, 5).join(', ')}`);
  for (const m of [...inBuild, ...dataImages, ...textHits, ...images, ...audio, ...inRepo, ...phashHits].slice(0, 20)) console.error(`  ${m}`);
  verdict(TOOL, passed, passed ? `0 reference files, 0 images, 0 audio files in dist/ (${distFiles.length} files), 0 copies outside Docs/refs/, 0 perceptual matches (${phashInfo.images_checked ?? 0} images vs ${phashInfo.ref_hashes ?? 0} refs)` : failures.join('; '));
  return passed ? 0 : 1;
});
