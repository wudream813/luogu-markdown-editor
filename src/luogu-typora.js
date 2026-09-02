/**
 * Typora mode: the preview pane doubles as the editor.
 *
 * The whole document stays rendered; clicking a block swaps just that block for a
 * plain <textarea> holding its Markdown source, and blurring it (or pressing Escape /
 * Ctrl+Enter) folds it back into rendered HTML. That is exactly how Typora behaves,
 * and it is the only design that keeps this project's guarantees intact:
 *
 *   - The parser stays the single source of truth. Nothing renders through a second,
 *     divergent code path, so Typora mode can never drift from split mode.
 *   - The textarea in the left pane remains the canonical document. Every edit is
 *     written back into it and flows through the existing setContent/render pipeline,
 *     so undo, autosave, linting, export and scroll sync keep working untouched.
 *   - IME composition is safe: a real <textarea> is used for editing, never
 *     contenteditable, so Chinese/Japanese input behaves exactly as it does elsewhere.
 *
 * Block identity comes from the `data-src-line` / `data-src-end-line` anchors the
 * parser already attaches to every top-level element, so no new bookkeeping is needed.
 */
(function (global) {
  'use strict';

  // Blocks that own their source range and can therefore be edited in place.
  // Everything the parser emits at top level carries data-src-line, so this is really
  // a list of what we refuse to edit rather than what we accept.
  const NON_EDITABLE = new Set(['HR']);

  class LuoguTypora {
    constructor(editor) {
      this.editor = editor;          // the LuoguEditor instance
      this.active = false;
      this.openBlock = null;         // { wrapper, textarea, startLine, endLine, marker }
      this._onClick = this._onClick.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
    }

    get previewEl() { return this.editor.previewEl; }
    get sourceEl() { return this.editor.textarea; }

    enable() {
      if (this.active) return;
      this.active = true;
      this.previewEl.classList.add('typora-mode');
      this.previewEl.addEventListener('click', this._onClick);
      this.previewEl.addEventListener('keydown', this._onKeyDown, true);
      this.previewEl.setAttribute('tabindex', '0');
    }

    disable() {
      if (!this.active) return;
      this.closeCalloutMenu();
      this.commit();
      this.active = false;
      this.previewEl.classList.remove('typora-mode');
      this.previewEl.removeEventListener('click', this._onClick);
      this.previewEl.removeEventListener('keydown', this._onKeyDown, true);
      this.previewEl.removeAttribute('tabindex');
    }

    // ---- source-range helpers ------------------------------------------------

    lines() { return this.sourceEl.value.split('\n'); }

    /**
     * Resolve the [start, end] source line range a rendered block owns.
     *
     * `data-src-line` is the authoritative start. The end is either the explicit
     * `data-src-end-line` (containers publish it) or, failing that, the line just
     * before the next block's start — which is why the caller passes the sorted list
     * of every anchor on the page rather than us re-querying per click.
     */
    rangeOf(el, anchors) {
      const start = parseInt(el.getAttribute('data-src-line'), 10);
      if (!Number.isFinite(start)) return null;

      const explicitEnd = parseInt(el.getAttribute('data-src-end-line'), 10);
      if (Number.isFinite(explicitEnd) && explicitEnd >= start) {
        return { start, end: explicitEnd };
      }

      const all = this.lines();
      let next = all.length;

      // A nested block (inside a callout) must be bounded by its *siblings*, not by
      // the page-wide anchor list: the container's own closing `:::` is not an anchor,
      // so a global scan would let the block run past the end of its container.
      const parent = el.parentElement;
      if (parent && parent.classList && parent.classList.contains('luogu-callout-content')) {
        for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
          const s = parseInt(sib.getAttribute('data-src-line'), 10);
          if (Number.isFinite(s) && s > start) { next = s; break; }
        }
        if (next === all.length) {
          // Last block in the container: stop before the container's closing fence.
          const host = el.closest('details.luogu-callout, .luogu-align, .luogu-epigraph');
          const hostEnd = host && parseInt(host.getAttribute('data-src-end-line'), 10);
          if (Number.isFinite(hostEnd)) next = hostEnd;
        }
      } else {
        for (const a of anchors) {
          if (a > start) { next = a; break; }
        }
      }
      // Trailing blank lines belong to the gap between blocks, not to this block;
      // swallowing them would make every commit grow the document.
      let end = Math.min(next - 1, all.length - 1);
      while (end > start && /^\s*$/.test(all[end])) end--;
      return { start, end };
    }

    anchorList() {
      return Array.from(this.previewEl.querySelectorAll('[data-src-line]'))
        .map((n) => parseInt(n.getAttribute('data-src-line'), 10))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    }

    /** The nearest ancestor (inclusive) that is a top-level rendered block. */
    /**
     * The block a click should act on.
     *
     * Walking to the *outermost* anchor is right for a plain top-level block, but
     * wrong inside a container: clicking a paragraph in a `:::info` should edit that
     * paragraph, not swallow the whole callout. So prefer the innermost anchor that
     * lies inside a container, and otherwise fall back to the top-level one.
     */
    blockFor(node) {
      let el = node.nodeType === 3 ? node.parentElement : node;
      let innermost = null;
      let outermost = null;
      let sawContainer = false;

      while (el && el !== this.previewEl) {
        if (el.hasAttribute && el.hasAttribute('data-src-line')) {
          if (!innermost) innermost = el;
          outermost = el;
        }
        if (el.classList && el.classList.contains('luogu-callout-content')) {
          sawContainer = true;
        }
        el = el.parentElement;
      }
      return (sawContainer && innermost) ? innermost : outermost;
    }

    // ---- open / commit -------------------------------------------------------

    _onClick(e) {
      if (!this.active) return;

      // A click inside the open editor must not re-open or close it.
      if (this.openBlock && this.openBlock.wrapper.contains(e.target)) return;

      // Sub-block targets are checked before the generic interactive-control bail-out,
      // because several of them (the callout <summary>, the copy button's header) are
      // themselves interactive yet need to become editable.
      if (this.routeSubBlock(e)) return;

      // Let genuinely interactive controls keep working instead of turning the block
      // into source the moment the user aims at them.
      if (e.target.closest('a, button, input, summary, .luogu-copy-btn, .luogu-bilibili-container')) {
        return;
      }

      const block = this.blockFor(e.target);

      // Landing on a block that exists but refuses in-place editing (a horizontal
      // rule has no meaningful source to show) should just close whatever was open —
      // not start a new paragraph, which would make the rule impossible to click past.
      if (block && NON_EDITABLE.has(block.tagName)) { this.commit(); return; }

      if (!block) {
        // Clicking the blank space between blocks (or anywhere in an empty document)
        // starts a new paragraph there, the way Typora does. Without this the gaps are
        // dead zones and the only way to add a block is to grow an existing one.
        this.commit();
        this.openGap(this.gapAt(e.clientY));
        return;
      }

      this.open(block);
    }

    /**
     * Route clicks that should edit *part* of a block rather than the whole thing.
     * Returns true when the click was handled.
     */
    routeSubBlock(e) {
      const anchors = this.anchorList();
      const all = this.lines();

      // ---- code block: edit only the code, never the fence or its language --------
      const pre = e.target.closest('pre[data-code-body]');
      if (pre) {
        const block = this.blockFor(pre);
        const range = block && this.rangeOf(block, anchors);
        if (range) {
          // Body is everything strictly between the opening and closing fence. An
          // indented (non-fenced) code block has no fence, so it is edited whole.
          const opensFence = /^\s*(`{3,}|~{3,})/.test(all[range.start] || '');
          if (opensFence) {
            let last = range.end;
            if (last > range.start && /^\s*(`{3,}|~{3,})\s*$/.test(all[last] || '')) last -= 1;
            this.openPartial(block, { lines: [range.start + 1, last] },
              { host: pre, variant: 'code', placeholder: '在此输入代码…' });
          } else {
            this.openPartial(block, { lines: [range.start, range.end] },
              { host: pre, variant: 'code' });
          }
          return true;
        }
      }

      // ---- bilibili: clicking the card edits the BV id / directive line ------------
      const bili = e.target.closest('.luogu-bilibili-container');
      if (bili && !e.target.closest('.luogu-bilibili-facade, iframe, a')) {
        const block = this.blockFor(bili);
        const range = block && this.rangeOf(block, anchors);
        if (range) {
          this.openPartial(block, { lines: [range.start, range.end] },
            { host: bili, variant: 'code', placeholder: '例如 ![标题](bilibili:BV1xx411c7XD)' });
          return true;
        }
      }

      // ---- table: edit a single cell ----------------------------------------------
      const cell = e.target.closest('td[data-cell-col], th[data-cell-col]');
      if (cell) {
        const block = this.blockFor(cell);
        const range = block && this.rangeOf(block, anchors);
        const spec = range && this.cellSpec(cell, range, all);
        if (spec) {
          this.openPartial(block, spec, { host: cell, variant: 'cell' });
          return true;
        }
      }

      // ---- callout: title text, type icon, and inner content are separate ---------
      const icon = e.target.closest('.luogu-callout-icon');
      if (icon) { this.openCalloutMenu(icon, all); return true; }

      const titleEl = e.target.closest('.luogu-callout-title');
      if (titleEl) {
        const details = titleEl.closest('details.luogu-callout');
        const spec = details && this.calloutTitleSpec(details, all);
        if (spec) {
          this.openPartial(details, spec, {
            host: titleEl, variant: 'title', placeholder: '折叠框标题',
          });
          return true;
        }
      }

      // Inner content of a callout: the blocks inside carry their own data-src-line,
      // so let the generic path pick the innermost one and edit just that block. Only
      // a click on the container's own padding falls through to editing the whole
      // container, which is what the user would expect from hitting its border.
      return false;
    }

    /** Column range of a table cell within its source line, or null. */
    cellSpec(cell, range, all) {
      const r = parseInt(cell.getAttribute('data-cell-row'), 10);
      const c = parseInt(cell.getAttribute('data-cell-col'), 10);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return null;
      const rowspan = parseInt(cell.getAttribute('rowspan'), 10) || 1;
      const colspan = parseInt(cell.getAttribute('colspan'), 10) || 1;

      // Walk the table's source lines, skipping the delimiter row, to find the line
      // this cell lives on. Header is row -1; body rows count from 0.
      const rows = [];
      for (let i = range.start; i <= range.end; i++) {
        const t = (all[i] || '').trim();
        if (!t.startsWith('|')) continue;
        if (/^\|?[\s:|-]+\|?$/.test(t) && /-/.test(t)) { rows.push({ i, delim: true }); continue; }
        rows.push({ i, delim: false });
      }
      const dataRows = rows.filter((x) => !x.delim);
      if (!dataRows.length) return null;

      const lineIdx = r < 0 ? dataRows[0].i : (dataRows[r + 1] ? dataRows[r + 1].i : -1);
      if (lineIdx < 0) return null;

      const cols = this.splitCells(all[lineIdx]);
      if (!cols[c]) return null;

      // A merged cell is edited as raw source. The rendered table shows one big box,
      // but the markers that produced it (`<` to merge left, `^` to merge up) live in
      // the neighbouring cells of the source; hiding them would make the merge
      // impossible to adjust. So hand back every line/column the merge covers and let
      // the author see `A |<` / `^ |^` exactly as written.
      if (rowspan > 1 || colspan > 1) {
        const startIdx = dataRows.findIndex((x) => x.i === lineIdx);
        const parts = [];
        for (let k = 0; k < rowspan; k++) {
          const row = dataRows[startIdx + k];
          if (!row) break;
          const rc = this.splitCells(all[row.i]);
          const first = rc[c];
          const last = rc[Math.min(c + colspan - 1, rc.length - 1)];
          if (!first || !last) break;
          parts.push({ line: row.i, col: [first.start, last.end] });
        }
        if (parts.length) return { rect: parts };
      }

      return { line: lineIdx, col: [cols[c].start, cols[c].end] };
    }

    /**
     * Split a table source line into cell spans, honouring escaped pipes.
     * Returns [{ start, end }] covering each cell's text (excluding the surrounding
     * pipes but including its padding, so editing preserves the author's alignment).
     */
    splitCells(line) {
      if (typeof line !== 'string') return [];
      const bars = [];
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '|' && line[i - 1] !== '\\') bars.push(i);
      }
      if (bars.length < 2) return [];
      const out = [];
      for (let k = 0; k < bars.length - 1; k++) {
        out.push({ start: bars[k] + 1, end: bars[k + 1] });
      }
      return out;
    }

    /** Column range of a callout's [title] within its ::: header line, or null. */
    calloutTitleSpec(details, all) {
      const start = parseInt(details.getAttribute('data-src-line'), 10);
      if (!Number.isFinite(start)) return null;
      const line = all[start];
      if (typeof line !== 'string') return null;

      const m = line.match(/^(\s*:{2,}\s*[A-Za-z][\w-]*)(\[)([^\]]*)(\])/);
      if (m) {
        const s = m[1].length + 1;
        return { line: start, col: [s, s + m[3].length] };
      }
      // No [title] yet: insert an empty one right after the directive name so typing
      // creates it, rather than silently editing nothing.
      const h = line.match(/^(\s*:{2,}\s*[A-Za-z][\w-]*)/);
      if (!h) return null;
      const at = h[1].length;
      const nl = this.lines();
      nl[start] = line.slice(0, at) + '[]' + line.slice(at);
      this.editor.setContent(nl.join('\n'));
      return null;   // re-rendered; the user can click the (now present) title
    }

    /** Clicking a callout's icon cycles info -> success -> warning -> error. */
    /**
     * Clicking a callout's icon opens a small menu to pick its type.
     *
     * A cycling click was tried first, but with four types it takes up to three
     * blind clicks to reach the one you want and there is no way to see the options.
     */
    openCalloutMenu(icon, all) {
      const details = icon.closest('details.luogu-callout');
      if (!details) return;
      const start = parseInt(details.getAttribute('data-src-line'), 10);
      if (!Number.isFinite(start)) return;
      const line = all[start];
      const m = typeof line === 'string' && line.match(/^(\s*:{2,}\s*)([A-Za-z][\w-]*)/);
      if (!m) return;

      const cur = m[2].toLowerCase();
      const TYPES = [
        { id: 'info', label: '提示', color: '#3498db' },
        { id: 'success', label: '成功', color: '#2ecc71' },
        { id: 'warning', label: '警告', color: '#f39c12' },
        { id: 'error', label: '错误', color: '#e74c3c' },
      ];
      // align / epigraph are containers too, but they have no "type" to switch.
      if (!TYPES.some((t) => t.id === cur)) return;

      this.commit();
      this.closeCalloutMenu();

      const menu = document.createElement('div');
      menu.className = 'typora-type-menu';
      menu.setAttribute('role', 'menu');

      for (const t of TYPES) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'typora-type-item' + (t.id === cur ? ' is-current' : '');
        item.setAttribute('role', 'menuitem');
        item.innerHTML = `<span class="typora-type-dot" style="background:${t.color}"></span>`
          + `<span class="typora-type-label"></span>`;
        item.querySelector('.typora-type-label').textContent = t.label;
        // mousedown, not click: the icon's blur would otherwise tear the menu down
        // before the click lands.
        item.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.setCalloutType(start, t.id);
          this.closeCalloutMenu();
        });
        menu.appendChild(item);
      }

      document.body.appendChild(menu);
      const r = icon.getBoundingClientRect();
      menu.style.top = `${Math.round(r.bottom + 6)}px`;
      menu.style.left = `${Math.round(r.left)}px`;
      // Keep the menu on screen when the callout sits near the bottom edge.
      const mb = menu.getBoundingClientRect();
      if (mb.bottom > window.innerHeight - 8) {
        menu.style.top = `${Math.round(r.top - mb.height - 6)}px`;
      }

      this._menu = menu;
      this._menuAway = (ev) => {
        if (this._menu && !this._menu.contains(ev.target)) this.closeCalloutMenu();
      };
      this._menuKey = (ev) => { if (ev.key === 'Escape') this.closeCalloutMenu(); };
      setTimeout(() => {
        document.addEventListener('mousedown', this._menuAway, true);
        document.addEventListener('keydown', this._menuKey, true);
      }, 0);
    }

    closeCalloutMenu() {
      if (!this._menu) return;
      if (this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
      this._menu = null;
      document.removeEventListener('mousedown', this._menuAway, true);
      document.removeEventListener('keydown', this._menuKey, true);
    }

    /** Rewrite the directive name on a container's header line. */
    setCalloutType(lineIdx, type) {
      const all = this.lines();
      const line = all[lineIdx];
      const m = typeof line === 'string' && line.match(/^(\s*:{2,}\s*)([A-Za-z][\w-]*)/);
      if (!m) return;
      if (m[2].toLowerCase() === type) return;
      all[lineIdx] = m[1] + type + line.slice(m[1].length + m[2].length);
      this.editor.setContent(all.join('\n'));
    }

    /**
     * Work out where a click in the blank space should insert.
     *
     * Returns the source line the new text should be spliced in at, found by walking
     * the rendered blocks and taking the first one whose box starts below the click.
     * Clicking past the last block appends at end of document.
     */
    gapAt(clientY) {
      const blocks = Array.from(this.previewEl.children)
        .filter((n) => n.nodeType === 1 && n.hasAttribute('data-src-line')
          && n.style.display !== 'none');

      const anchors = this.anchorList();
      const all = this.lines();

      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (clientY < r.top) {
          // Insert immediately before this block.
          const start = parseInt(el.getAttribute('data-src-line'), 10);
          return Number.isFinite(start) ? start : all.length;
        }
        if (clientY <= r.bottom) {
          // Inside a block's box but not on the block itself (e.g. the margin of a
          // centred figure). Treat it as "after this block".
          const range = this.rangeOf(el, anchors);
          return range ? range.end + 1 : all.length;
        }
      }
      return all.length;
    }

    /** Open an empty editor that inserts at `atLine` instead of replacing a block. */
    openGap(atLine) {
      const all = this.lines();
      const at = Math.max(0, Math.min(atLine, all.length));

      const wrapper = document.createElement('div');
      wrapper.className = 'typora-editing typora-inserting';

      const ta = document.createElement('textarea');
      ta.className = 'typora-block-input';
      ta.value = '';
      ta.placeholder = '在此输入 Markdown…';
      ta.spellcheck = false;
      wrapper.appendChild(ta);

      // Place the editor visually where the click landed so the caret appears under
      // the pointer rather than jumping to the end of the document.
      const before = Array.from(this.previewEl.children).find((n) => {
        if (n.nodeType !== 1 || !n.hasAttribute('data-src-line')) return false;
        const s = parseInt(n.getAttribute('data-src-line'), 10);
        return Number.isFinite(s) && s >= at;
      }) || null;
      this.previewEl.insertBefore(wrapper, before);

      // An insertion is just a replacement of the empty range [at, at-1]: `commit`
      // splices `end - start + 1 === 0` lines out and the new text in.
      this.openBlock = {
        wrapper,
        textarea: ta,
        block: null,
        marker: document.createComment('typora-insert'),
        range: { start: at, end: at - 1 },
        inserting: true,
      };

      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      grow();
      ta.addEventListener('input', grow);
      ta.addEventListener('blur', () => this.commit());
      ta.focus();
    }

    /**
     * Open an editor over part of a block instead of the whole thing.
     *
     * `spec` narrows what the user actually edits:
     *   { lines: [a, b] }        - only source lines a..b (e.g. a fenced block's body)
     *   { line, col: [s, e] }    - only a slice of one line (e.g. one table cell)
     * Committing splices exactly that span back, so the surrounding syntax — the
     * ``` fence and its language, the ::: container header, the other cells in the
     * row — is preserved untouched rather than being re-serialised from the DOM.
     */
    openPartial(block, spec, opts = {}) {
      this.commit();

      const all = this.lines();
      let range;
      let src;

      if (spec && Array.isArray(spec.rect) && spec.rect.length) {
        // Rectangular region: one source line per visual row of a merged cell.
        const parts = spec.rect;
        for (const part of parts) if (all[part.line] === undefined) return;
        range = { start: parts[0].line, end: parts[parts.length - 1].line, rect: parts };
        src = parts.map((p) => (all[p.line] || '').slice(p.col[0], p.col[1])).join('\n');
      } else if (spec && Array.isArray(spec.col)) {
        const text = all[spec.line];
        if (text === undefined) return;
        range = { start: spec.line, end: spec.line, col: spec.col.slice() };
        src = text.slice(spec.col[0], spec.col[1]);
      } else if (spec && Array.isArray(spec.lines)) {
        const [a, b] = spec.lines;
        if (a > b) {
          // An empty body (``` immediately followed by ```): insert at `a`.
          range = { start: a, end: a - 1 };
          src = '';
        } else {
          range = { start: a, end: b };
          src = all.slice(a, b + 1).join('\n');
        }
      } else {
        return;
      }

      this.revealAncestors(opts.host || block);

      const wrapper = document.createElement('div');
      wrapper.className = 'typora-editing typora-partial'
        + (opts.variant ? ` typora-${opts.variant}` : '');

      const ta = document.createElement('textarea');
      ta.className = 'typora-block-input';
      if (opts.variant === 'code') ta.classList.add('typora-code-input');
      if (opts.variant === 'cell' || opts.variant === 'title') {
        ta.classList.add('typora-inline-input');
      }
      ta.value = src;
      ta.spellcheck = false;
      if (opts.placeholder) ta.placeholder = opts.placeholder;
      wrapper.appendChild(ta);

      // Anchor the editor over the sub-element the user clicked, so a cell editor
      // appears in the cell rather than above the whole table.
      const host = opts.host || block;
      const marker = document.createComment('typora-partial');
      host.parentNode.insertBefore(marker, host);
      host.parentNode.insertBefore(wrapper, host);
      // A class, not an inline style: `.luogu-code-pre code` is `display:block
      // !important`, so hiding a <pre> inline still left its highlighted code
      // visible below the editor.
      const prevDisplay = host.style.display;
      host.classList.add('typora-hidden');

      this.openBlock = {
        wrapper, textarea: ta, block: host, marker, range,
        partial: true, prevDisplay,
      };

      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      grow();
      ta.addEventListener('input', grow);
      ta.addEventListener('blur', () => this.commit());
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }

    /**
     * A block inside a collapsed <details> cannot receive focus, and a textarea that
     * never focuses fires blur immediately — committing and closing itself before the
     * user can type. Open every ancestor first.
     */
    revealAncestors(el) {
      for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) {
        if (!d.open) d.open = true;
      }
    }

    open(block) {
      this.commit();

      const range = this.rangeOf(block, this.anchorList());
      if (!range) return;
      this.revealAncestors(block);

      const all = this.lines();
      const src = all.slice(range.start, range.end + 1).join('\n');

      const wrapper = document.createElement('div');
      wrapper.className = 'typora-editing';

      const ta = document.createElement('textarea');
      ta.className = 'typora-block-input';
      ta.value = src;
      ta.spellcheck = false;
      wrapper.appendChild(ta);

      // A marker keeps the block's position while it is swapped out, so committing can
      // put the re-rendered document back without guessing where this block belonged.
      const marker = document.createComment('typora-block');
      block.parentNode.insertBefore(marker, block);
      block.parentNode.insertBefore(wrapper, block);
      block.style.display = 'none';

      this.openBlock = { wrapper, textarea: ta, block, marker, range };

      const grow = () => {
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 'px';
      };
      grow();
      ta.addEventListener('input', grow);
      ta.addEventListener('blur', () => this.commit());

      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }

    /** Fold the open block back into rendered HTML, writing its text into the source. */
    commit() {
      const open = this.openBlock;
      if (!open) return;
      this.openBlock = null;               // guard against re-entry via blur

      const next = open.textarea.value;
      const all = this.lines();
      const rect = open.range.rect;
      const col = open.range.col;
      // For an insertion the range is empty (end === start - 1), so this slice is ''.
      const prev = rect
        ? rect.map((p) => (all[p.line] || '').slice(p.col[0], p.col[1])).join('\n')
        : col
          ? (all[open.range.start] || '').slice(col[0], col[1])
          : (open.inserting ? '' : all.slice(open.range.start, open.range.end + 1).join('\n'));

      // Clean up the DOM swap regardless of whether anything changed.
      if (open.wrapper.parentNode) open.wrapper.parentNode.removeChild(open.wrapper);
      if (open.marker.parentNode) open.marker.parentNode.removeChild(open.marker);
      if (open.block) {
        open.block.classList.remove('typora-hidden');
        open.block.style.display = open.prevDisplay || '';
      }

      if (next === prev) return;           // nothing to do; keep the DOM as-is

      // Abandoning an empty new paragraph must not dirty the document — otherwise a
      // stray click in the margin would push a no-op onto the undo stack and mark the
      // file changed.
      if (open.inserting && next.trim() === '') return;

      // A merged cell writes each of its rows back into that row's own column span.
      // Pipes are NOT escaped here: the whole point of this editor is to let the
      // author retype the `<` / `^` markers and the bars that separate them.
      if (rect) {
        const rows = next.split('\n');
        for (let k = 0; k < rect.length; k++) {
          const p = rect[k];
          const line = all[p.line] || '';
          // Surplus lines are folded into the last row so a stray Enter cannot add
          // table rows and desync the merge from its neighbours.
          const text = (k === rect.length - 1 ? rows.slice(k) : [rows[k]])
            .filter((x) => x !== undefined)
            .join(' ');
          all[p.line] = line.slice(0, p.col[0]) + text + line.slice(p.col[1]);
        }
        this.editor.setContent(all.join('\n'));
        return;
      }

      // A column slice rewrites one line in place: splice the new text between the
      // untouched head and tail so neighbouring cells / fence syntax survive verbatim.
      if (col) {
        const line = all[open.range.start] || '';
        // A cell must not contain a raw pipe or newline; either would silently
        // restructure the table rather than edit it.
        const safe = next.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
        all[open.range.start] = line.slice(0, col[0]) + safe + line.slice(col[1]);
        this.editor.setContent(all.join('\n'));
        return;
      }

      const replaceCount = open.range.end - open.range.start + 1;
      const payload = next.split('\n');
      if (open.inserting) {
        // Keep the new block separated from its neighbours by a blank line, or the
        // paragraph would be glued onto the previous one by the Markdown parser.
        const prevLine = all[open.range.start - 1];
        const nextLine = all[open.range.start];
        if (prevLine !== undefined && prevLine.trim() !== '') payload.unshift('');
        if (nextLine !== undefined && nextLine.trim() !== '') payload.push('');
      }
      all.splice(open.range.start, replaceCount, ...payload);
      // setContent runs the normal pipeline: history, re-render, line numbers, autosave.
      this.editor.setContent(all.join('\n'));
    }

    _onKeyDown(e) {
      if (!this.active || !this.openBlock) return;
      const ta = this.openBlock.textarea;
      if (e.target !== ta) return;

      // Tab indents inside the editor instead of moving focus. Without this a Tab in
      // a code block blurs the textarea, which commits and closes it — making it
      // impossible to type indented code, the single most common thing to write here.
      if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        const val = ta.value;
        const lineStart = val.lastIndexOf('\n', s - 1) + 1;

        if (e.shiftKey) {
          // Outdent every line touched by the selection.
          const endLine = val.indexOf('\n', en);
          const tail = endLine === -1 ? val.length : endLine;
          const seg = val.slice(lineStart, tail);
          let removedFirst = 0;
          let removedTotal = 0;
          const out = seg.split('\n').map((ln, idx) => {
            const m = ln.match(/^( {1,4}|\t)/);
            if (!m) return ln;
            if (idx === 0) removedFirst = m[1].length;
            removedTotal += m[1].length;
            return ln.slice(m[1].length);
          }).join('\n');
          ta.value = val.slice(0, lineStart) + out + val.slice(tail);
          ta.selectionStart = Math.max(lineStart, s - removedFirst);
          ta.selectionEnd = Math.max(lineStart, en - removedTotal);
        } else if (s !== en) {
          // Indent the whole selection, keeping it selected.
          const endLine = val.indexOf('\n', en);
          const tail = endLine === -1 ? val.length : endLine;
          const seg = val.slice(lineStart, tail);
          const out = seg.split('\n').map((ln) => '    ' + ln).join('\n');
          ta.value = val.slice(0, lineStart) + out + val.slice(tail);
          ta.selectionStart = s + 4;
          ta.selectionEnd = en + 4 * seg.split('\n').length;
        } else {
          ta.value = val.slice(0, s) + '    ' + val.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 4;
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      // Escape and Ctrl/Cmd+Enter fold the block. Plain Enter must stay available for
      // multi-line blocks (lists, code, tables), so it is deliberately not bound.
      if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) {
        e.preventDefault();
        e.stopPropagation();
        this.commit();
        this.previewEl.focus();
      }
    }
  }

  global.LuoguTypora = LuoguTypora;
  if (typeof window !== 'undefined') window.LuoguTypora = LuoguTypora;
  if (typeof module !== 'undefined' && module.exports) module.exports = { LuoguTypora };
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
