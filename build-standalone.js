/**
 * Build the single-file offline `LuoguMarkdownEditor.html`.
 *
 * The repo keeps `index.html` as a fully-inlined single-file build (CSS embedded with
 * base64 fonts, all JS embedded). This script performs an in-place merge:
 *   - swaps the inlined app stylesheet for the current `src/styles.css`
 *   - swaps the inlined Luogu source scripts for the current `src/*.js`
 * so editing the source under `src/` and re-running this script updates the bundled file.
 *
 * Usage: node build-standalone.js [output.html]
 *        default output: LuoguMarkdownEditor.html
 */
const fs = require('fs');
const path = require('path');

const baseDir = __dirname;
const outPath = path.join(baseDir, process.argv[2] || 'LuoguMarkdownEditor.html');

let indexHtml = fs.readFileSync(path.join(baseDir, 'index.html'), 'utf8');

// ---- 1. Replace the app <style> block (it contains a unique marker comment) ----
const appCss = fs.readFileSync(path.join(baseDir, 'src/styles.css'), 'utf8');
const STYLE_MARKER = 'Luogu Markdown + KaTeX Editor - Windows & Web Stylesheet';

function replaceStyleBlock(html, marker, newContent) {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('style marker not found: ' + marker);
  const open = html.lastIndexOf('<style>', idx);
  if (open === -1) throw new Error('style open tag not found for: ' + marker);
  const start = open + '<style>'.length;
  const close = html.indexOf('</style>', start);
  if (close === -1) throw new Error('style close tag not found for: ' + marker);
  return html.slice(0, start) + newContent + html.slice(close);
}

indexHtml = replaceStyleBlock(indexHtml, STYLE_MARKER, appCss);

// ---- 2. Replace each inlined Luogu source <script> block (matched by leading comment) ----
function replaceScriptBlock(html, marker, newContent) {
  const idx = html.indexOf(marker);
  if (idx === -1) throw new Error('script marker not found: ' + marker);
  const open = html.lastIndexOf('<script>', idx);
  if (open === -1) throw new Error('script open tag not found for: ' + marker);
  const start = open + '<script>'.length;
  const close = html.indexOf('</script>', start);
  if (close === -1) throw new Error('script close tag not found for: ' + marker);
  return html.slice(0, start) + newContent + html.slice(close);
}

const scripts = [
  { marker: 'Luogu Markdown + KaTeX Parser & Renderer', file: 'src/luogu-parser.js' },
  { marker: 'Luogu Markdown Linter & Typography Engine', file: 'src/luogu-linter.js' },
  { marker: 'KaTeX Formula Assistant & Cheatsheet Library', file: 'src/luogu-math-cheatsheet.js' },
  { marker: 'Luogu Markdown Preset Templates', file: 'src/luogu-templates.js' },
  { marker: 'Luogu Markdown Editor Main Controller', file: 'src/editor.js' },
];

for (const s of scripts) {
  const content = fs.readFileSync(path.join(baseDir, s.file), 'utf8');
  indexHtml = replaceScriptBlock(indexHtml, s.marker, content);
}

fs.writeFileSync(outPath, indexHtml, 'utf8');
console.log('Rebuilt standalone single-file: ' + outPath +
  ' (Size: ' + Math.round(indexHtml.length / 1024) + ' KB)');
