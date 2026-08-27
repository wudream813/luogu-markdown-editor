/**
 * Build the single-file offline `LuoguMarkdownEditor.html`.
 *
 * `index.html` is the DEVELOPMENT shell: plain markup that references the real
 * sources via <link href="..."> and <script src="...">. This script reads that
 * shell and inlines every referenced asset to produce a self-contained file that
 * runs from `file://` with no network access.
 *
 * The data flows strictly one way:
 *
 *     index.html + src/** + assets/**   ->   LuoguMarkdownEditor.html
 *
 * The previous version instead rewrote the already-inlined `index.html` in place,
 * so index.html was both the input and (effectively) an output. That made the two
 * 928 KB files silently drift apart — index.html was in fact still shipping an old
 * copy of the parser — and turned a one-line CSS change into a 928 KB diff.
 *
 * KaTeX fonts are embedded as base64 data: URIs, reproducing the exact bytes the
 * hand-inlined build used to contain.
 *
 * Usage: node build-standalone.js [output.html]
 *        default output: LuoguMarkdownEditor.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const baseDir = __dirname;
const outPath = path.resolve(baseDir, process.argv[2] || 'LuoguMarkdownEditor.html');

const FONT_MIME = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

function read(rel) {
  const abs = path.join(baseDir, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`referenced asset does not exist: ${rel}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Replace url(...) references in a stylesheet with base64 data: URIs so the
 * stylesheet carries its own fonts.
 *
 * Only woff2 is embedded. Every browser that can run this editor supports woff2,
 * so also embedding the woff/ttf fallbacks would roughly triple the artifact
 * (~2.0 MB vs ~0.9 MB) for bytes no browser would ever fetch. The alternative
 * sources are dropped rather than left as relative paths, because a relative
 * font URL cannot resolve from a single file opened via file://.
 */
function inlineCssAssets(css, cssRelDir) {
  // Drop non-woff2 alternatives from multi-source `src:` lists first.
  const withoutFallbacks = css.replace(
    /,\s*url\([^)]*\.(?:woff|ttf|otf)\)\s*format\((["']?)(?:woff|truetype|opentype)\1\)/gi,
    ''
  );

  return withoutFallbacks.replace(/url\(([^)]+)\)/g, (match, rawRef) => {
    const ref = rawRef.trim().replace(/^["']|["']$/g, '');
    // Already self-contained or remote: leave untouched.
    if (/^(?:data:|https?:|\/\/)/i.test(ref)) return match;

    const assetRel = path.posix.join(cssRelDir, ref.split('?')[0].split('#')[0]);
    const assetAbs = path.join(baseDir, assetRel);
    if (!fs.existsSync(assetAbs)) return match;

    const ext = path.extname(assetAbs).toLowerCase();
    const mime = FONT_MIME[ext];
    if (!mime) return match;

    const b64 = fs.readFileSync(assetAbs).toString('base64');
    return `url("data:${mime};base64,${b64}")`;
  });
}

/** Guard against a nested </script> prematurely closing the inlined block. */
function escapeScript(js) {
  return js.replace(/<\/script>/gi, '<\\/script>');
}

function build() {
  const shellPath = path.join(baseDir, 'index.html');
  let html = fs.readFileSync(shellPath, 'utf8');

  const inlinedStyles = [];
  const inlinedScripts = [];

  // ---- Inline <link rel="stylesheet" href="..."> ----
  html = html.replace(
    /[ \t]*<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi,
    (tag) => {
      const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
      if (!hrefMatch) return tag;
      const href = hrefMatch[1];
      if (/^(?:https?:)?\/\//i.test(href) || href.startsWith('data:')) {
        throw new Error(
          `remote stylesheet in index.html breaks offline mode: ${href}`
        );
      }
      const css = inlineCssAssets(read(href), path.posix.dirname(href));
      inlinedStyles.push(`${href} (${Math.round(css.length / 1024)} KB)`);
      return `  <style>${css}</style>`;
    }
  );

  // ---- Inline <script src="..."></script> ----
  html = html.replace(
    /[ \t]*<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (tag, pre, src) => {
      if (/^(?:https?:)?\/\//i.test(src) || src.startsWith('data:')) {
        throw new Error(`remote script in index.html breaks offline mode: ${src}`);
      }
      const js = read(src);
      inlinedScripts.push(`${src} (${Math.round(js.length / 1024)} KB)`);
      return `  <script>${escapeScript(js)}</script>`;
    }
  );

  // ---- Sanity checks: the artifact must be genuinely self-contained ----
  const leftoverLink = html.match(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/i);
  if (leftoverLink) throw new Error(`un-inlined stylesheet remains: ${leftoverLink[0]}`);

  const leftoverScript = html.match(/<script\b[^>]*\bsrc=["'][^"']+["'][^>]*>/i);
  if (leftoverScript) throw new Error(`un-inlined script remains: ${leftoverScript[0]}`);

  const remote = html.match(/(?:https?:)?\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)[^"')\s]*/i);
  if (remote) throw new Error(`external CDN reference remains: ${remote[0]}`);

  // The artifact embeds KaTeX and Prism, both MIT. MIT requires the copyright
  // notice to travel with the code, and this single file is how most users will
  // receive it — so state it in the file itself rather than only in the repo.
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8')).version;
  const banner = `<!--
  洛谷 Markdown & KaTeX 实时预览编辑器  v${pkgVersion}
  https://github.com/wudream813/luogu-markdown-editor
  Copyright (c) 2026 wudream813 — MIT License

  本文件为离线单文件构建产物，内联了以下 MIT 许可的第三方组件：
    - KaTeX 0.18.4   Copyright (c) 2013-2020 Khan Academy and other contributors
                     https://katex.org/            https://github.com/KaTeX/KaTeX/blob/main/LICENSE
    - Prism 1.30.0   Copyright (c) 2012 Lea Verou
                     https://prismjs.com/          https://github.com/PrismJS/prism/blob/master/LICENSE

  再分发本文件时请保留此声明。完整条款见仓库 THIRD-PARTY-NOTICES.md。
-->
`;
  html = html.replace(/^(<!DOCTYPE html>\s*\n?)/i, `$1${banner}`);

  fs.writeFileSync(outPath, html);

  console.log('Inlined stylesheets:');
  inlinedStyles.forEach((s) => console.log('  -', s));
  console.log('Inlined scripts:');
  inlinedScripts.forEach((s) => console.log('  -', s));
  console.log(
    `\nBuilt ${path.relative(baseDir, outPath)} (${Math.round(html.length / 1024)} KB) ` +
    `from index.html (${Math.round(fs.readFileSync(shellPath, 'utf8').length / 1024)} KB shell)`
  );
}

try {
  build();
} catch (err) {
  console.error('Build failed:', err.message);
  process.exit(1);
}
