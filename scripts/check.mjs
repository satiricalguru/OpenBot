// Syntax-checks every JS file without running it (used by CI and `npm run check`).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['server', 'public/js', 'electron', 'scripts'];
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.(m?js|cjs)$/.test(p) && files.push(p); });
roots.forEach(walk);
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(`✗ ${f}\n${e.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} files OK`);
process.exit(bad ? 1 : 0);
