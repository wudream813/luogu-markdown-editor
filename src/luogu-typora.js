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
      for (const a of anchors) {
        if (a > start) { next = a; break; }
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
    blockFor(node) {
      let el = node.nodeType === 3 ? node.parentElement : node;
      let best = null;
      while (el && el !== this.previewEl) {
        if (el.hasAttribute && el.hasAttribute('data-src-line')) best = el;
        el = el.parentElement;
      }
      return best;
    }

    // ---- open / commit -------------------------------------------------------

    _onClick(e) {
      if (!this.active) return;

      // Let genuinely interactive controls keep working instead of turning the block
      // into source the moment the user aims at them.
      if (e.target.closest('a, button, input, summary, .luogu-copy-btn, .luogu-bilibili-container')) {
        return;
      }
      // A click inside the open editor must not re-open or close it.
      if (this.openBlock && this.openBlock.wrapper.contains(e.target)) return;

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

    open(block) {
      this.commit();

      const range = this.rangeOf(block, this.anchorList());
      if (!range) return;

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
      // For an insertion the range is empty (end === start - 1), so this slice is ''.
      const prev = open.inserting ? '' : all.slice(open.range.start, open.range.end + 1).join('\n');

      // Clean up the DOM swap regardless of whether anything changed.
      if (open.wrapper.parentNode) open.wrapper.parentNode.removeChild(open.wrapper);
      if (open.marker.parentNode) open.marker.parentNode.removeChild(open.marker);
      if (open.block) open.block.style.display = '';

      if (next === prev) return;           // nothing to do; keep the DOM as-is

      // Abandoning an empty new paragraph must not dirty the document — otherwise a
      // stray click in the margin would push a no-op onto the undo stack and mark the
      // file changed.
      if (open.inserting && next.trim() === '') return;

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
