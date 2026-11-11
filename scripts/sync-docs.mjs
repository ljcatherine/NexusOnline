// Copies docs/**/*.md from the public ljcatherine/Nexus repo into src/docs/.
// Run with `npm run docs` after the docs change, then commit src/docs.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteLink } from '../src/lib/docs.mjs';

const out = fileURLToPath(new URL('../src/docs/', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'nexus-docs-'));

try {
  execFileSync('git', ['clone', '--quiet', '--depth', '1', 'https://github.com/ljcatherine/Nexus.git', tmp], { stdio: 'inherit' });
  rmSync(out, { recursive: true, force: true });
  cpSync(join(tmp, 'docs'), out, { recursive: true, filter: (src) => !/\.(?!md$)[^\\/]+$/i.test(src) });

  let files = 0;
  for (const entry of readdirSync(out, { recursive: true })) {
    if (!String(entry).endsWith('.md')) continue;
    const file = join(out, String(entry));
    const rel = String(entry).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8')
      // The site calls the PS5 app NexusAI. Plain "PS5LM" stays where it names real paths or versions.
      .replaceAll('PS5LM Plus', 'NexusAI')
      // Point relative links at the site's /docs pages (inline links and reference definitions).
      .replace(/\]\(([^)\s]+)\)/g, (m, url) => `](${rewriteLink(url, rel)})`)
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (m, pre, url) => pre + rewriteLink(url, rel));
    writeFileSync(file, text);
    files++;
  }
  console.log(`Synced ${files} docs into src/docs/`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
