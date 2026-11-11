// Copies docs/**/*.md from the public ljcatherine/Nexus repo into src/docs/.
// Run with `npm run docs` after the docs change, then commit src/docs.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteLink } from '../src/lib/docs.mjs';

const out = fileURLToPath(new URL('../src/docs/', import.meta.url));

// GitHub-style heading anchor, matching the ids the site puts on headings.
const anchor = (text) => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The site's CSP doesn't allow the Mermaid library, so a straight-chain flowchart becomes a
// styled list of steps, linked to the "## N. ..." sections. Anything else stays a code block.
function flowchartToSteps(code, markdown) {
  const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!/^(flowchart|graph)\s+(TD|TB|LR)\b/.test(lines[0] ?? '')) return null;
  const labels = new Map(), next = new Map(), incoming = new Set();
  const node = /([A-Za-z0-9_]+)(?:\["([^"]+)"\]|\[([^\]]+)\])?/g;
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s*-->\s*/);
    const ids = parts.map((p) => {
      node.lastIndex = 0;
      const m = node.exec(p);
      if (!m) return null;
      if (m[2] || m[3]) labels.set(m[1], m[2] || m[3]);
      return m[1];
    });
    if (ids.includes(null)) return null;
    for (let i = 0; i < ids.length - 1; i++) {
      if (next.has(ids[i]) || incoming.has(ids[i + 1])) return null; // branches: not a chain
      next.set(ids[i], ids[i + 1]);
      incoming.add(ids[i + 1]);
    }
  }
  const start = [...labels.keys()].find((id) => !incoming.has(id));
  const order = [];
  for (let id = start; id && order.length <= labels.size; id = next.get(id)) order.push(id);
  if (order.length !== labels.size) return null;

  const sections = new Map([...markdown.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)].map((m) => [m[1], `${m[1]}-${anchor(m[2])}`]));
  const items = order.map((id) => {
    const [, num, text] = labels.get(id).match(/^(\d+)\s*[·.:-]\s*(.+)$/) ?? [null, '', labels.get(id)];
    const body = `<span class="flow-n">${esc(num || '•')}</span><span class="flow-t">${esc(text)}</span>`;
    const href = sections.get(num);
    return `  <li>${href ? `<a href="#${href}">${body}</a>` : `<span class="flow-s">${body}</span>`}</li>`;
  });
  return `<ol class="flow">\n${items.join('\n')}\n</ol>`;
}
const tmp = mkdtempSync(join(tmpdir(), 'nexus-docs-'));

try {
  // NEXUS_DOCS_REPO can point at a local checkout to preview unpushed docs.
  const source = process.env.NEXUS_DOCS_REPO || 'https://github.com/ljcatherine/Nexus.git';
  execFileSync('git', ['clone', '--quiet', '--depth', '1', source, tmp], { stdio: 'inherit' });
  rmSync(out, { recursive: true, force: true });
  cpSync(join(tmp, 'docs'), out, { recursive: true, filter: (src) => !/\.(?!md$)[^\\/]+$/i.test(src) });

  let files = 0;
  for (const entry of readdirSync(out, { recursive: true })) {
    if (!String(entry).endsWith('.md')) continue;
    const file = join(out, String(entry));
    const rel = String(entry).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8')
      .replace(/\r\n/g, '\n')
      // Point relative links at the site's /docs pages (inline links and reference definitions).
      .replace(/\]\(([^)\s]+)\)/g, (m, url) => `](${rewriteLink(url, rel)})`)
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/gm, (m, pre, url) => pre + rewriteLink(url, rel))
      .replace(/^```mermaid\n([\s\S]*?)^```$/gm, (block, code, offset, md) => flowchartToSteps(code, md) ?? block);
    writeFileSync(file, text);
    files++;
  }
  console.log(`Synced ${files} docs into src/docs/`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
