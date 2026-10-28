export type SourceSearchInput = { query: string; pathPrefix: string; fileOffset: number; startLine: number }
export type SourceSearchResult = {
  matches: { path: string; line: number; text: string; before?: string; after?: string }[]
  errors: { path: string; error: string }[]
  skippedFiles: number
  truncated: boolean
  next: SourceSearchInput | null
}

/** One sandbox process; user input is JSON data, never interpolated into executable code. */
export const SOURCE_SEARCH_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const [root, raw] = process.argv.slice(1);
const input = JSON.parse(raw);
const { query, pathPrefix, fileOffset, startLine } = input;
const files = [], errors = [], matches = [];
let skippedFiles = 0;
const excluded = new Set(['node_modules','dist','.git','.pi','.agents','.codex','.claude','vendor','assets']);
if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Symlink source root refused');
async function walk(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix + entry.name;
    if (entry.isSymbolicLink() || excluded.has(entry.name.toLowerCase()) || entry.name.toLowerCase().startsWith('.env')) { skippedFiles++; continue; }
    if (entry.isDirectory()) {
      if (!pathPrefix || pathPrefix.startsWith(rel + '/') || rel.startsWith(pathPrefix)) await walk(path.join(dir, entry.name), rel + '/');
    } else if (entry.isFile() && rel.startsWith(pathPrefix)) {
      if (!/\.(tsx?|jsx?|mjs|cjs|json|html|css|md|txt|ya?ml|svg)$/.test(rel) || /\.min\./.test(rel) || /(^|\/)AGENTS\.md$/i.test(rel)) { skippedFiles++; continue; }
      files.push(rel);
    }
  }
}
await walk(root);
files.sort();
const end = Math.min(files.length, fileOffset + 50);
let next = end < files.length ? { ...input, fileOffset: end, startLine: 1 } : null;
outer: for (let offset = fileOffset; offset < end; offset++) {
  const rel = files[offset];
  try {
    const full = path.join(root, rel);
    const stat = await fs.lstat(full);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512000) { skippedFiles++; continue; }
    const content = await fs.readFile(full, 'utf8');
    if (content.includes('\0')) { skippedFiles++; continue; }
    const lines = content.split('\n');
    for (let line = offset === fileOffset ? startLine - 1 : 0; line < lines.length; line++) {
      const at = lines[line].indexOf(query);
      if (at < 0) continue;
      matches.push({ path: rel, line: line + 1, text: lines[line].slice(Math.max(0, at - 80), at + query.length + 120), before: lines[line - 1]?.slice(0, 160), after: lines[line + 1]?.slice(0, 160) });
      if (matches.length === 20) {
        next = line + 1 < lines.length ? { ...input, fileOffset: offset, startLine: line + 2 }
          : offset + 1 < files.length ? { ...input, fileOffset: offset + 1, startLine: 1 } : null;
        break outer;
      }
    }
  } catch (error) { errors.push({ path: rel, error: error.message }); }
}
console.log(JSON.stringify({ matches, errors, skippedFiles, truncated: next !== null, next }));
`
