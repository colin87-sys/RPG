// SessionStart (compact) hook: re-inject the read order from CLAUDE.md section 1.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const md = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'CLAUDE.md'), 'utf8');
const m = md.match(/## 1\. Read order[\s\S]*?(?=\n## 2\.)/);
console.log(m ? m[0] : 'Read contrail/CLAUDE.md first.');
