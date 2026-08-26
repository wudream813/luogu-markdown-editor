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
      // First, protect fenced code blocks and inline code from math replacement
      const codeTokens = [];
      let tokenIdx = 0;

      // Fenced code blocks
      text = text.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g, (m) => {
        const id = `LUOGUCODEBLOCK${tokenIdx++}END`;
        codeTokens.push({ id, text: m });
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
        return id;
      });

      // Inline math: $ ... $
      // Must not match \$ (escaped) or empty $$, and should not span across empty lines.
      // Reject candidates whose content reads like prose, so that paired "$" used for
      // currency / placeholders in normal text (e.g. "花费$5和$10") are not eaten as math.
      text = text.replace(/(^|[^\\])\$([^\$\n]+?)\$/g, (match, prefix, formula) => {
        const f = formula.trim();
        if (!f) return match;
        // If the "formula" contains bare CJK (not inside \text{}/\mathrm{} etc.), treat it
        // as literal text rather than math.
        if (/[\u4e00-\u9fa5]/.test(f)) {
          const strippedText = f.replace(/\\(?:text|mathrm|mathbf|operatorname|mathcal|textstyle|displaystyle)\{[^{}]*\}/g, '');
          if (/[\u4e00-\u9fa5]/.test(strippedText)) return match;
        }
        const id = `LUOGUMATHINLINE${mathIdx++}END`;
        store.push({ id, type: 'inline', formula: f });
        return prefix + id;
      });

      // Restore protected code blocks (using function callback to prevent $` replacement bugs)
      for (const token of codeTokens) {
        text = text.replace(token.id, () => token.text);
      }

      return text;
    }

    // Restore math placeholders using KaTeX renderer
    restoreMath(html, store) {
      const katexLib = this.options.katex || (typeof katex !== 'undefined' ? katex : null);

      for (const item of store) {
        let rendered = '';
        if (katexLib) {
          try {
            rendered = katexLib.renderToString(item.formula, {
              displayMode: item.type === 'display',
              throwOnError: false,
              output: 'htmlAndMathml',
              trust: true
            });
          } catch (e) {
            rendered = `<span class="katex-error" title="${escapeHtml(e.message)}">${escapeHtml(item.formula)}</span>`;
          }
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

        // Replace using function callback to prevent $$ replacement bugs in JS
        while (html.includes(item.id)) {
          html = html.replace(item.id, () => rendered);
        }
      }
      return html;
    }

    // Parse Markdown lines into structured HTML blocks
    parseBlocks(lines) {
      const out = [];
      let i = 0;
      const n = lines.length;

      while (i < n) {
        const line = lines[i];

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

          out.push(this.renderContainerBlock(type, title, param, innerLines));
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
        while (i < n) {
          const cur = lines[i];
          if (/^\s*$/.test(cur)) break;
          // Stop if next line is start of block element
          if (
            /^#{1,6}\s+/.test(cur) ||
            /^[`~]{3,}/.test(cur) ||
            /^:{3,}/.test(cur) ||
            /^::cute-table/i.test(cur) ||
            /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(cur.trim()) ||
            /^\s*>/.test(cur) ||
            cur.trim().startsWith('|') ||
            /^\s*([*+-]|\d+\.)\s+/.test(cur)
          ) {
            break;
          }
          pLines.push(cur);
          i++;
        }

        if (pLines.length > 0) {
          out.push(this.renderParagraph(pLines));
        }
      }

      return out.join('\n');
    }

    // Render Luogu Containers (Callouts, Align, Epigraph)
    renderContainerBlock(type, title, param, innerLines) {
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
      const innerHtml = this.parseBlocks(innerLines);

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
        <details class="luogu-callout luogu-callout-${calloutType}" ${isOpen ? 'open' : ''}>
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
        // Display math placeholder token ($$...$$) extracted earlier.
        if (/^LUOGUMATHBLOCK\d+END$/.test(single)) {
          return single;
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
                  <a href="${escapeHtml(bili.directUrl)}" target="_blank" rel="noopener noreferrer" class="luogu-bilibili-link">
                    ${escapeHtml(bili.label)}
                    <svg viewBox="0 0 24 24" class="ext-icon" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  </a>
                </div>
                <div class="luogu-bilibili-player-wrapper">
                  <iframe src="${escapeHtml(bili.iframeUrl)}" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" sandbox="allow-top-navigation allow-same-origin allow-forms allow-scripts"></iframe>
                </div>
              </div>
            `;
          }
        } else {
          // Normal image
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          mediaHtml = `<span class="luogu-img-wrapper"><img src="${escapeHtml(rawTarget)}" alt="${escapeHtml(alt)}"${titleAttr} class="luogu-img" loading="lazy" onerror="this.classList.add('luogu-img-error'); this.alt='[图片加载失败: ' + this.alt + ']';" /></span>`;
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
        linkTokens.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="luogu-link">${escapeHtml(url)}</a>`);
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
        linkTokens.push(`<a href="${escapeHtml(rawTarget)}"${titleAttr} target="_blank" rel="noopener noreferrer" class="luogu-link">${this.renderInline(label)}</a>`);
        return id;
      });

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

      // 6. Restore media tokens
      for (let i = 0; i < mediaTokens.length; i++) {
        const token = `LUOGUMEDIATOKEN${i}END`;
        const val = mediaTokens[i];
        while (s.includes(token)) {
          s = s.replace(token, () => val);
        }
      }

      // 7. Restore link tokens
      for (let i = 0; i < linkTokens.length; i++) {
        const token = `LUOGULINKTOKEN${i}END`;
        const val = linkTokens[i];
        while (s.includes(token)) {
          s = s.replace(token, () => val);
        }
      }

      // 8. Restore backslash escapes
      for (let i = 0; i < escapes.length; i++) {
        const token = `LUOGUESCAPETOKEN${i}END`;
        const val = escapes[i];
        while (s.includes(token)) {
          s = s.replace(token, () => val);
        }
      }

      // 9. Restore inline codes (using function callback to prevent $` replacement bugs)
      for (let i = 0; i < inlineCodes.length; i++) {
        const token = `LUOGUINLINETOKEN${i}END`;
        const codeHtml = `<code class="luogu-inline-code">${escapeHtml(inlineCodes[i])}</code>`;
        while (s.includes(token)) {
          s = s.replace(token, () => codeHtml);
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
