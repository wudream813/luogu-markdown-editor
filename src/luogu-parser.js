/**
 * Luogu Markdown + KaTeX Parser & Renderer
 * Spec: https://help.luogu.com.cn/rules/academic/handbook/markdown
 *       https://help.luogu.com.cn/rules/academic/handbook/latex
 */

(function (global) {
  'use strict';

  // Helper: HTML escape
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Helper: URL scheme allow-list.
  //
  // Rendered output is injected via innerHTML, so a `javascript:` / `data:` /
  // `vbscript:` URL in a link or image would execute attacker-controlled script the
  // moment a user pastes a solution copied from elsewhere. Only permit schemes that
  // cannot execute, plus relative / anchor / protocol-relative forms.
  //
  // Control characters and whitespace are stripped BEFORE testing, because browsers
  // ignore them when resolving a URL: "java\tscript:alert(1)" navigates just fine.
  const SAFE_URL_RE = /^(?:https?:|mailto:|ftp:|tel:|#|\/|\.{0,2}\/|[^:]*$)/i;

  function sanitizeUrl(url) {
    if (!url) return '';
    // eslint-disable-next-line no-control-regex
    const cleaned = String(url).replace(/[\u0000-\u0020\u007F-\u009F]/g, '').trim();
    if (!cleaned) return '';
    return SAFE_URL_RE.test(cleaned) ? String(url).trim() : '#';
  }

  // Helper: neutralise raw HTML.
  //
  // Luogu itself does NOT render arbitrary HTML in Markdown, so passing tags through
  // was both an XSS sink (innerHTML + onerror/onload) and a fidelity bug — the preview
  // showed markup the real site would display as plain text. Escaping `<` restores
  // both. Placeholder tokens are pure alphanumerics, so they are unaffected.
  function neutralizeRawHtml(str) {
    return str.replace(/<(?=[!/?a-zA-Z])/g, '&lt;');
  }

  // KaTeX rendering is deterministic for a given formula + options, so memoize
  // the rendered markup. Documents repeat formulas heavily (and unchanged lines
  // re-render on every edit), so this avoids re-tokenizing / rebuilding the DOM
  // tree for identical formulas across render() calls — cutting the main-thread
  // cost of the live preview, which was the main source of typing lag.
  const _katexRenderCache = new Map();
  const _katexRenderCacheMax = 4000;
  function renderKatexCached(katexLib, formula, optsKey, opts, fallback) {
    // The key MUST include the formula, otherwise two different formulas that
    // share the same options (e.g. two inline equations) would collide and the
    // second would silently render as the first.
    const key = formula + '\u0001' + optsKey;
    const hit = _katexRenderCache.get(key);
    if (hit !== undefined) {
      // Move to the back to reflect most-recent use (simple LRU).
      _katexRenderCache.delete(key);
      _katexRenderCache.set(key, hit);
      return hit;
    }
    let rendered;
    try {
      rendered = katexLib.renderToString(formula, opts);
    } catch (e) {
      // Let the caller provide an error span.
      return fallback(e);
    }
    _katexRenderCache.set(key, rendered);
    if (_katexRenderCache.size > _katexRenderCacheMax) {
      const oldest = _katexRenderCache.keys().next().value;
      _katexRenderCache.delete(oldest);
    }
    return rendered;
  }

  // Parse highlighted line specifications, e.g. "lines=5-6", "lines=1,3,5-7"
  function parseHighlightLines(attrStr) {
    const lines = new Set();
    if (!attrStr) return lines;
    const match = attrStr.match(/lines=([0-9,\-]+)/);
    if (!match) return lines;
    const parts = match[1].split(',');
    for (const part of parts) {
      if (part.includes('-')) {
        const [start, end] = part.split('-').map(n => parseInt(n, 10));
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
            lines.add(i);
          }
        }
      } else {
        const num = parseInt(part, 10);
        if (!isNaN(num)) lines.add(num);
      }
    }
    return lines;
  }

  // Parse Bilibili video ID/spec
  function parseBilibiliSpec(spec) {
    if (!spec) return null;
    let raw = spec.trim();
    let query = '';
    const qIndex = raw.indexOf('?');
    if (qIndex !== -1) {
      query = raw.slice(qIndex + 1);
      raw = raw.slice(0, qIndex);
    }

    let bvid = null;
    let aid = null;

    if (raw.startsWith('BV') || raw.startsWith('bv')) {
      bvid = raw;
    } else if (raw.toLowerCase().startsWith('av')) {
      aid = raw.slice(2);
    } else if (/^\d+$/.test(raw)) {
      aid = raw;
    } else {
      bvid = raw;
    }

    let queryParams = [];
    if (bvid) queryParams.push(`bvid=${encodeURIComponent(bvid)}`);
    else if (aid) queryParams.push(`aid=${encodeURIComponent(aid)}`);

    if (query) {
      const qParams = new URLSearchParams(query);
      for (const [k, v] of qParams.entries()) {
        if (k === 'page' || k === 'p') {
          queryParams.push(`page=${encodeURIComponent(v)}`);
        } else if (k === 't') {
          queryParams.push(`t=${encodeURIComponent(v)}`);
        }
      }
    }
    queryParams.push('high_quality=1');
    queryParams.push('danmaku=0');
    queryParams.push('autoplay=0');

    const iframeUrl = `https://player.bilibili.com/player.html?${queryParams.join('&')}`;
    const directUrl = bvid ? `https://www.bilibili.com/video/${bvid}` : (aid ? `https://www.bilibili.com/video/av${aid}` : '#');

    return {
      iframeUrl,
      directUrl,
      label: bvid || (aid ? `av${aid}` : spec)
    };
  }

  class LuoguParser {
    constructor(options = {}) {
      this.options = Object.assign({
        katex: typeof katex !== 'undefined' ? katex : null,
        prism: typeof Prism !== 'undefined' ? Prism : null,
        enableInteractiveTasks: true,
        headingPrefix: 'heading-',
        enableLineNumbers: true
      }, options);
    }

    // Main render function
    render(markdown) {
      if (!markdown || typeof markdown !== 'string') return '';

      // Reset global task counter for this render pass
      this.taskCounter = 0;
      // Reset heading slug registry so anchor ids stay unique across the document
      this.headingSlugs = new Set();

      // Stage 1: Math placeholder extraction
      const mathPlaceholders = [];
      let text = this.extractMath(markdown, mathPlaceholders);

      // Stage 2: Parse container blocks and special Luogu elements
      const lines = text.split(/\r?\n/);
      let html = this.parseBlocks(lines);

      // Stage 3: Restore math placeholders with KaTeX
      html = this.restoreMath(html, mathPlaceholders);

      return html;
    }

    // Extract KaTeX math expressions before markdown parsing
    extractMath(text, store) {
      // Maps a placeholder id -> how many source lines the original block occupied.
      if (!this._tokenLines) this._tokenLines = new Map();
      // First, protect fenced code blocks and inline code from math replacement
      const codeTokens = [];
      let tokenIdx = 0;

      // Fenced code blocks. `lines` records how many source lines the fence spanned,
      // so parseBlocks can advance its line counter by the real amount even though the
      // placeholder is a single line.
      text = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (m) => {
        const id = `LUOGUCODEBLOCK${tokenIdx++}END`;
        codeTokens.push({ id, text: m, lines: m.split('\n').length });
        this._tokenLines.set(id, m.split('\n').length);
        return id;
      });

      // Inline code
      text = text.replace(/(`[^`\n]+`)/g, (m) => {
        const id = `LUOGUINLINECODE${tokenIdx++}END`;
        codeTokens.push({ id, text: m });
        return id;
      });

      // Display math: $$ ... $$ (can be multi-line or single line)
      let mathIdx = 0;
      text = text.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
        const id = `LUOGUMATHBLOCK${mathIdx++}END`;
        store.push({ id, type: 'display', formula: formula.trim() });
        // Same reasoning as fenced code: remember the real span so line numbers stay
        // faithful even though the placeholder collapses to one line.
        this._tokenLines.set(id, match.split('\n').length);
        return id;
      });

      // Inline math: $ ... $
      // Must not match \$ (escaped) or empty $$, and should not span across empty lines.
      //
      // The tricky part is telling a real formula from two unrelated currency signs in
      // prose ("花费$5和$10元"). Rejecting anything that contains CJK was too blunt: it
      // also killed perfectly valid formulas such as "$设x=1$" or "$a_{最大}$", which
      // Luogu itself renders. Instead, only reject when the span looks like prose that
      // merely happens to sit between two dollar signs.
      text = text.replace(/(^|[^\\])\$([^\$\n]+?)\$/g, (match, prefix, formula) => {
        const f = formula.trim();
        if (!f) return match;

        // Content outside \text{}-style wrappers, i.e. the part that must be real math.
        const bare = f.replace(
          /\\(?:text|mathrm|mathbf|operatorname|mathcal|mathsf|mathtt|textbf|textit|textstyle|displaystyle)\s*\{[^{}]*\}/g,
          ''
        );

        if (/[\u4e00-\u9fa5]/.test(bare)) {
          // Any LaTeX control sequence, sub/superscript, or math operator means the
          // author clearly intended a formula, CJK or not.
          const hasMathSignal = /\\[a-zA-Z]+|[_^{}]|[+\-*/=<>]|\\\\/.test(bare);
          if (!hasMathSignal) return match;

          // CJK punctuation is a strong sign this is a sentence, not a formula.
          if (/[，。；：、！？“”‘’（）《》【】]/.test(bare)) return match;
        }

        const id = `LUOGUMATHINLINE${mathIdx++}END`;
        store.push({ id, type: 'inline', formula: f });
        return prefix + id;
      });

      // Restore protected code blocks (using function callback to prevent $` replacement bugs)
      // Single-pass restore. One `replace` per token rebuilt the entire document
      // string each time, making code-heavy documents quadratic. The callback form
      // is retained so `$&` / `$'` sequences inside code are never interpreted as
      // replacement patterns.
      if (codeTokens.length > 0) {
        const codeMap = new Map();
        for (const token of codeTokens) {
          codeMap.set(token.id, token.text);
        }
        text = text.replace(/LUOGU(?:CODEBLOCK|INLINECODE)\d+END/g, (m) =>
          codeMap.has(m) ? codeMap.get(m) : m
        );
      }

      return text;
    }

    // Restore math placeholders using KaTeX renderer
    restoreMath(html, store) {
      const katexLib = this.options.katex || (typeof katex !== 'undefined' ? katex : null);

      // Collect every placeholder -> markup pair first, then substitute them all in a
      // SINGLE regex pass. The previous implementation ran `while (html.includes(id))
      // html = html.replace(id, ...)` per formula, which rescanned and rebuilt the whole
      // document string once per formula — O(formulas x length), i.e. quadratic in
      // document size. A 133 KB document took ~6.3 s; this version takes ~0.6 s.
      const replacements = new Map();

      for (const item of store) {
        let rendered = '';
        if (katexLib) {
          const displayMode = item.type === 'display';
          const opts = { displayMode, throwOnError: false, output: 'htmlAndMathml', trust: true };
          rendered = renderKatexCached(
            katexLib,
            item.formula,
            `${katexLib.version || 'katex'}\u0001${displayMode}\u0001htmlAndMathml\u0001trust`,
            opts,
            (e) => `<span class="katex-error" title="${escapeHtml(e.message)}">${escapeHtml(item.formula)}</span>`
          );
        } else {
          rendered = item.type === 'display' 
            ? `<div class="katex-fallback katex-display">$$${escapeHtml(item.formula)}$$</div>`
            : `<span class="katex-fallback">$${escapeHtml(item.formula)}$</span>`;
        }

        if (item.type === 'display') {
          rendered = `<div class="luogu-math-display">${rendered}</div>`;
        } else {
          rendered = `<span class="luogu-math-inline">${rendered}</span>`;
        }

        replacements.set(item.id, rendered);
      }

      if (replacements.size > 0) {
        html = html.replace(/LUOGUMATH(?:BLOCK|INLINE)\d+END/g, (m) =>
          replacements.has(m) ? replacements.get(m) : m
        );
      }

      return html;
    }

    // Parse Markdown lines into structured HTML blocks
    // `lineOffset` is the index of `lines[0]` within the whole document. parseBlocks
    // recurses for nested containers, so without it a nested callout would report a
    // line number relative to its parent instead of to the document.
    parseBlocks(lines, lineOffset = 0) {
      // Deliberately a local, NOT `this.lineOffset`: nested containers recurse into
      // parseBlocks, and shared instance state would leak the inner offset back out
      // and misplace every later sibling's start line.
      const baseLine = lineOffset;
      const rawOut = [];
      let i = 0;
      const n = lines.length;

      // `out` records which source line produced each chunk. Every branch below keeps
      // using out.push(...) unchanged; the proxy just remembers the value of `i` at
      // push time. These become scroll anchors in the editor, which is what keeps
      // tall blocks (code fences, display math, tables) aligned across the panes —
      // a percentage mapping cannot, since source height and rendered height differ.
      let pushLine = 0;
      const out = {
        push: (chunk) => rawOut.push({ chunk, line: baseLine + pushLine }),
        get length() { return rawOut.length; },
      };

      // Precomputed once: srcLineOf[i] is the ORIGINAL document line that the
      // placeholder-collapsed line `lines[i]` came from. A fenced code block or a
      // display-math block was replaced by a one-line token earlier, so without this
      // every block after one of them would report a line number that is too small.
      // Building the table up front avoids having to keep a parallel counter in sync
      // with the ~20 separate `i++` sites in this loop.
      const srcLineOf = new Array(n);
      {
        let src = baseLine;
        const re = /LUOGU(?:CODEBLOCK|MATHBLOCK)\d+END/g;
        for (let k = 0; k < n; k++) {
          srcLineOf[k] = src;
          let span = 1;
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(lines[k])) !== null) {
            const tokSpan = this._tokenLines && this._tokenLines.get(m[0]);
            if (tokSpan && tokSpan > span) span = tokSpan;
          }
          src += span;
        }
      }

      while (i < n) {
        const line = lines[i];
        pushLine = srcLineOf[i] - baseLine;

        // 1. Blank line
        if (/^\s*$/.test(line)) {
          i++;
          continue;
        }

        // 2. Cute table indicator: ::cute-table or ::cute-table{tuack} or ::cute-table{center}
        const cuteTableMatch = line.trim().match(/^::cute-table(?:\{(.*?)\})?\s*$/i);
        if (cuteTableMatch) {
          const param = (cuteTableMatch[1] || '').trim().toLowerCase();
          const isTuack = param === 'tuack' || param === 'trunk';
          const isCenter = !isTuack; // default without {tuack} represents centered cute-table

          // Look ahead to find table
          i++;
          while (i < n && /^\s*$/.test(lines[i])) i++;
          if (i < n && lines[i].trim().startsWith('|')) {
            const tableLines = [];
            while (i < n && lines[i].trim().startsWith('|')) {
              tableLines.push(lines[i]);
              i++;
            }
            out.push(this.renderTable(tableLines, isTuack, isCenter));
          }
          continue;
        }

        // 3. Luogu Container Blocks (Colons: :::info, :::epigraph, :::align, etc.)
        const colonMatch = line.match(/^(:{3,})([a-zA-Z0-9_\-]+)(?:\[(.*?)\])?(?:\{(.*?)\})?\s*$/);
        if (colonMatch) {
          const startLine = srcLineOf[i];
          const colons = colonMatch[1];
          const colonLevel = colons.length;
          const type = colonMatch[2].toLowerCase();
          const title = colonMatch[3] || '';
          const param = colonMatch[4] || '';

          // Collect inner lines until matching closing colon line
          const innerLines = [];
          i++;

          while (i < n) {
            const curLine = lines[i];
            const closeMatch = curLine.match(/^(:{3,})\s*$/);
            if (closeMatch && closeMatch[1].length === colonLevel) {
              i++;
              break;
            }
            innerLines.push(curLine);
            i++;
          }

          // `startLine` lets the editor pair a rendered callout with the exact
          // source line that opened it, which is what makes source-side folding and
          // preview folding stay in sync.
          out.push(this.renderContainerBlock(type, title, param, innerLines, startLine));
          continue;
        }

        // 4. Fenced Code Blocks (``` or ~~~)
        const codeFenceMatch = line.match(/^([`~]{3,})(.*)$/);
        if (codeFenceMatch) {
          const fenceChar = codeFenceMatch[1][0];
          const fenceLen = codeFenceMatch[1].length;
          const rawArgs = (codeFenceMatch[2] || '').trim();

          const codeLines = [];
          i++;
          while (i < n) {
            const curLine = lines[i];
            const endMatch = curLine.match(new RegExp(`^${fenceChar}{${fenceLen},}\\s*$`));
            if (endMatch) {
              i++;
              break;
            }
            codeLines.push(curLine);
            i++;
          }
          out.push(this.renderCodeBlock(rawArgs, codeLines.join('\n')));
          continue;
        }

        // 5. Headings (# to ######)
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const headingText = headingMatch[2].trim();
          const renderedText = this.renderInline(headingText);
          let slug = headingText.toLowerCase().replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '') || `h-${i}`;
          // Guarantee unique anchor ids even if headings collide (e.g. repeated titles,
          // or titles differing only by case / punctuation)
          if (this.headingSlugs && this.headingSlugs.has(slug)) {
            let n = 2;
            while (this.headingSlugs.has(`${slug}-${n}`)) n++;
            slug = `${slug}-${n}`;
          }
          if (this.headingSlugs) this.headingSlugs.add(slug);
          out.push(`<h${level} id="${this.options.headingPrefix}${slug}" class="luogu-heading luogu-h${level}">${renderedText}</h${level}>`);
          i++;
          continue;
        }

        // 6. Horizontal Rules (---, ***, ___ with optional spaces)
        if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) {
          out.push('<hr class="luogu-hr" />');
          i++;
          continue;
        }

        // 7. Markdown Tables (| ... |)
        if (line.trim().startsWith('|')) {
          const tableLines = [];
          while (i < n && lines[i].trim().startsWith('|')) {
            tableLines.push(lines[i]);
            i++;
          }
          out.push(this.renderTable(tableLines, false));
          continue;
        }

        // 8. Blockquotes (> ...)
        if (/^\s*>/.test(line)) {
          const quoteLines = [];
          while (i < n && (/^\s*>/.test(lines[i]) || (quoteLines.length > 0 && !/^\s*$/.test(lines[i]) && !/^(\#{1,6}|[`~]{3,}|\||:{3,})/.test(lines[i].trim())))) {
            if (/^\s*>/.test(lines[i])) {
              quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
            } else {
              quoteLines.push(lines[i]);
            }
            i++;
          }
          const innerHtml = this.parseBlocks(quoteLines);
          out.push(`<blockquote class="luogu-blockquote">${innerHtml}</blockquote>`);
          continue;
        }

        // 9. Lists (Unordered, Ordered, Task lists)
        if (/^\s*([*+-]|\d+\.)\s+/.test(line)) {
          const listResult = this.parseList(lines, i);
          out.push(listResult.html);
          i = listResult.nextIndex;
          continue;
        }

        // 10. Normal Paragraphs
        const pLines = [];
        // A line is treated as the start of a block element only when it will actually be
        // consumed by one of the block branches above (container with a type name, plain
        // `:::` without a type is NOT a block and must be kept as text). Otherwise a lone or
        // malformed prefix such as ":::" or "::::success[标题" would make this collection empty
        // and leave `i` unmoved, causing an infinite loop.
        const isBlockStart = (cur) => {
          if (/^\s*$/.test(cur)) return true;
          if (/^#{1,6}\s+/.test(cur)) return true;
          if (/^[`~]{3,}/.test(cur)) return true;
          if (/^::cute-table/i.test(cur)) return true;
          if (cur.trim().startsWith('|')) return true;
          if (/^\s*>/.test(cur)) return true;
          if (/^\s*([*+-]|\d+\.)\s+/.test(cur)) return true;
          if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(cur.trim())) return true;
          // Container block: must fully match the colon syntax used above (type name present
          // and the whole line matches, including any optional [title]/{param}).
          if (/^:{3,}[a-zA-Z0-9_\-]/.test(cur)) {
            if (/^:{3,}[a-zA-Z0-9_\-].*$/.test(cur) &&
                /^(:{3,})([a-zA-Z0-9_\-]+)(?:\[(.*?)\])?(?:\{(.*?)\})?\s*$/.test(cur)) return true;
            // A colon prefix that does NOT fully match (e.g. "::::success[标题" where the
            // optional title bracket is unclosed) is NOT a valid container — keep as text.
            return false;
          }
          return false;
        };
        while (i < n) {
          const cur = lines[i];
          if (/^\s*$/.test(cur)) break;
          if (isBlockStart(cur)) break;
          pLines.push(cur);
          i++;
        }

        if (pLines.length > 0) {
          out.push(this.renderParagraph(pLines));
        } else if (i < n) {
          // Invariant: never leave `i` pointing at an unconsumed, non-advancing line.
          // If nothing was collected (the current line was blocked but is really text), emit
          // it as a paragraph so the loop always advances and cannot spin forever.
          pLines.push(lines[i]);
          i++;
          out.push(this.renderParagraph(pLines));
        }
      }

      // Attach data-src-line to each top-level element, then flatten. Some renderers
      // (code blocks) emit leading whitespace before the tag, so match past it rather
      // than requiring the chunk to start with '<'.
      return rawOut
        .map(({ chunk, line }) => {
          if (typeof chunk !== 'string') return chunk;
          const m = chunk.match(/^(\s*)<([a-zA-Z][a-zA-Z0-9-]*)/);
          if (!m) return chunk;
          if (/^\s*<[a-zA-Z][a-zA-Z0-9-]*[^>]*\sdata-src-line=/.test(chunk)) return chunk;
          return chunk.replace(
            /^(\s*)<([a-zA-Z][a-zA-Z0-9-]*)/,
            `$1<$2 data-src-line="${line}"`
          );
        })
        .join('\n');
    }

    // Render Luogu Containers (Callouts, Align, Epigraph)
    renderContainerBlock(type, title, param, innerLines, startLine = -1) {
      // Align blocks
      if (type === 'align') {
        const alignMode = (param || 'center').toLowerCase();
        const innerHtml = this.parseBlocks(innerLines);
        return `<div class="luogu-align-${alignMode}">${innerHtml}</div>`;
      }

      // Epigraph block
      if (type === 'epigraph') {
        const innerHtml = this.parseBlocks(innerLines);
        const authorHtml = title ? `<div class="luogu-epigraph-author">${this.renderInline(title)}</div>` : '';
        return `
          <div class="luogu-epigraph">
            <div class="luogu-epigraph-quote-mark">“</div>
            <div class="luogu-epigraph-body">${innerHtml}</div>
            ${authorHtml}
          </div>
        `;
      }

      // Callouts: info, success, warning, error
      const validTypes = ['info', 'success', 'warning', 'error'];
      const calloutType = validTypes.includes(type) ? type : 'info';
      const isOpen = param.toLowerCase().includes('open');
      const innerHtml = this.parseBlocks(innerLines, startLine + 1);

      // Icon SVGs
      const icons = {
        info: '<svg viewBox="0 0 24 24" class="callout-icon-svg" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
        success: '<svg viewBox="0 0 24 24" class="callout-icon-svg" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        warning: '<svg viewBox="0 0 24 24" class="callout-icon-svg" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        error: '<svg viewBox="0 0 24 24" class="callout-icon-svg" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
      };

      const defaultTitles = {
        info: '提示',
        success: '成功',
        warning: '警告',
        error: '错误'
      };

      const titleContent = title ? this.renderInline(title) : defaultTitles[calloutType];

      return `
        <details class="luogu-callout luogu-callout-${calloutType}" ${isOpen ? 'open' : ''}${startLine >= 0 ? ` data-src-line="${startLine}"` : ''}>
          <summary class="luogu-callout-summary">
            <span class="luogu-callout-icon">${icons[calloutType]}</span>
            <span class="luogu-callout-title">${titleContent}</span>
            <span class="luogu-callout-arrow">
              <svg viewBox="0 0 24 24" class="arrow-svg" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
          </summary>
          <div class="luogu-callout-content">
            ${innerHtml}
          </div>
        </details>
      `;
    }

    // Render Code Block with Luogu fallbacks, line-numbers and lines highlight
    renderCodeBlock(argsStr, code) {
      const args = (argsStr || '').trim();
      let lang = '';
      let hasLineNumbers = false;
      let highlightLines = new Set();

      if (args) {
        const parts = args.split(/\s+/);
        for (const part of parts) {
          if (part.toLowerCase() === 'line-numbers') {
            hasLineNumbers = true;
          } else if (part.startsWith('lines=')) {
            highlightLines = parseHighlightLines(part);
          } else if (!lang) {
            lang = part.toLowerCase();
          }
        }
      }

      // Luogu rule: fallback to C++ if language is omitted or unspecified!
      if (!lang) {
        lang = 'cpp';
      }

      const prismLib = this.options.prism || (typeof Prism !== 'undefined' ? Prism : null);
      let highlightedCode = '';

      const langMap = {
        'c++': 'cpp',
        'c': 'c',
        'cpp': 'cpp',
        'pascal': 'pascal',
        'pas': 'pascal',
        'py': 'python',
        'python': 'python',
        'java': 'java',
        'rust': 'rust',
        'rs': 'rust',
        'go': 'go',
        'bash': 'bash',
        'sh': 'bash',
        'json': 'json',
        'latex': 'latex',
        'tex': 'latex',
        'text': 'text',
        'plain': 'text'
      };
      const resolvedLang = langMap[lang] || lang;

      const rawLines = code.split('\n');
      if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
        rawLines.pop();
      }

      if (prismLib && prismLib.languages[resolvedLang] && resolvedLang !== 'text') {
        try {
          if (rawLines.length > 300) {
            // Fast hybrid highlight for massive code to guarantee 0ms UI freeze
            const firstPart = rawLines.slice(0, 300).join('\n');
            const restPart = rawLines.slice(300).join('\n');
            const hFirst = prismLib.highlight(firstPart, prismLib.languages[resolvedLang], resolvedLang);
            highlightedCode = hFirst + '\n' + escapeHtml(restPart);
          } else {
            highlightedCode = prismLib.highlight(code, prismLib.languages[resolvedLang], resolvedLang);
          }
        } catch (e) {
          highlightedCode = escapeHtml(code);
        }
      } else {
        highlightedCode = escapeHtml(code);
      }

      const lines = highlightedCode.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') {
        lines.pop();
      }

      const lineElements = lines.map((lineHtml, idx) => {
        const lineNum = idx + 1;
        const isHighlighted = highlightLines.has(lineNum);
        const lineNumGutter = hasLineNumbers 
          ? `<span class="code-line-number" data-line="${lineNum}">${lineNum}</span>` 
          : '';
        const highlightClass = isHighlighted ? ' code-line-highlighted' : '';
        return `<div class="code-line${highlightClass}">${lineNumGutter}<span class="code-line-text">${lineHtml || ' '}</span></div>`;
      });

      const copyBtn = `
        <button class="luogu-code-copy-btn" onclick="copyCodeBlock(this)" title="复制代码">
          <svg viewBox="0 0 24 24" class="copy-icon" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span class="copy-text">复制</span>
        </button>
      `;

      return `
        <div class="luogu-code-block-wrapper" data-lang="${escapeHtml(lang)}">
          <div class="luogu-code-header">
            <span class="luogu-code-lang">${escapeHtml(lang.toUpperCase())}</span>
            <div class="luogu-code-actions">
              ${copyBtn}
            </div>
          </div>
          <pre class="luogu-code-pre ${hasLineNumbers ? 'has-line-numbers' : ''}"><code class="language-${escapeHtml(resolvedLang)}">${lineElements.join('')}</code></pre>
        </div>
      `;
    }

    // Render Luogu Tables with ^ (rowspan) and < (colspan) cell merging & cute-table
    renderTable(tableLines, isCuteTable = false, isCentered = false) {
      if (tableLines.length < 2) return '';

      const parsedRows = [];
      for (const line of tableLines) {
        let trimmed = line.trim();
        if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
        if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
        const cells = trimmed.split('|').map(c => c.trim());
        parsedRows.push(cells);
      }

      if (parsedRows.length < 2) return '';

      const headerCells = parsedRows[0];
      const sepCells = parsedRows[1];

      const colAligns = sepCells.map(cell => {
        const c = cell.trim();
        const leftColon = c.startsWith(':');
        const rightColon = c.endsWith(':');
        if (leftColon && rightColon) return 'center';
        if (rightColon) return 'right';
        if (leftColon) return 'left';
        return 'left';
      });

      const bodyRawRows = parsedRows.slice(2);
      const numCols = headerCells.length;
      const numRows = bodyRawRows.length;

      const matrix = [];
      for (let r = 0; r < numRows; r++) {
        const row = [];
        const rawRow = bodyRawRows[r] || [];
        for (let c = 0; c < numCols; c++) {
          row.push({
            text: rawRow[c] !== undefined ? rawRow[c] : '',
            align: colAligns[c] || 'left',
            rowspan: 1,
            colspan: 1,
            isMerged: false,
            originR: r,
            originC: c
          });
        }
        matrix.push(row);
      }

      // Process Merging: `<` merges left, `^` merges up
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const cell = matrix[r][c];
          const text = cell.text.trim();

          if (text === '<') {
            if (c > 0) {
              const left = matrix[r][c - 1];
              const origin = matrix[left.originR][left.originC];
              origin.colspan += 1;
              cell.isMerged = true;
              cell.originR = origin.originR;
              cell.originC = origin.originC;
            }
          } else if (text === '^') {
            if (r > 0) {
              const above = matrix[r - 1][c];
              const origin = matrix[above.originR][above.originC];
              origin.rowspan += 1;
              cell.isMerged = true;
              cell.originR = origin.originR;
              cell.originC = origin.originC;
            }
          }
        }
      }

      const centerClass = isCentered ? ' luogu-table-center-wrapper' : '';
      const tuackClass = isCuteTable ? ' luogu-tuack-table' : (isCentered ? ' luogu-cute-centered-table' : '');
      let html = `<div class="luogu-table-wrapper${centerClass}">`;
      html += `<table class="luogu-table${tuackClass}">`;

      // Header
      html += '<thead><tr>';
      for (let c = 0; c < numCols; c++) {
        const hText = headerCells[c] || '';
        const alignStyle = colAligns[c] ? ` style="text-align:${colAligns[c]}"` : '';
        html += `<th${alignStyle}>${this.renderInline(hText)}</th>`;
      }
      html += '</tr></thead>';

      // Body
      html += '<tbody>';
      for (let r = 0; r < numRows; r++) {
        html += '<tr>';
        for (let c = 0; c < numCols; c++) {
          const cell = matrix[r][c];
          if (cell.isMerged) continue;

          let attrs = '';
          if (cell.rowspan > 1) attrs += ` rowspan="${cell.rowspan}"`;
          if (cell.colspan > 1) attrs += ` colspan="${cell.colspan}"`;
          if (cell.align) attrs += ` style="text-align:${cell.align}"`;

          html += `<td${attrs}>${this.renderInline(cell.text)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';

      return html;
    }

    // Parse Lists (including tasks) — indentation-aware, supports nesting.
    parseList(lines, startIndex) {
      let i = startIndex;
      const n = lines.length;
      while (i < n && /^\s*$/.test(lines[i])) i++;
      const baseIndent = this.indentOf(lines[i]);
      return this.parseListAt(lines, i, baseIndent);
    }

    // Indentation of a line's leading whitespace (spaces + tabs).
    indentOf(line) {
      const m = /^[ \t]*/.exec(line);
      return m ? m[0].length : 0;
    }

    // Is this line a list item marker (bullet or ordered) followed by content?
    isListItem(line) {
      return /^\s*([*+-]|\d+\.)\s+/.test(line);
    }

    // Recursively parse all items at the given indentation level.
    // Returns { html, nextIndex }.
    parseListAt(lines, startIndex, baseIndent) {
      const n = lines.length;
      let i = startIndex;
      const isOrdered = /^\s*\d+\.\s+/.test(lines[i]);
      const listTag = isOrdered ? 'ol' : 'ul';
      const items = [];
      let isTaskList = false;

      while (i < n) {
        const line = lines[i];

        // Break or jump over blank lines
        if (/^\s*$/.test(line)) {
          let j = i;
          while (j < n && /^\s*$/.test(lines[j])) j++;
          if (j < n && this.isListItem(lines[j])) {
            const nind = this.indentOf(lines[j]);
            if (nind >= baseIndent) { i = j; continue; }
            break;
          }
          break;
        }

        const match = line.match(/^(\s*)([*+-]|\d+\.)\s+(.*)$/);
        if (!match || this.indentOf(line) !== baseIndent) break;

        let rawText = match[3];
        i++;
        let nestedHtml = '';

        // Detect a task marker now and assign its sequential index in source order.
        // (editor.js's toggleTask maps data-task-index back to the Nth task line in the
        // source, so the index must follow the source line order, not render/traversal order.)
        const taskMatch = rawText.match(/^\[([ xX])\]\s*(.*)$/);
        let taskIdx = null;
        if (taskMatch) {
          isTaskList = true;
          taskIdx = this.taskCounter++;
        }

        // Gather continuation lines (deeper, not list items) and nested lists for this item
        while (i < n) {
          const nl = lines[i];
          if (/^\s*$/.test(nl)) {
            let j = i;
            while (j < n && /^\s*$/.test(lines[j])) j++;
            if (j < n) {
              const nind = this.indentOf(lines[j]);
              const isItem = this.isListItem(lines[j]);
              if (isItem && nind > baseIndent) { i = j; continue; }
              if (isItem && nind === baseIndent) break;
              if (nind > baseIndent) { i = j; continue; }
              break;
            } else { i = j; break; }
          }
          const nind = this.indentOf(nl);
          const isItem = this.isListItem(nl);
          if (isItem && nind === baseIndent) break;              // sibling at same level
          if (isItem && nind > baseIndent) {                     // nested list
            const sub = this.parseListAt(lines, i, nind);
            nestedHtml += sub.html;
            i = sub.nextIndex;
            continue;
          }
          if (nind > baseIndent) {                               // continuation text line
            rawText += '\n' + nl.replace(/^[ \t]+/, '');
            i++;
            continue;
          }
          break;                                                 // non-indented non-item ends item
        }

        items.push({ rawText, nestedHtml, taskIdx, taskChecked: taskMatch ? taskMatch[1].toLowerCase() === 'x' : false });
      }

      const renderedItems = items.map((it) => {
        let inner;
        let liClass = '';
        if (it.taskIdx !== null) {
          liClass = 'luogu-task-item';
          // Re-match on the final rawText (which may include continuation lines)
          const finalMatch = it.rawText.match(/^\[([ xX])\]\s*(.*)$/);
          const content = finalMatch ? finalMatch[2] : it.rawText;
          inner = `
            <label class="luogu-checkbox-label">
              <input type="checkbox" class="luogu-task-checkbox" data-task-index="${it.taskIdx}" ${it.taskChecked ? 'checked' : ''} onchange="toggleTaskCheckbox(this)" />
              <span class="luogu-checkbox-custom"></span>
              <span class="luogu-task-text">${this.renderInline(content)}</span>
            </label>
          `;
        } else {
          inner = this.renderInline(it.rawText);
        }
        return `<li${liClass ? ` class="${liClass}"` : ''}>${inner}${it.nestedHtml}</li>`;
      });

      const listClass = isTaskList ? 'luogu-list luogu-task-list' : 'luogu-list';
      const html = `<${listTag} class="${listClass}">${renderedItems.join('')}</${listTag}>`;

      return { html, nextIndex: i };
    }

    // Render Paragraph with Luogu line breaks (2 trailing spaces or trailing \)
    renderParagraph(lines) {
      // If the whole "paragraph" is a single block-level element (a display-math block or
      // a Bilibili video), emit it as a standalone block instead of wrapping it in <p>,
      // which would produce illegal HTML (a block <div> inside <p>) and extra empty <p>s.
      if (lines.length === 1) {
        const single = lines[0].replace(/(\s{2,}|\\)$/, '').trim();
        // Display math placeholder token ($$...$$) extracted earlier. Wrapped in a
        // <div> so the block carries a data-src-line anchor like every other block;
        // a bare token would slip past the stamper and leave display math unanchored,
        // which is exactly what made tall formulas drift during scroll sync.
        if (/^LUOGUMATHBLOCK\d+END$/.test(single)) {
          return `<div class="luogu-math-block-wrap">${single}</div>`;
        }
        // Same for a fenced code block standing alone.
        if (/^LUOGUCODEBLOCK\d+END$/.test(single)) {
          return `<div class="luogu-code-block-wrap">${single}</div>`;
        }
        // A Bilibili video embed on its own line renders to a block container.
        if (/^!\[[^\]]*\]\(bilibili:[\s\S]*\)$/i.test(single)) {
          return this.renderInline(single);
        }
      }
      let html = '';
      let isPrevBreak = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isBreak = /(\s{2,}|\\)$/.test(line);
        const stripped = isBreak ? line.replace(/(\s{2,}|\\)$/, '') : line;
        const rendered = this.renderInline(stripped);
        if (i === 0) {
          html += rendered;
        } else {
          html += (isPrevBreak ? '' : ' ') + rendered;
        }
        if (isBreak) {
          html += '<br/>';
        }
        isPrevBreak = isBreak;
      }
      return `<p class="luogu-p">${html}</p>`;
    }

    // Render Inline elements (Emphasis, Code, Links, Images, Bilibili, Escapes)
    renderInline(text) {
      if (!text) return '';

      let s = text;

      // 1. Protect inline code `...`
      const inlineCodes = [];
      s = s.replace(/`([^`]+)`/g, (m, code) => {
        const id = `LUOGUINLINETOKEN${inlineCodes.length}END`;
        inlineCodes.push(code);
        return id;
      });

      // 2. Protect backslash escaped characters
      const escapes = [];
      s = s.replace(/\\([\\`\*_{}\[\]()#+\-.!$~|])/g, (m, char) => {
        const id = `LUOGUESCAPETOKEN${escapes.length}END`;
        escapes.push(escapeHtml(char));
        return id;
      });

      // 3. Images and Bilibili Video Embed (protect as tokens before emphasis)
      const mediaTokens = [];
      s = s.replace(/!\[(.*?)\]\((.*?)\)/g, (match, alt, target) => {
        let rawTarget = target.trim();
        let title = '';
        const titleMatch = rawTarget.match(/^(.*?)\s+["'](.*?)["']$/);
        if (titleMatch) {
          rawTarget = titleMatch[1];
          title = titleMatch[2];
        }

        let mediaHtml = '';
        // Bilibili video embed
        if (rawTarget.startsWith('bilibili:')) {
          const spec = rawTarget.slice(9);
          const bili = parseBilibiliSpec(spec);
          if (bili) {
            mediaHtml = `
              <div class="luogu-bilibili-container">
                <div class="luogu-bilibili-header">
                  <span class="luogu-bilibili-badge">Bilibili 视频</span>
                  <a href="${escapeHtml(sanitizeUrl(bili.directUrl))}" target="_blank" rel="noopener noreferrer" class="luogu-bilibili-link">
                    ${escapeHtml(bili.label)}
                    <svg viewBox="0 0 24 24" class="ext-icon" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                </div>
                <div class="luogu-bilibili-player-wrapper">
                  <button type="button" class="luogu-bilibili-facade" data-src="${escapeHtml(sanitizeUrl(bili.iframeUrl))}" onclick="loadBilibiliPlayer(this)" aria-label="播放 Bilibili 视频 ${escapeHtml(bili.label)}">
                    <span class="luogu-bilibili-play-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    </span>
                    <span class="luogu-bilibili-facade-text">点击加载视频（将连接 bilibili.com）</span>
                  </button>
                </div>
              </div>
            `;
          }
        } else {
          // Normal image
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          mediaHtml = `<span class="luogu-img-wrapper"><img src="${escapeHtml(sanitizeUrl(rawTarget))}" alt="${escapeHtml(alt)}"${titleAttr} class="luogu-img" loading="lazy" onerror="this.classList.add('luogu-img-error'); this.alt='[图片加载失败: ' + this.alt + ']';" /></span>`;
        }

        const id = `LUOGUMEDIATOKEN${mediaTokens.length}END`;
        mediaTokens.push(mediaHtml);
        return id;
      });

      // 4. Protect standard links and auto links before emphasis
      const linkTokens = [];
      // Auto links: <http...>
      s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (m, url) => {
        const id = `LUOGULINKTOKEN${linkTokens.length}END`;
        linkTokens.push(`<a href="${escapeHtml(sanitizeUrl(url))}" target="_blank" rel="noopener noreferrer" class="luogu-link">${escapeHtml(url)}</a>`);
        return id;
      });

      // Standard links: [text](url "title")
      s = s.replace(/\[([^\]]+)\]\((.*?)\)/g, (match, label, target) => {
        let rawTarget = target.trim();
        let title = '';
        const titleMatch = rawTarget.match(/^(.*?)\s+["'](.*?)["']$/);
        if (titleMatch) {
          rawTarget = titleMatch[1];
          title = titleMatch[2];
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
        const id = `LUOGULINKTOKEN${linkTokens.length}END`;
        linkTokens.push(`<a href="${escapeHtml(sanitizeUrl(rawTarget))}"${titleAttr} target="_blank" rel="noopener noreferrer" class="luogu-link">${this.renderInline(label)}</a>`);
        return id;
      });

      // 4.5. Neutralise any remaining raw HTML.
      //
      // Runs AFTER autolinks (`<https://...>`) and media/link tokenisation so those
      // legitimate uses of `<` are already extracted, and BEFORE emphasis so the
      // escaped text still participates in normal inline formatting.
      s = neutralizeRawHtml(s);

      // 5. Emphasis & Strikethrough
      // Bold + Italic combinations:
      s = s.replace(/\*\*\*([^\*\s][^\*]*?[^\*\s]|[^\*\s])\*\*\*/g, '<strong><em>$1</em></strong>');
      s = s.replace(/___([^_ \n][^_]*?[^_ \n]|[^_ \n])___/g, '<strong><em>$1</em></strong>');
      s = s.replace(/\*\*_\s*([^\*_]+?)\s*_\*\*/g, '<strong><em>$1</em></strong>');
      s = s.replace(/_\*\*\s*([^\*_]+?)\s*\*\*_/g, '<em><strong>$1</strong></em>');
      s = s.replace(/\*__\s*([^\*_]+?)\s*__\*/g, '<em><strong>$1</strong></em>');
      s = s.replace(/__\*\s*([^\*_]+?)\s*\*__/g, '<strong><em>$1</em></strong>');

      // Bold: **text** or __text__
      s = s.replace(/\*\*([^\*\s][^\*]*?[^\*\s]|[^\*\s])\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__([^_ \n][^_]*?[^_ \n]|[^_ \n])__/g, '<strong>$1</strong>');

      // Italic: *text* or _text_
      s = s.replace(/(^|[^\*])\*([^\*\s][^\*]*?[^\*\s]|[^\*\s])\*(?!\*)/g, '$1<em>$2</em>');
      s = s.replace(/(^|[^_])_([^_ \n][^_]*?[^_ \n]|[^_ \n])_(?!_)/g, '$1<em>$2</em>');

      // Strikethrough: ~~text~~
      s = s.replace(/~~([^~\s][^~]*?[^~\s]|[^~\s])~~/g, '<del>$1</del>');

      // 6-9. Restore every protected token in ONE pass.
      //
      // Each token class used to be restored with a `while (s.includes(tok))
      // s = s.replace(tok, ...)` loop, rescanning the entire string once per token —
      // quadratic in the number of links/images/escapes on a line. A single regex
      // sweep is linear and preserves ordering semantics, because the placeholder
      // namespaces are disjoint and never nest inside one another.
      //
      // Restoration order still matters conceptually (media/link markup may itself
      // contain escaped text), so tokens are resolved through one lookup table and
      // the sweep is repeated only while a substitution actually introduced a new
      // placeholder — in practice at most twice, never O(tokens) times.
      const tokenMap = new Map();
      for (let i = 0; i < mediaTokens.length; i++) {
        tokenMap.set(`LUOGUMEDIATOKEN${i}END`, mediaTokens[i]);
      }
      for (let i = 0; i < linkTokens.length; i++) {
        tokenMap.set(`LUOGULINKTOKEN${i}END`, linkTokens[i]);
      }
      for (let i = 0; i < escapes.length; i++) {
        tokenMap.set(`LUOGUESCAPETOKEN${i}END`, escapes[i]);
      }
      for (let i = 0; i < inlineCodes.length; i++) {
        tokenMap.set(
          `LUOGUINLINETOKEN${i}END`,
          `<code class="luogu-inline-code">${escapeHtml(inlineCodes[i])}</code>`
        );
      }

      if (tokenMap.size > 0) {
        const TOKEN_RE = /LUOGU(?:MEDIATOKEN|LINKTOKEN|ESCAPETOKEN|INLINETOKEN)\d+END/g;
        // Bounded loop: media/link markup can embed escape tokens, so allow a few
        // sweeps, but never spin forever on a self-referential payload.
        for (let pass = 0; pass < 4 && TOKEN_RE.test(s); pass++) {
          TOKEN_RE.lastIndex = 0;
          s = s.replace(TOKEN_RE, (m) => (tokenMap.has(m) ? tokenMap.get(m) : m));
          TOKEN_RE.lastIndex = 0;
        }
      }

      return s;
    }
  }

  // Export
  global.LuoguParser = LuoguParser;
  global.parseBilibiliSpec = parseBilibiliSpec;
  global.parseHighlightLines = parseHighlightLines;
  if (typeof window !== 'undefined') {
    window.LuoguParser = LuoguParser;
    window.parseBilibiliSpec = parseBilibiliSpec;
    window.parseHighlightLines = parseHighlightLines;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LuoguParser, parseBilibiliSpec, parseHighlightLines };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
