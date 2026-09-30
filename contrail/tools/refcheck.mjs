// npm run refcheck [-- --build]
// Fails if any reference file (Docs/refs/** when present + every hash in tools/refs.manifest.json)
// appears in dist/ (whole-file SHA-256, embedded data:image literals, and text snippets of local
// text refs), if dist/ ships ANY image file (the game ships zero images), or if a reference file
// was copied anywhere else in the project (src/, look/, lab/, Docs/ minus Docs/refs/, tools/, ...).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { updateChecks } from './lib/checks.mjs';
import { distHasGame, ensureDist } from './lib/server.mjs';
import { ROOT, parseArgs, rel, runTool, sha256, sha256File, utcIso, verdict, walkFiles } from './lib/util.mjs';

const TOOL = 'refcheck';
const args = parseArgs(undefined, { booleans: ['build'] });
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
  const inBuild = [], images = [], dataImages = [], textHits = [];
  let dataImageLiterals = 0;
  for (const f of distFiles) {
    const buf = readFileSync(f);
    const h = sha256(buf);
    if (refs.has(h)) inBuild.push(`${rel(f)} == ${refs.get(h)}`);
    const ext = extname(f).toLowerCase();
    if (IMAGE_EXT.has(ext)) images.push(`${rel(f)} (${buf.length} B)`);
    if (TEXT_EXT.has(ext)) {
      const text = buf.toString('utf8');
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

  const failures = [];
  if (inBuild.length) failures.push(`${inBuild.length} reference file(s) in dist/`);
  if (dataImages.length) failures.push(`${dataImages.length} reference image(s) embedded as data: URLs in dist/`);
  if (textHits.length) failures.push(`${textHits.length} reference text excerpt(s) in dist/`);
  if (images.length) failures.push(`${images.length} image file(s) in dist/ (the game ships zero images)`);
  if (inRepo.length) failures.push(`${inRepo.length} reference file(s) copied outside Docs/refs/`);
  const passed = failures.length === 0;
  await updateChecks({
    refcheck: {
      utc: utcIso(),
      passed,
      status: passed ? 'pass' : 'fail',
      ref_files_in_build: inBuild.length + dataImages.length + textHits.length,
      images_in_build: images.length,
      ref_files_in_repo: inRepo.length,
      manifest_entries: refs.size && (manifest.files || []).length,
      refs_local: existsSync(refsDir) ? local.length : null,
      refs_not_in_manifest: notInManifest,
      manifest_missing_locally: missingLocally,
      dist_files: distFiles.length,
      dist_game_built: distHasGame(),
      lab_only_build: build.labOnly,
      data_image_literals: dataImageLiterals,
      text_snippets_checked: snippets.length,
      matches: [...inBuild, ...dataImages, ...textHits, ...images, ...inRepo].slice(0, 50),
    },
  });
  console.log(`hashes: ${refs.size} reference (${(manifest.files || []).length} manifest, ${local.length} local), ${distFiles.length} dist files, ${repoFiles.length} project files scanned${build.labOnly ? ' [lab-only build: game entry pending]' : ''}`);
  if (notInManifest.length) console.log(`note: ${notInManifest.length} local ref file(s) not in the manifest (regenerate tools/refs.manifest.json): ${notInManifest.slice(0, 5).join(', ')}`);
  for (const m of [...inBuild, ...dataImages, ...textHits, ...images, ...inRepo].slice(0, 20)) console.error(`  ${m}`);
  verdict(TOOL, passed, passed ? `0 reference files and 0 images in dist/ (${distFiles.length} files), 0 copies outside Docs/refs/` : failures.join('; '));
  return passed ? 0 : 1;
});
