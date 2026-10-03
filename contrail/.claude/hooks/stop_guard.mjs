// Stop hook (GAME_FORGE B.10): block stopping unless ALLOW_STOP exists or the session window has passed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(dir, 'ALLOW_STOP'))) process.exit(0);
try {
  const w = JSON.parse(readFileSync(join(dir, 'session_window.json'), 'utf8'));
  if (!w.until || Date.now() > Date.parse(w.until)) process.exit(0);
} catch { process.exit(0); } // no window file: do not block
console.log(JSON.stringify({ decision: 'block', reason: 'Do not stop. Take the next item from contrail/Docs/TODO.md. If empty, run npm run acceptance and queue fixes.' }));
