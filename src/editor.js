/**
 * Luogu Markdown Editor Main Controller
 */

// Safe LocalStorage wrapper for sandboxed/file:// environments
const safeStorage = {
  getItem(key) {
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage.getItem(key) : null;
    } catch (e) {
      return null;
    }
  },
  // Returns true on success. Callers can surface a warning instead of letting a
  // failed write (most often QuotaExceededError on a large draft) pass unnoticed,
  // which previously left users believing their work was saved when it was not.
  setItem(key, val) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem(key, val);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
};

(function (global) {
  'use strict';

  class LuoguEditorApp {
    constructor() {
      const ParserClass = typeof LuoguParser !== 'undefined' ? LuoguParser : (global.LuoguParser || (typeof window !== 'undefined' ? window.LuoguParser : null));
      const LinterClass = typeof LuoguLinter !== 'undefined' ? LuoguLinter : (global.LuoguLinter || (typeof window !== 'undefined' ? window.LuoguLinter : null));
      const katexLib = typeof katex !== 'undefined' ? katex : (global.katex || (typeof window !== 'undefined' ? window.katex : null));
      const prismLib = typeof Prism !== 'undefined' ? Prism : (global.Prism || (typeof window !== 'undefined' ? window.Prism : null));

      this.parser = ParserClass ? new ParserClass({
        katex: katexLib,
        prism: prismLib
      }) : null;
      this.linter = LinterClass ? new LinterClass() : null;
      
      this.docName = '洛谷题解_未命名.md';
      this.currentMode = 'split'; // 'split' | 'editor-only' | 'preview-only'
      this.currentTheme = 'luogu';
      this.isSyncScrolling = false;
      this.undoStack = [];
      this.redoStack = [];
      this.maxHistory = 100;
      this.lastSavedContent = '';

      // Elements
      this.textarea = null;
      this.previewEl = null;
      this.gutterEl = null;
      this.docNameInput = null;

      // Table Builder state
      this.tableGridData = [];
    }

    init() {
      // The parser already highlights code blocks itself via prismLib.highlight().
      // Disable Prism's automatic highlight-on-DOMContentLoaded, otherwise it re-tokenizes
      // the already-rendered <code class="language-..."> and flattens the .code-line rows
      // into a single line of inline tokens (the "1#include <iostream>2..." bug).
      if (typeof Prism !== 'undefined') {
        Prism.manual = true;
      }

      this.textarea = document.getElementById('editorTextarea');
      this.previewEl = document.getElementById('previewContent');
      this.gutterEl = document.getElementById('lineNumbersGutter');
      this.docNameInput = document.getElementById('docNameInput');

      if (!this.textarea || !this.previewEl) {
        console.error('Editor elements not found in DOM.');
        return;
      }

      // Load saved draft or initial demo template
      const savedContent = safeStorage.getItem('luogu_editor_draft');
      const savedDocName = safeStorage.getItem('luogu_editor_doc_name');
      const savedTheme = safeStorage.getItem('luogu_editor_theme') || 'luogu';

      if (savedDocName) {
        this.docName = savedDocName;
        if (this.docNameInput) this.docNameInput.value = this.docName;
      }

      this.setTheme(savedTheme);

      if (savedContent && savedContent.trim().length > 0) {
        this.setContent(savedContent, false);
      } else if (typeof LuoguTemplates !== 'undefined' && LuoguTemplates.demo) {
        this.setContent(LuoguTemplates.demo, false);
      } else {
        this.setContent('# 洛谷 Markdown 编辑器\n\n在此输入内容……', false);
      }

      this.bindEvents();
      this.setupPrintHooks();
      this.initMathCheatsheet();
      this.render();
      this.updateLineNumbers();
    }

    // Automatically expand all callouts on print (Ctrl+P or print button) and restore
    setupPrintHooks() {
      let savedStates = [];
      window.addEventListener('beforeprint', () => {
        savedStates = [];
        const callouts = document.querySelectorAll('details.luogu-callout');
        callouts.forEach(d => {
          savedStates.push({ el: d, wasOpen: d.hasAttribute('open') });
          d.setAttribute('open', '');
        });
      });

      window.addEventListener('afterprint', () => {
        savedStates.forEach(item => {
          if (!item.wasOpen) {
            item.el.removeAttribute('open');
          }
        });
        savedStates = [];
      });
    }

    bindEvents() {
      // Textarea input
      // Scale the debounce with document size. A flat 120 ms means a very large
      // document re-renders while the user is still mid-word; giving big documents a
      // slightly longer idle window keeps typing responsive without a visible lag on
      // the short documents that make up the common case.
      let debounceTimer = null;
      const renderDelay = () => {
        const len = this.textarea.value.length;
        if (len > 200000) return 400;
        if (len > 50000) return 250;
        return 120;
      };
      this.textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.pushHistory();
          this.render();
          this.updateLineNumbers();
          this.autoSave();
        }, renderDelay());
      });

      // Synchronized scrolling
      this.textarea.addEventListener('scroll', () => {
        // The gutter must follow even our own writes, so update it before bailing out.
        this.updateGutterScroll();
        if (this.isEchoScroll(this.textarea)) return;
        this.syncScroll('editor');
      });

      this.previewEl.addEventListener('scroll', () => {
        if (this.isEchoScroll(this.previewEl)) return;
        this.syncScroll('preview');
      });

      // Keyboard shortcuts
      this.textarea.addEventListener('keydown', (e) => this.handleKeyDown(e));

      // Doc name input
      if (this.docNameInput) {
        this.docNameInput.addEventListener('change', (e) => {
          this.docName = e.target.value.trim() || '未命名.md';
          safeStorage.setItem('luogu_editor_doc_name', this.docName);
        });
      }

      // Drag and Drop files onto editor
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || files.length === 0) return;

        // Only text-ish documents can be opened. Dropping an image used to load its
        // binary content into the editor as mojibake with no explanation.
        const TEXT_EXT = /\.(md|markdown|txt|text)$/i;
        const file = files[0];
        if (!TEXT_EXT.test(file.name)) {
          this.showToast(`无法打开「${file.name}」：仅支持 .md / .markdown / .txt 文件`, 'error');
          return;
        }
        if (files.length > 1) {
          this.showToast(`已打开「${file.name}」，其余 ${files.length - 1} 个文件被忽略`, 'info');
        }
        this.openLocalFile(file);
      });

      // Wrapping depends on the textarea's width, so remeasure whenever it changes.
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          this._lineTopsKey = null;
          this._anchorsKey = null;
          this.updateLineNumbers();
        });
        ro.observe(this.textarea);
        this._resizeObserver = ro;
      }
      window.addEventListener('resize', () => {
        this._lineTopsKey = null;
        this._anchorsKey = null;
        this.updateLineNumbers();
      });

      // Splitter resizer
      this.initSplitter();
    }

    initSplitter() {
      const resizer = document.getElementById('splitResizer');
      const editorPane = document.getElementById('editorPane');
      const previewPane = document.getElementById('previewPane');
      const workspace = document.getElementById('mainWorkspace');

      if (!resizer || !editorPane || !previewPane || !workspace) return;

      // Pointer Events give mouse, touch and pen support from one code path, and
      // pointer capture keeps the drag alive when the cursor outruns the 6px handle.
      // The move/up listeners are attached only for the duration of a drag; the old
      // implementation left permanent window-level mousemove handlers running that
      // fired on every pointer motion for the lifetime of the page.
      const MIN_PANE_WIDTH = 200;
      let activePointerId = null;

      const onPointerMove = (e) => {
        const rect = workspace.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const totalWidth = rect.width;
        if (offsetX > MIN_PANE_WIDTH && (totalWidth - offsetX) > MIN_PANE_WIDTH) {
          const leftPct = (offsetX / totalWidth) * 100;
          editorPane.style.flex = `0 0 ${leftPct}%`;
          previewPane.style.flex = `0 0 ${100 - leftPct}%`;
        }
      };

      const endDrag = () => {
        if (activePointerId === null) return;
        try {
          resizer.releasePointerCapture(activePointerId);
        } catch (err) { /* pointer already released */ }
        activePointerId = null;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', endDrag);
        window.removeEventListener('pointercancel', endDrag);
      };

      resizer.addEventListener('pointerdown', (e) => {
        if (activePointerId !== null) return;
        activePointerId = e.pointerId;
        try {
          resizer.setPointerCapture(e.pointerId);
        } catch (err) { /* capture unsupported; drag still works */ }
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', endDrag);
        window.addEventListener('pointercancel', endDrag);
        e.preventDefault();
      });

      // Keyboard accessibility: the splitter is now operable without a pointer.
      resizer.setAttribute('tabindex', '0');
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.setAttribute('aria-label', '调整编辑区与预览区宽度');
      resizer.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const rect = workspace.getBoundingClientRect();
        const current = editorPane.getBoundingClientRect().width;
        const delta = e.key === 'ArrowLeft' ? -32 : 32;
        const next = current + delta;
        if (next > MIN_PANE_WIDTH && (rect.width - next) > MIN_PANE_WIDTH) {
          const leftPct = (next / rect.width) * 100;
          editorPane.style.flex = `0 0 ${leftPct}%`;
          previewPane.style.flex = `0 0 ${100 - leftPct}%`;
        }
      });
    }

    // Synchronize scrolling between editor and preview
    // Build a sorted list of {srcLine, previewTop} anchors from the rendered blocks.
    // These pair a source line with where its output actually sits, which is the only
    // way tall constructs (code fences, display math, wide tables) can stay aligned:
    // their source height and rendered height are unrelated, so a percentage mapping
    // is guaranteed to drift.
    buildScrollAnchors() {
      if (!this.previewEl) return [];
      const key = this._renderSeq || 0;
      if (this._anchorsKey === key && this._anchors) return this._anchors;

      const nodes = this.previewEl.querySelectorAll('[data-src-line]');
      const baseTop = this.previewEl.getBoundingClientRect().top - this.previewEl.scrollTop;
      const anchors = [];
      nodes.forEach((el) => {
        const line = parseInt(el.getAttribute('data-src-line'), 10);
        if (!Number.isFinite(line)) return;
        // Skip anything inside a collapsed <details>: it has no meaningful position.
        if (el.offsetParent === null && el !== this.previewEl) return;
        const top = el.getBoundingClientRect().top - baseTop;
        const prev = anchors[anchors.length - 1];
        if (prev && prev.line === line) return;
        anchors.push({ line, top });
      });
      anchors.sort((a, b) => a.line - b.line || a.top - b.top);

      this._anchors = anchors;
      this._anchorsKey = key;
      return anchors;
    }

    // Piecewise-linear interpolation between neighbouring anchors.
    interpolate(anchors, pick, get) {
      if (!anchors.length) return null;
      let lo = 0;
      let hi = anchors.length - 1;
      if (pick <= get(anchors[0])) return anchors[0];
      if (pick >= get(anchors[hi])) return anchors[hi];
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (get(anchors[mid]) <= pick) lo = mid; else hi = mid;
      }
      return { lo: anchors[lo], hi: anchors[hi] };
    }

    syncScroll(source) {
      // The pane being driven also emits `scroll`, which would drive the first pane
      // straight back. Rather than dropping events during a timed lock — which threw
      // away the intermediate positions of a fast wheel/inertia scroll and made the
      // other pane advance in visible ~280px jumps — remember the latest request and
      // collapse them all into one update on the next animation frame.
      this._pendingSyncSource = source;
      if (this._syncRaf) return;
      this._syncRaf = requestAnimationFrame(() => {
        this._syncRaf = 0;
        const src = this._pendingSyncSource;
        this._pendingSyncSource = null;
        this.applySyncScroll(src);
      });
    }

    // Record that WE are about to move `el`, so the scroll event this write provokes
    // can be told apart from one the user caused.
    //
    // This replaces an `isSyncScrolling` flag that was set and cleared around the
    // write on the assumption that the echo event fires synchronously. It does not:
    // scroll events are queued and delivered on a later task, by which point the flag
    // had already been cleared. The echo was therefore processed as genuine user
    // input and drove the *other* pane back — the intermittent bounce. It only showed
    // up sometimes because a mapping that round-trips exactly is a no-op; the bounce
    // needed accumulated rounding (long documents, tall blocks) to become visible.
    markProgrammaticScroll(el, top) {
      if (!this._echo) this._echo = new WeakMap();
      this._echo.set(el, top);
    }

    // True if this scroll event is our own write echoing back.
    isEchoScroll(el) {
      if (!this._echo || !this._echo.has(el)) return false;
      const expected = this._echo.get(el);
      // The browser clamps and rounds scrollTop, so compare with a tolerance rather
      // than for equality.
      if (Math.abs(el.scrollTop - expected) <= 1.5) {
        this._echo.delete(el);
        return true;
      }
      // Position moved on beyond our write: the user is genuinely scrolling again.
      this._echo.delete(el);
      return false;
    }

    setScrollTop(el, top) {
      if (Math.abs(el.scrollTop - top) <= 0.5) return;
      this.markProgrammaticScroll(el, top);
      el.scrollTop = top;
    }

    applySyncScroll(source) {
      if (!source) return;
      try {
        const anchors = this.buildScrollAnchors();
        const tops = this.measureLineTops();

        if (!anchors.length || tops.length < 2) {
          // Nothing to anchor to (e.g. an empty document); fall back to proportional.
          this.syncScrollByRatio(source);
          return;
        }

        if (source === 'editor') {
          // Which source line sits at the TOP of the viewport is what the user sees,
          // so that line — not a percentage of total height — drives the preview.
          const y = this.textarea.scrollTop;
          // Past the last real line we are inside the tail padding, where no source
          // line maps any more. Interpolate the remainder straight onto the preview's
          // own tail so the two still reach their bottoms together.
          const natural = this.maxNaturalScroll(tops);
          if (y > natural) {
            const padSpan = (this.textarea.scrollHeight - this.textarea.clientHeight) - natural;
            const pmax = this.previewEl.scrollHeight - this.previewEl.clientHeight;
            const lastTop = this.previewTopForLine(
              anchors, this.visibleToDocLine(Math.floor(this.visualOffsetToLine(tops, natural))), 0,
            );
            const from = lastTop === null ? pmax : Math.max(0, Math.min(pmax, lastTop));
            const t = padSpan > 0 ? (y - natural) / padSpan : 1;
            const want = from + (pmax - from) * t;
            this.setScrollTop(this.previewEl, want);
            return;
          }
          const line = this.visualOffsetToLine(tops, y);
          const docLine = this.visibleToDocLine(Math.floor(line));
          const frac = line - Math.floor(line);
          const target = this.previewTopForLine(anchors, docLine, frac);
          if (target !== null) {
            const max = this.previewEl.scrollHeight - this.previewEl.clientHeight;
            const want = Math.max(0, Math.min(max, target));
            this.setScrollTop(this.previewEl, want);
          }
        } else if (source === 'preview') {
          const y = this.previewEl.scrollTop;
          // Mirror of the editor branch: past the last anchor the preview is scrolling
          // through its own tail padding, where no anchor maps any more. Interpolate
          // onto the editor's tail so both panes finish together in this direction too.
          const lastAnchorTop = anchors[anchors.length - 1].top;
          if (y > lastAnchorTop) {
            const pmax = this.previewEl.scrollHeight - this.previewEl.clientHeight;
            const padSpan = pmax - lastAnchorTop;
            const tmax = this.textarea.scrollHeight - this.textarea.clientHeight;
            const lastVis = this.docToVisibleLine(anchors[anchors.length - 1].line);
            const from = lastVis === -1
              ? tmax
              : Math.max(0, Math.min(tmax, tops[lastVis] || 0));
            const t = padSpan > 0 ? (y - lastAnchorTop) / padSpan : 1;
            this.setScrollTop(this.textarea, from + (tmax - from) * t);
            this.updateGutterScroll();
            return;
          }
          const docLine = this.lineForPreviewTop(anchors, y);
          if (docLine !== null) {
            const vis = this.docToVisibleLine(Math.floor(docLine));
            if (vis !== -1) {
              const frac = docLine - Math.floor(docLine);
              const a = tops[vis] || 0;
              const b = tops[vis + 1] !== undefined ? tops[vis + 1] : a;
              const target = a + (b - a) * frac;
              const max = this.textarea.scrollHeight - this.textarea.clientHeight;
              const want = Math.max(0, Math.min(max, target));
              this.setScrollTop(this.textarea, want);
              this.updateGutterScroll();
            }
          }
        }
      } finally {
        // nothing to release: echo detection is positional, not time-windowed.
      }
    }

    // Fallback used only when there are no anchors at all.
    syncScrollByRatio(source) {
      if (source === 'editor') {
        const max = this.textarea.scrollHeight - this.textarea.clientHeight;
        if (max > 0) {
          const r = this.textarea.scrollTop / max;
          this.setScrollTop(this.previewEl, r * (this.previewEl.scrollHeight - this.previewEl.clientHeight));
        }
      } else {
        const max = this.previewEl.scrollHeight - this.previewEl.clientHeight;
        if (max > 0) {
          const r = this.previewEl.scrollTop / max;
          this.setScrollTop(this.textarea, r * (this.textarea.scrollHeight - this.textarea.clientHeight));
          this.updateGutterScroll();
        }
      }
    }

    // Pixel offset in the textarea -> fractional line index.
    visualOffsetToLine(tops, y) {
      let lo = 0;
      let hi = tops.length - 2;
      if (y <= tops[0]) return 0;
      if (y >= tops[hi]) return hi;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (tops[mid] <= y) lo = mid; else hi = mid;
      }
      const a = tops[lo];
      const b = tops[lo + 1];
      return b > a ? lo + (y - a) / (b - a) : lo;
    }

    // Source line (+fraction) -> preview pixel offset, interpolating between anchors.
    previewTopForLine(anchors, line, frac) {
      if (line <= anchors[0].line) return anchors[0].top;
      const last = anchors[anchors.length - 1];
      if (line >= last.line) return last.top;
      let lo = 0;
      let hi = anchors.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].line <= line) lo = mid; else hi = mid;
      }
      const A = anchors[lo];
      const B = anchors[hi];
      const span = B.line - A.line;
      const t = span > 0 ? (line + frac - A.line) / span : 0;
      return A.top + (B.top - A.top) * Math.max(0, Math.min(1, t));
    }

    // Preview pixel offset -> source line (+fraction).
    lineForPreviewTop(anchors, y) {
      if (y <= anchors[0].top) return anchors[0].line;
      const last = anchors[anchors.length - 1];
      if (y >= last.top) return last.line;
      let lo = 0;
      let hi = anchors.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (anchors[mid].top <= y) lo = mid; else hi = mid;
      }
      const A = anchors[lo];
      const B = anchors[hi];
      const span = B.top - A.top;
      const t = span > 0 ? (y - A.top) / span : 0;
      return A.line + (B.line - A.line) * Math.max(0, Math.min(1, t));
    }

    // Keydown shortcuts
    handleKeyDown(e) {
      // Ctrl / Cmd shortcuts
      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl) {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          this.saveMarkdownFile();
          return;
        }
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          this.insertBold();
          return;
        }
        if (e.key === 'i' || e.key === 'I') {
          e.preventDefault();
          this.insertItalic();
          return;
        }
        if (e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          if (e.shiftKey) {
            this.insertMathInline();
          } else {
            this.openModal('linkModal');
          }
          return;
        }
        if (e.key === 'm' || e.key === 'M') {
          if (e.shiftKey) {
            e.preventDefault();
            this.insertMathBlock();
            return;
          }
        }
        if (e.key === 'z' || e.key === 'Z') {
          if (e.shiftKey) {
            e.preventDefault();
            this.redo();
          } else {
            e.preventDefault();
            this.undo();
          }
          return;
        }
        if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          this.redo();
          return;
        }
      }

      // Tab key indentation
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const val = this.textarea.value;

        if (e.shiftKey) {
          // Outdent 4 spaces or 2 spaces
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          if (val.substring(lineStart, lineStart + 4) === '    ') {
            this.textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 4);
            this.textarea.selectionStart = Math.max(lineStart, start - 4);
            this.textarea.selectionEnd = Math.max(lineStart, end - 4);
          } else if (val.substring(lineStart, lineStart + 2) === '  ') {
            this.textarea.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
            this.textarea.selectionStart = Math.max(lineStart, start - 2);
            this.textarea.selectionEnd = Math.max(lineStart, end - 2);
          }
        } else {
          // Indent 4 spaces
          this.textarea.value = val.substring(0, start) + '    ' + val.substring(end);
          this.textarea.selectionStart = this.textarea.selectionEnd = start + 4;
        }
        // Indentation is a real edit: record it so Ctrl+Z can revert it. This was
        // previously missing, making Tab / Shift+Tab silently un-undoable.
        this.pushHistory();
        this.render();
        this.updateLineNumbers();
        this.autoSave();
      }
    }

    // Push state to Undo stack.
    //
    // Entries record the caret position alongside the text, because restoring only
    // the text left the caret at the very end of the document after every undo,
    // which made the feature unusable for edits in the middle of a long solution.
    pushHistory() {
      const val = this.textarea.value;
      const top = this.undoStack[this.undoStack.length - 1];
      if (!top || top.value !== val) {
        this.undoStack.push({
          value: val,
          selectionStart: this.textarea.selectionStart,
          selectionEnd: this.textarea.selectionEnd,
        });
        if (this.undoStack.length > this.maxHistory) {
          this.undoStack.shift();
        }
        this.redoStack = [];
      }
    }

    // Caret position for an undo/redo: the first character where the two versions
    // differ. A stored snapshot caret is NOT good enough, because it records where
    // the caret happened to be when that snapshot was taken, not where the edit being
    // reverted actually occurred — undoing a change in the middle of a document would
    // still drop the caret at the end.
    static diffCaret(from, to) {
      const max = Math.min(from.length, to.length);
      let i = 0;
      while (i < max && from.charCodeAt(i) === to.charCodeAt(i)) i++;
      return i;
    }

    // Restore a history entry, putting the caret at the edit site and scrolling it
    // into view.
    applyHistoryEntry(entry) {
      const previous = this.textarea.value;
      this.textarea.value = entry.value;

      let pos;
      if (previous === entry.value) {
        pos = Math.min(entry.selectionStart ?? entry.value.length, entry.value.length);
      } else {
        pos = Math.min(LuoguEditorApp.diffCaret(previous, entry.value), entry.value.length);
      }

      this.textarea.setSelectionRange(pos, pos);
      this.textarea.focus();
      this.scrollCaretIntoView();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    // Ensure the caret's line is visible after a programmatic value change.
    scrollCaretIntoView() {
      const ta = this.textarea;
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.split('\n').length - 1;
      const style = window.getComputedStyle(ta);
      const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) * 1.5) || 20;
      const target = line * lineHeight;
      if (target < ta.scrollTop || target > ta.scrollTop + ta.clientHeight - lineHeight) {
        ta.scrollTop = Math.max(0, target - ta.clientHeight / 2);
      }
    }

    undo() {
      if (this.undoStack.length > 1) {
        const cur = this.undoStack.pop();
        // Remember where the caret is *now* so redo can restore it faithfully.
        this.redoStack.push({
          value: cur.value,
          selectionStart: this.textarea.selectionStart,
          selectionEnd: this.textarea.selectionEnd,
        });
        this.applyHistoryEntry(this.undoStack[this.undoStack.length - 1]);
      }
    }

    redo() {
      if (this.redoStack.length > 0) {
        const next = this.redoStack.pop();
        this.undoStack.push(next);
        this.applyHistoryEntry(next);
      }
    }

    // Render markdown content to preview with preserved callout open states
    render() {
      if (!this.textarea || !this.previewEl) return;

      // 1. Record which callouts are currently open so the state survives re-render.
      //
      // The key combines document order with the title. Keying on the title alone made
      // two callouts sharing a title (very common: several "提示" boxes in one
      // solution) share a single state, so expanding one expanded them all.
      const openCalloutKeys = new Set();
      if (this.previewEl) {
        const existingDetails = this.previewEl.querySelectorAll('details.luogu-callout');
        existingDetails.forEach((d, idx) => {
          if (d.hasAttribute('open')) {
            const titleEl = d.querySelector('.luogu-callout-title');
            const title = titleEl ? titleEl.textContent.trim() : '';
            openCalloutKeys.add(`${idx}\u0000${title}`);
          }
        });
      }

      // Invalidate cached scroll anchors and line measurements: the DOM is about to
      // change, so any cached geometry is stale.
      this._renderSeq = (this._renderSeq || 0) + 1;
      this._lineTopsKey = null;

      // 2. Render new HTML.
      // getContent() (not textarea.value) so a collapsed ::: block still renders
      // its contents in the preview.
      const markdown = this.getContent();
      const html = this.parser ? this.parser.render(markdown) : '';
      this.patchPreview(html);

      // 3. Restore user-opened states to callouts
      if (openCalloutKeys.size > 0) {
        const newDetails = this.previewEl.querySelectorAll('details.luogu-callout');
        newDetails.forEach((d, idx) => {
          const titleEl = d.querySelector('.luogu-callout-title');
          const title = titleEl ? titleEl.textContent.trim() : '';
          if (openCalloutKeys.has(`${idx}\u0000${title}`)) {
            d.setAttribute('open', '');
          }
        });
      }

      // The preview's height just changed, so how far the editor needs to be able to
      // scroll changed with it.
      this.syncEditorTailPadding();
      this._lineTopsKey = null;
      this.updateLineNumbers();

      this.updateStats(markdown);
    }

    // The full document. Kept as a method (rather than reading textarea.value at every
    // call site) because rendering, saving, exporting, copying and stats all go through
    // it; that indirection is what made it safe to remove source-side folding without
    // touching those paths.
    getContent() {
      return this.textarea.value;
    }

    // Source-side folding was removed, so the textarea always shows the whole
    // document and a visible line index IS a document line index. These identity
    // helpers remain because the anchor-based scroll sync is written in terms of the
    // two coordinate spaces.
    visibleToDocLine(visIdx) {
      return visIdx;
    }

    docToVisibleLine(docIdx) {
      return docIdx;
    }

    // Measure the top offset (in content pixels) of every logical line in the
    // textarea. With soft-wrap enabled a line can occupy several visual rows, so a
    // uniform lineHeight multiplication is no longer valid — for the gutter, for the
    // and above all for scroll sync. A hidden mirror div that copies the
    // textarea's exact typography and width reproduces its wrapping, letting us read
    // real offsets.
    // Replace the preview's contents WITHOUT blowing away nodes that did not change.
    //
    // This used to be a plain `previewEl.innerHTML = html`, which destroys and rebuilds
    // every node on every keystroke. That is what made a playing Bilibili video revert
    // to its "click to load" facade the moment you typed anywhere in the document: the
    // live <iframe> was thrown away with the rest of the DOM.
    //
    // An iframe reloads whenever it is detached from the document — even a pure move
    // within the same parent counts — so the only way to keep playback alive is to
    // never touch the node at all. We therefore diff the preview's top-level children
    // and leave matching ones exactly where they are, only inserting/removing around
    // them.
    patchPreview(html) {
      const parent = this.previewEl;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;

      // Identity of a child for diffing purposes. A loaded video container no longer
      // looks like the freshly rendered markup (facade button vs. iframe), so those are
      // keyed by their video URL instead of their markup.
      const keyOf = (n) => {
        if (n.nodeType === 3) return `t:${n.data}`;
        if (n.nodeType !== 1) return `o:${n.nodeName}`;
        if (n.classList && n.classList.contains('luogu-bilibili-container')) {
          const holder = n.querySelector('[data-src]');
          if (holder) return `b:${holder.getAttribute('data-src')}`;
        }
        return `h:${n.outerHTML}`;
      };

      const oldNodes = Array.from(parent.childNodes);
      const newNodes = Array.from(tpl.content.childNodes);
      const oldKeys = oldNodes.map(keyOf);
      const newKeys = newNodes.map(keyOf);

      const drop = (n) => { if (n && n.parentNode === parent) parent.removeChild(n); };

      let oi = 0;
      // Bounded lookahead keeps this linear; a match further than this away is treated
      // as "no match" and simply re-rendered, which is correct, just not optimal.
      const WINDOW = 64;
      for (let ni = 0; ni < newNodes.length; ni++) {
        let found = -1;
        for (let k = oi; k < oldNodes.length && k < oi + WINDOW; k++) {
          if (oldKeys[k] === newKeys[ni]) { found = k; break; }
        }
        if (found === -1) {
          // Insert before the next surviving old node so relative order is kept.
          let ref = null;
          for (let k = oi; k < oldNodes.length; k++) {
            if (oldNodes[k].parentNode === parent) { ref = oldNodes[k]; break; }
          }
          parent.insertBefore(newNodes[ni], ref);
        } else {
          for (let k = oi; k < found; k++) drop(oldNodes[k]);
          oi = found + 1;
        }
      }
      for (let k = oi; k < oldNodes.length; k++) drop(oldNodes[k]);

      // A container that *was* rebuilt (because its own markup changed) comes back as a
      // facade. If the user had already opted into loading that video, honour it rather
      // than making them click again.
      const facades = parent.querySelectorAll('button.luogu-bilibili-facade[data-src]');
      facades.forEach((btn) => {
        if (loadedBiliSrcs.has(btn.getAttribute('data-src')) && global.loadBilibiliPlayer) {
          global.loadBilibiliPlayer(btn);
        }
      });
    }

    // Let the editor scroll past its last line.
    //
    // The preview is usually taller than the source that produced it (a two-word line
    // can render as a 400px video), so the editor would hit its bottom while the
    // preview still had content below the fold — and scroll sync, having run out of
    // editor to scroll, could never bring that tail into view. Extending the editor's
    // scrollable range by the preview's leftover height gives the last stretch of the
    // document somewhere to map onto.
    syncEditorTailPadding() {
      const ta = this.textarea;
      const pv = this.previewEl;
      if (!ta || !pv) return;
      if (this._basePadBottom === undefined) {
        this._basePadBottom = parseFloat(window.getComputedStyle(ta).paddingBottom) || 0;
      }
      if (this._basePreviewPadBottom === undefined) {
        this._basePreviewPadBottom = parseFloat(window.getComputedStyle(pv).paddingBottom) || 0;
      }

      // Measure against the UNPADDED heights of both panes, otherwise last frame's
      // padding feeds into this frame's calculation and the two ratchet each other
      // upwards on every render.
      const prevTaPad = this._tailPad === undefined ? this._basePadBottom : this._tailPad;
      const prevPvPad = this._previewTailPad === undefined
        ? this._basePreviewPadBottom : this._previewTailPad;

      const tops = this.measureLineTops();
      const padTop = parseFloat(window.getComputedStyle(ta).paddingTop) || 0;
      const lastLineTop = tops.length >= 2 ? tops[tops.length - 2] : 0;

      const anchors = this.buildScrollAnchors();
      const lastAnchorTop = anchors.length ? anchors[anchors.length - 1].top : 0;

      // Natural (padding-free) scrollable extent of each pane.
      const taNatural = Math.max(0, (ta.scrollHeight - prevTaPad + this._basePadBottom) - ta.clientHeight);
      const pvNatural = Math.max(0, (pv.scrollHeight - prevPvPad + this._basePreviewPadBottom) - pv.clientHeight);

      // Each pane must be able to scroll until its own last mapped position reaches
      // the TOP of its viewport — that is the point where sync mapping runs out and
      // tail interpolation takes over. Whichever pane cannot reach that point on its
      // own content gets padding to make up the difference.
      //
      // Doing this for BOTH panes is what keeps them from bottoming out at different
      // times: previously only the editor was extended, so a document whose source was
      // taller than its render (e.g. a long link reference or a big table written out
      // in full) hit the mirror-image bug — preview at its bottom, editor still going.
      const taNeed = Math.max(0, lastLineTop + padTop - taNatural);
      const pvNeed = Math.max(0, lastAnchorTop - pvNatural);

      const wantTa = Math.round(this._basePadBottom + taNeed);
      const wantPv = Math.round(this._basePreviewPadBottom + pvNeed);

      if (this._tailPad !== wantTa) {
        this._tailPad = wantTa;
        ta.style.paddingBottom = `${wantTa}px`;
      }
      if (this._previewTailPad !== wantPv) {
        this._previewTailPad = wantPv;
        pv.style.paddingBottom = `${wantPv}px`;
        // Anchor offsets are measured against the preview box, which just changed.
        this._anchorsKey = null;
      }
    }

    // The largest scrollTop at which a REAL source line still sits at the top of the
    // viewport. Past this point the top of the viewport is inside the tail padding,
    // where no line maps any more and interpolation has to take over.
    //
    // Deliberately not "the last line reaches the BOTTOM of the viewport": that point
    // comes much earlier, and treating it as the boundary handed a large band of
    // perfectly mappable scroll positions to the interpolation path, which threw
    // preview alignment off by hundreds of pixels near the end of a document.
    maxNaturalScroll(tops) {
      // tops has one entry per line plus a trailing total-height sentinel, so the
      // start offset of the final line is at length - 2.
      if (!tops || tops.length < 2) return 0;
      return Math.max(0, tops[tops.length - 2]);
    }

    measureLineTops() {
      const ta = this.textarea;
      if (!ta) return [];
      const text = ta.value;
      const width = ta.clientWidth;
      // Hash the actual text: keying on length alone collided whenever an edit kept
      // the length unchanged, returning stale offsets and misplacing the gutter.
      let h = 0;
      for (let k = 0; k < text.length; k++) h = ((h << 5) - h + text.charCodeAt(k)) | 0;
      const cacheKey = `${text.length}\u0000${width}\u0000${h}`;
      if (this._lineTopsKey === cacheKey && this._lineTops) return this._lineTops;

      let mirror = this._mirrorEl;
      if (!mirror) {
        mirror = document.createElement('div');
        mirror.setAttribute('aria-hidden', 'true');
        mirror.style.cssText =
          'position:absolute;visibility:hidden;pointer-events:none;top:0;left:-99999px;';
        document.body.appendChild(mirror);
        this._mirrorEl = mirror;
      }

      const cs = window.getComputedStyle(ta);
      // Copy every property that can influence line breaking.
      [
        'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
        'lineHeight', 'textTransform', 'wordSpacing', 'whiteSpace',
        'overflowWrap', 'wordBreak', 'tabSize', 'textIndent',
      ].forEach((k) => { mirror.style[k] = cs[k]; });
      mirror.style.width = `${width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)}px`;
      mirror.style.padding = '0';
      mirror.style.border = '0';

      const lines = text.split('\n');
      // One span per line; a trailing zero-width space keeps empty lines measurable.
      mirror.innerHTML = '';
      const frag = document.createDocumentFragment();
      const spans = lines.map((ln) => {
        const el = document.createElement('div');
        el.textContent = ln.length ? ln : '\u200b';
        frag.appendChild(el);
        return el;
      });
      mirror.appendChild(frag);

      const base = mirror.getBoundingClientRect().top;
      const tops = spans.map((el) => el.getBoundingClientRect().top - base);
      tops.push(mirror.getBoundingClientRect().height);

      this._lineTops = tops;
      this._lineTopsKey = cacheKey;
      return tops;
    }

    // Pin the gutter's row height to the textarea's actual computed line-height.
    // Any CSS-side approximation rounds slightly differently and accumulates into a
    // visible offset on long documents.
    syncGutterMetrics() {
      if (!this.gutterEl || !this.textarea) return;
      const lh = window.getComputedStyle(this.textarea).lineHeight;
      if (lh && lh !== 'normal' && lh !== this._gutterLineHeight) {
        this._gutterLineHeight = lh;
        this.gutterEl.style.setProperty('--editor-line-height', lh);
      }
    }

    // Update Line Numbers Gutter - High performance single-pass
    updateLineNumbers() {
      if (!this.gutterEl || !this.textarea) return;
      this.syncGutterMetrics();
      // Treat a single trailing newline as a line terminator, not a phantom blank
      // line. e.g. pasting "sentence\n" should show ONE line number ("1"), not
      // "1\n2", because the content is genuinely a single line. (Copying a whole
      // line from anywhere usually carries that trailing newline.)
      let text = this.textarea.value;
      if (text.endsWith('\n')) {
        text = text.slice(0, -1);
      }
      const lines = text.split('\n');
      const count = Math.max(lines.length, 1);

      // Soft-wrap means a logical line can span several visual rows, so the numbers
      // are positioned at measured offsets rather than at index * lineHeight.
      const tops = this.measureLineTops();
      // The numbers are absolutely positioned, so they escape the gutter's own
      // padding-top; the textarea's first line starts one padding-top down. Without
      // this offset every number sits ~12px too high.
      const padTop = parseFloat(window.getComputedStyle(this.textarea).paddingTop) || 0;
      const numParts = [];
      for (let i = 0; i < count; i++) {
        numParts.push(`<span class="gutter-num-abs" style="top:${((tops[i] || 0) + padTop).toFixed(2)}px">${i + 1}</span>`);
      }
      this.gutterEl.innerHTML = numParts.join('');
      this.gutterEl.style.height = `${tops[tops.length - 1] || 0}px`;
      this.updateGutterScroll();
    }

    // Keep the gutter's numbers aligned with the textarea's scroll.
    updateGutterScroll() {
      const y = this.textarea ? this.textarea.scrollTop : 0;
      if (this.gutterEl) this.gutterEl.style.transform = `translateY(${-y}px)`;
    }

    // Update Document Statistics
    updateStats(text) {
      const chars = text.length;
      const words = (text.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+/g) || []).length;
      const lines = text.split('\n').length;
      const formulas = (text.match(/\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$/g) || []).length;
      const readTime = Math.max(1, Math.ceil(words / 300));

      const statsEl = document.getElementById('docStatsText');
      if (statsEl) {
        statsEl.innerText = `${lines} 行 | ${words} 字 | ${chars} 字符 | ${formulas} 公式 | 预估阅读 ${readTime} 分钟`;
      }

      // Check with linter
      const lintResult = this.linter.lint(text);
      const scoreBadge = document.getElementById('linterScoreBadge');
      if (scoreBadge) {
        scoreBadge.innerText = `排版评分: ${lintResult.score}分`;
        scoreBadge.className = `status-score-badge ${lintResult.score >= 90 ? 'status-score-good' : 'status-score-warn'}`;
      }
    }

    // Auto save draft to LocalStorage
    autoSave() {
      const content = this.getContent();
      const ok = safeStorage.setItem('luogu_editor_draft', content);
      const saveStatus = document.getElementById('saveStatusIndicator');

      if (!ok) {
        // A failed write is the one case the user MUST know about — otherwise the
        // "已自动保存" label is an outright lie and the draft is lost on refresh.
        if (saveStatus) {
          saveStatus.innerText = '⚠ 自动保存失败，请手动导出！';
          saveStatus.classList.add('save-failed');
        }
        if (!this._saveFailWarned) {
          this._saveFailWarned = true;
          this.showToast('本地自动保存失败（存储空间不足或被浏览器禁用），请使用 Ctrl+S 手动保存文件！', 'error');
        }
        return;
      }

      this._saveFailWarned = false;
      if (saveStatus) {
        saveStatus.classList.remove('save-failed');
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        saveStatus.innerText = `已自动保存 (${timeStr})`;
      }
    }

    // Get & Set content

    setContent(content, pushHistory = true) {
      this.textarea.value = content;
      if (pushHistory) this.pushHistory();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    // Theme switcher
    setTheme(theme) {
      if (theme === 'luogu') theme = 'light';
      this.currentTheme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      safeStorage.setItem('luogu_editor_theme', theme);
      
      const themeLabel = document.getElementById('currentThemeLabel');
      if (themeLabel) {
        const labels = {
          light: '亮色',
          dark: '暗色'
        };
        themeLabel.innerText = labels[theme] || theme;
      }
    }

    // View Mode Switcher
    setViewMode(mode) {
      this.currentMode = mode;
      const workspace = document.getElementById('mainWorkspace');
      if (!workspace) return;

      workspace.classList.remove('mode-split', 'mode-editor-only', 'mode-preview-only');
      workspace.classList.add(`mode-${mode}`);

      // Update button active states
      document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
      });
    }

    // Text Insertion Helpers
    wrapSelection(prefix, suffix, defaultText = '') {
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const val = this.textarea.value;
      const selected = val.substring(start, end) || defaultText;

      const replacement = prefix + selected + suffix;
      this.textarea.value = val.substring(0, start) + replacement + val.substring(end);

      this.textarea.focus();
      this.textarea.selectionStart = start + prefix.length;
      this.textarea.selectionEnd = start + prefix.length + selected.length;

      this.pushHistory();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    insertAtCursor(text) {
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const val = this.textarea.value;

      this.textarea.value = val.substring(0, start) + text + val.substring(end);
      this.textarea.focus();
      this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;

      this.pushHistory();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    // Quick Formatting Actions
    insertBold() { this.wrapSelection('**', '**', '加粗文本'); }
    insertItalic() { this.wrapSelection('*', '*', '斜体文本'); }
    insertStrikethrough() { this.wrapSelection('~~', '~~', '删除线文本'); }
    insertInlineCode() { this.wrapSelection('`', '`', 'code'); }
    insertQuote() { this.wrapSelection('\n> ', '\n', '引用内容'); }
    insertHR() { this.insertAtCursor('\n\n---\n\n'); }
    insertMathInline() { this.wrapSelection('$', '$', 'x'); }
    insertMathBlock() { this.insertAtCursor('\n\n$$\n\\sum_{i=1}^n a_i = S_n\n$$\n\n'); }

    insertHeading(level) {
      const prefix = '#'.repeat(level) + ' ';
      this.wrapSelection(`\n${prefix}`, '\n', `标题 ${level}`);
    }

    insertTaskList() {
      this.insertAtCursor('\n- [ ] 未完成任务项\n- [x] 已完成任务项\n');
    }

    // Insert Luogu Containers
    insertCallout(type, title, isOpen) {
      const openParam = isOpen ? '{open}' : '';
      const titleParam = title ? `[${title}]` : '';
      this.insertAtCursor(`\n\n::::${type}${titleParam}${openParam}\n这里是${type}折叠框的内容。\n::::\n\n`);
    }

    insertEpigraph(author, content) {
      const authorParam = author ? `[——${author}]` : '';
      this.insertAtCursor(`\n\n:::epigraph${authorParam}\n${content || '千里之行，始于足下。'}\n:::\n\n`);
    }

    insertAlign(mode) {
      this.insertAtCursor(`\n\n:::align{${mode}}\n这里是${mode === 'center' ? '居中' : '居右'}排版的内容\n:::\n\n`);
    }

    insertBilibili(id) {
      if (!id) return;
      this.insertAtCursor(`\n\n![](bilibili:${id})\n\n`);
    }

    insertTemplate(key) {
      if (typeof LuoguTemplates !== 'undefined' && LuoguTemplates[key]) {
        if (confirm('应用模板将覆盖当前编辑区内容，是否继续？')) {
          this.setContent(LuoguTemplates[key]);
          this.showToast('模板应用成功！', 'success');
        }
      }
    }

    // Auto fix spacing using Luogu Linter
    autoFixSpacing() {
      const current = this.textarea.value;
      const formatted = this.linter.formatSpacing(current);
      if (current !== formatted) {
        this.setContent(formatted);
        this.showToast('已自动完成中英文与公式空格排版规范修复！', 'success');
      } else {
        this.showToast('排版格式已完全符合规范，无需调整！', 'info');
      }
    }

    // Toggle interactive task in preview and precisely update source markdown
    toggleTask(checkbox) {
      const taskIndexAttr = checkbox.getAttribute('data-task-index');
      if (taskIndexAttr === null || taskIndexAttr === undefined || !this.textarea) return;

      const targetIdx = parseInt(taskIndexAttr, 10);
      const isChecked = checkbox.checked;
      const val = this.textarea.value;

      let curTaskIdx = 0;
      const lines = val.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(\s*(?:[*+-]|\d+\.)\s+)\[([ xX])\](\s*.*)$/);
        if (match) {
          if (curTaskIdx === targetIdx) {
            lines[i] = `${match[1]}[${isChecked ? 'x' : ' '}]${match[3]}`;
            break;
          }
          curTaskIdx++;
        }
      }

      // Update textarea and history without triggering preview rebuild
      this.textarea.value = lines.join('\n');
      this.pushHistory();
      this.updateStats(this.getContent());
      this.autoSave();
    }

    // Copy Code Button handler
    copyCode(btn) {
      const wrapper = btn.closest('.luogu-code-block-wrapper');
      if (!wrapper) return;
      const codeTextEl = wrapper.querySelector('pre code');
      if (!codeTextEl) return;

      const textLines = Array.from(codeTextEl.querySelectorAll('.code-line-text')).map(el => el.innerText);
      const fullCode = textLines.length > 0 ? textLines.join('\n') : codeTextEl.innerText;

      navigator.clipboard.writeText(fullCode).then(() => {
        const copyText = btn.querySelector('.copy-text');
        if (copyText) copyText.innerText = '已复制!';
        setTimeout(() => {
          if (copyText) copyText.innerText = '复制';
        }, 1800);
      }).catch(err => {
        this.showToast('复制失败: ' + err.message, 'error');
      });
    }

    // Math Cheatsheet Drawer Init
    //
    // Hover jank root causes this panel used to hit:
    // 1) Each card embeds a deep KaTeX DOM tree. Changing card background/border
    //    on :hover forced the browser to repaint every nested .katex span.
    // 2) Tab switches rebuilt the grid via innerHTML, thrashing layout + style.
    // 3) modal-overlay backdrop-filter:blur kept a full-viewport blur layer live
    //    while the pointer moved across cards.
    // Fix strategy: paint hover via a cheap ::before overlay (opacity only),
    // keep every tab panel mounted and toggle visibility, mount panels once,
    // and never touch KaTeX markup after first render.
    initMathCheatsheet() {
      const container = document.getElementById('mathCheatsheetContainer');
      const tabsContainer = document.getElementById('mathTabsContainer');
      if (!container || !tabsContainer || typeof LuoguMathLibrary === 'undefined') return;

      // Idempotent: autoInit may fire more than once (DOMContentLoaded + load).
      // Re-running must not duplicate tab buttons or KaTeX panels.
      if (this._mathCheatsheetInited) {
        if (!this._mathCheatsheetBuilt) this.prefetchMathCheatsheet();
        return;
      }
      this._mathCheatsheetInited = true;

      this.mathTabCache = {};
      this.mathTabPanels = {};
      this.mathActiveTab = -1;
      this._mathCheatsheetBuilt = false;

      // Render the tab buttons only (cheap, no KaTeX) so the drawer stays usable.
      tabsContainer.innerHTML = '';
      LuoguMathLibrary.forEach((category, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `math-tab-btn ${idx === 0 ? 'active' : ''}`;
        btn.dataset.mathTab = String(idx);
        btn.innerText = category.category;
        btn.addEventListener('click', () => this.switchMathTab(idx));
        tabsContainer.appendChild(btn);
      });

      // Single delegated click handler for all formula cards (avoids N inline
      // onclick attributes and re-binding on every tab switch).
      if (!container._mathClickBound) {
        container.addEventListener('click', (e) => {
          const card = e.target && e.target.closest ? e.target.closest('.math-item-card') : null;
          if (!card || !container.contains(card)) return;
          const code = card.getAttribute('data-code');
          if (code != null) this.insertMathSymbol(code);
        });
        container._mathClickBound = true;
      }

      // Build the active tab synchronously so the drawer is never empty on open,
      // then pre-warm every remaining tab in idle time so switching stays instant.
      this.switchMathTab(0);
      this.prefetchMathCheatsheet();
    }

    _scheduleIdle(fn) {
      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(fn, { timeout: 1200 });
      } else {
        setTimeout(fn, 0);
      }
    }

    // Build a tab panel element once. KaTeX is only rendered here — never again
    // on hover / tab switch / modal open.
    buildMathTabPanel(tabIdx) {
      const category = LuoguMathLibrary[tabIdx];
      if (!category) return null;

      const panel = document.createElement('div');
      panel.className = 'math-tab-panel';
      panel.dataset.mathTab = String(tabIdx);
      panel.hidden = true;

      const isMatrixOrComplex = tabIdx === 4 || category.items.some(it => it.isWide);
      const grid = document.createElement('div');
      grid.className = `math-grid${isMatrixOrComplex ? ' math-grid-wide' : ''}`;

      const katexLib = typeof katex !== 'undefined' ? katex : (window.katex || null);
      // Reuse one options object — KaTeX doesn't mutate it.
      const katexOpts = { throwOnError: false, displayMode: false, output: 'html' };

      // DocumentFragment batches appends into a single layout pass.
      const frag = document.createDocumentFragment();

      for (let i = 0; i < category.items.length; i++) {
        const item = category.items[i];
        const card = document.createElement('button');
        card.type = 'button';
        card.className = item.isWide ? 'math-item-card card-wide' : 'math-item-card';
        card.setAttribute('data-code', item.code);
        card.setAttribute('title', item.desc || item.label || '');

        const preview = document.createElement('div');
        preview.className = 'math-item-preview';

        let rendered = false;
        if (katexLib) {
          try {
            // Strip surrounding $ / $$ so KaTeX sees pure TeX source.
            const cleanCode = String(item.code).replace(/^\$\$\n?|\n?\$\$$|^\$|\$$/g, '');
            // Keep every cheatsheet preview in inline mode: displayMode KaTeX
            // trees are much deeper and force larger paint rects on hover.
            katexOpts.displayMode = false;
            preview.innerHTML = katexLib.renderToString(cleanCode, katexOpts);
            rendered = true;
          } catch (e) {
            rendered = false;
          }
        }
        if (!rendered) {
          preview.textContent = item.label || item.code || '';
        }

        const label = document.createElement('div');
        label.className = 'math-item-label';
        label.textContent = item.label || '';

        card.appendChild(preview);
        card.appendChild(label);
        frag.appendChild(card);
      }

      grid.appendChild(frag);
      panel.appendChild(grid);
      return panel;
    }

    // Ensure a tab panel exists in the DOM (built at most once).
    ensureMathTabPanel(tabIdx) {
      const container = document.getElementById('mathCheatsheetContainer');
      if (!container || typeof LuoguMathLibrary === 'undefined') return null;

      if (!this.mathTabPanels) this.mathTabPanels = {};
      if (this.mathTabPanels[tabIdx]) return this.mathTabPanels[tabIdx];

      const panel = this.buildMathTabPanel(tabIdx);
      if (!panel) return null;
      container.appendChild(panel);
      this.mathTabPanels[tabIdx] = panel;
      // Keep a light string cache marker so prefetch knows the tab is done.
      if (!this.mathTabCache) this.mathTabCache = {};
      this.mathTabCache[tabIdx] = true;
      return panel;
    }

    // Pre-build remaining tabs across idle slices so a later switch is O(1)
    // visibility toggle — no KaTeX, no innerHTML, no layout thrash.
    prefetchMathCheatsheet() {
      if (typeof LuoguMathLibrary === 'undefined') return;
      if (!this.mathTabPanels) this.mathTabPanels = {};

      let cursor = 0;
      const step = (deadline) => {
        // Prefer building one tab per idle slice so we never block input/hover.
        const hasTime = () => {
          if (!deadline || typeof deadline.timeRemaining !== 'function') return true;
          return deadline.timeRemaining() > 8;
        };
        let built = 0;
        const MAX_PER_SLICE = 1;
        while (cursor < LuoguMathLibrary.length && built < MAX_PER_SLICE && hasTime()) {
          const idx = cursor++;
          if (!this.mathTabPanels[idx]) {
            this.ensureMathTabPanel(idx);
            built++;
          }
        }
        if (cursor < LuoguMathLibrary.length) {
          this._scheduleIdle(step);
        } else {
          this._mathCheatsheetBuilt = true;
        }
      };
      this._scheduleIdle(step);
    }

    switchMathTab(tabIdx) {
      const container = document.getElementById('mathCheatsheetContainer');
      const tabsContainer = document.getElementById('mathTabsContainer');
      if (!container || typeof LuoguMathLibrary === 'undefined') return;
      if (tabIdx === this.mathActiveTab && this.mathTabPanels && this.mathTabPanels[tabIdx]) {
        // Still sync tab button active state (e.g. first open).
        if (tabsContainer) {
          const buttons = tabsContainer.querySelectorAll('.math-tab-btn');
          buttons.forEach((t, i) => t.classList.toggle('active', i === tabIdx));
        }
        return;
      }

      if (tabsContainer) {
        const buttons = tabsContainer.querySelectorAll('.math-tab-btn');
        buttons.forEach((t, i) => t.classList.toggle('active', i === tabIdx));
      }

      // Hide previously active panel without destroying its KaTeX DOM.
      if (this.mathTabPanels && this.mathActiveTab >= 0) {
        const prev = this.mathTabPanels[this.mathActiveTab];
        if (prev) prev.hidden = true;
      }

      const panel = this.ensureMathTabPanel(tabIdx);
      if (panel) panel.hidden = false;
      this.mathActiveTab = tabIdx;
    }

    insertMathSymbol(code) {
      this.insertAtCursor(code);
      this.closeModal('mathModal');
      this.showToast('已插入数学公式！', 'success');
    }

    // Modal helpers
    openModal(modalId) {
      if (modalId === 'linterModal') {
        this.updateLinterReport();
      }
      // Warm the cheatsheet the moment the user opens it, in case idle prefetch
      // hasn't finished yet — still only builds missing tabs, never rebuilds.
      if (modalId === 'mathModal' && !this._mathCheatsheetBuilt) {
        this.prefetchMathCheatsheet();
      }
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.add('active');
    }

    updateLinterReport() {
      const container = document.getElementById('linterReportBody');
      if (!container) return;

      const markdown = this.getContent();
      const result = this.linter.lint(markdown);

      if (result.isPerfect) {
        container.innerHTML = `
          <div style="text-align:center; padding: 24px 0;">
            <div style="font-size: 42px; color: var(--luogu-green); margin-bottom: 8px;">✓</div>
            <h4 style="color: var(--luogu-green); margin-bottom: 8px;">太棒了！排版完全符合洛谷规范</h4>
            <p style="color: var(--text-secondary); font-size: 13px;">未检测到中英文缺少空格、裸露公式符号或代码块未指定语言等问题，可放心在洛谷发布！</p>
          </div>
        `;
        return;
      }

      let html = `
        <div style="margin-bottom: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
          <strong>排版综合健康度评分：</strong>
          <span style="font-size: 18px; font-weight: bold; color: ${result.score >= 90 ? 'var(--luogu-green)' : 'var(--luogu-orange)'};">${result.score} / 100 分</span>
          <p style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">共发现 ${result.issues.length} 处建议改进项：</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
      `;

      result.issues.forEach(issue => {
        const badgeColors = {
          error: 'background:#fdedec; color:#c0392b;',
          warning: 'background:#fef5e7; color:#d35400;',
          info: 'background:#ebf5fb; color:#2980b9;'
        };
        const typeLabels = { error: '错误', warning: '警告', info: '建议' };

        html += `
          <div style="padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 13px;">${escapeHtml(issue.title)}</span>
              <div>
                <span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; ${badgeColors[issue.type] || ''}">${typeLabels[issue.type] || issue.type}</span>
                <span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">第 ${issue.line} 行</span>
              </div>
            </div>
            <div style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(issue.message)}</div>
          </div>
        `;
      });

      html += '</div>';
      container.innerHTML = html;
    }

    closeModal(modalId) {
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.remove('active');
    }

    // Table Builder Logic
    initTableBuilder(rows = 3, cols = 4) {
      this.tableGridData = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
          row.push({
            text: r === 0 ? `标题 ${c + 1}` : `数据 ${r},${c + 1}`
          });
        }
        this.tableGridData.push(row);
      }
      this.renderTableBuilderGrid();
      this.openModal('tableModal');
    }

    renderTableBuilderGrid() {
      const container = document.getElementById('tableBuilderGrid');
      if (!container) return;

      let html = '<table class="grid-table-editor">';
      for (let r = 0; r < this.tableGridData.length; r++) {
        html += '<tr>';
        for (let c = 0; c < this.tableGridData[r].length; c++) {
          const cell = this.tableGridData[r][c];
          const isHeader = r === 0;
          const tag = isHeader ? 'th' : 'td';
          html += `
            <${tag}>
              <input type="text" class="grid-cell-input" value="${escapeHtml(cell.text)}" onchange="LuoguEditor.updateTableCell(${r}, ${c}, this.value)" />
              ${!isHeader ? `
                <div class="grid-cell-tools">
                  <button type="button" class="btn-mini" onclick="LuoguEditor.updateTableCell(${r}, ${c}, '^')" title="向上合并 (^) ${r > 0 ? '' : '(不可用)'}">^</button>
                  <button type="button" class="btn-mini" onclick="LuoguEditor.updateTableCell(${r}, ${c}, '<')" title="向左合并 (<) ${c > 0 ? '' : '(不可用)'}">&lt;</button>
                </div>
              ` : ''}
            </${tag}>
          `;
        }
        html += '</tr>';
      }
      html += '</table>';
      container.innerHTML = html;
    }

    updateTableCell(r, c, val) {
      if (this.tableGridData[r] && this.tableGridData[r][c]) {
        this.tableGridData[r][c].text = val;
        this.renderTableBuilderGrid();
      }
    }

    addTableRow() {
      const cols = this.tableGridData[0] ? this.tableGridData[0].length : 3;
      const r = this.tableGridData.length;
      const newRow = [];
      for (let c = 0; c < cols; c++) {
        newRow.push({ text: `数据 ${r},${c + 1}` });
      }
      this.tableGridData.push(newRow);
      this.renderTableBuilderGrid();
    }

    addTableCol() {
      const c = this.tableGridData[0] ? this.tableGridData[0].length : 0;
      for (let r = 0; r < this.tableGridData.length; r++) {
        this.tableGridData[r].push({
          text: r === 0 ? `标题 ${c + 1}` : `数据 ${r},${c + 1}`
        });
      }
      this.renderTableBuilderGrid();
    }

    buildAndInsertTable() {
      if (this.tableGridData.length === 0) return;
      const isTuack = document.getElementById('tableTuackCheck') ? document.getElementById('tableTuackCheck').checked : false;

      let md = '';
      if (isTuack) {
        md += '::cute-table{tuack}\n\n';
      }

      // Header
      const headerRow = this.tableGridData[0];
      md += '| ' + headerRow.map(cell => cell.text || ' ').join(' | ') + ' |\n';

      // Separator
      md += '| ' + headerRow.map(() => ':-:').join(' | ') + ' |\n';

      // Body
      for (let r = 1; r < this.tableGridData.length; r++) {
        md += '| ' + this.tableGridData[r].map(cell => cell.text || ' ').join(' | ') + ' |\n';
      }

      this.insertAtCursor('\n\n' + md + '\n');
      this.closeModal('tableModal');
      this.showToast('表格已成功生成并插入！', 'success');
    }

    // File Operations
    newDocument() {
      if (confirm('确定要新建文档吗？未保存的内容可在历史记录中恢复。')) {
        this.docName = '未命名_洛谷文章.md';
        if (this.docNameInput) this.docNameInput.value = this.docName;
        this.setContent('# 未命名标题\n\n在此开始编写洛谷 Markdown 内容……\n');
        this.showToast('已新建文档！', 'info');
      }
    }

    openLocalFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        this.docName = file.name;
        if (this.docNameInput) this.docNameInput.value = this.docName;
        this.setContent(text);
        this.showToast(`已成功打开文件: ${file.name}`, 'success');
      };
      reader.readAsText(file);
    }

    triggerFileOpen() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt';
      input.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.openLocalFile(e.target.files[0]);
        }
      };
      input.click();
    }

    saveMarkdownFile() {
      const content = this.getContent();
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.docName.endsWith('.md') ? this.docName : `${this.docName}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.showToast('文档已成功保存到本地！', 'success');
    }

    // One-click copy for Luogu
    copyLuoguMarkdown() {
      const content = this.getContent();
      navigator.clipboard.writeText(content).then(() => {
        this.showToast('已复制洛谷标准 Markdown 源码，可直接粘贴到洛谷发布！', 'success');
      }).catch(err => {
        this.showToast('复制失败: ' + err.message, 'error');
      });
    }

    // Export Standalone HTML (Ultra Polish & High Aesthetics)
    async exportStandaloneHTML() {
      const markdown = this.getContent();
      let renderedHtml = this.parser.render(markdown);
      
      // Make all task checkboxes disabled in exported HTML
      renderedHtml = renderedHtml.replace(/<input type="checkbox" class="luogu-task-checkbox"([^>]*)>/g, '<input type="checkbox" class="luogu-task-checkbox" disabled$1>');

      const title = this.docName.replace(/\.md$/i, '');
      const words = (markdown.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+/g) || []).length;
      const formulas = (markdown.match(/\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$/g) || []).length;
      const readTime = Math.max(1, Math.ceil(words / 300));
      const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

      // Inline the SAME KaTeX (0.18.4) CSS + fonts the editor uses, so the exported
      // document renders math identically to the preview and also works offline.
      // (The old CDN CSS was 0.16.11 and used different class names, e.g. .sizing
      // vs the 0.18.4 .katex-sizing — which broke \Huge sizing and the \ne glyph.)
      const katexCss = (typeof document !== 'undefined')
        ? Array.from(document.querySelectorAll('style'))
            .map(s => s.textContent)
            .filter(css => /@font-face\{[^}]*font-family:KaTeX_/i.test(css))
            .join('\n')
        : '';

      // Harvest the inlined Prism theme the same way. Previously the export linked
      // the jsDelivr CDN stylesheet, so an "offline export" silently lost all code
      // highlighting without a network connection.
      const prismCss = (typeof document !== 'undefined')
        ? Array.from(document.querySelectorAll('style'))
            .map(s => s.textContent)
            .filter(css => /\.token\.(?:comment|keyword|string)/.test(css))
            .join('\n')
        : '';

      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%233498db'/%3E%3Cstop offset='100%25' stop-color='%231d6fa5'/%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpath d='M7 11h3l3 7 3-7h3v10h-2.5v-6.5l-2.7 6.5h-1.6L9.5 14.5V21H7V11zm15 0h2v10h-2v-3.5h-2.5v-2H22V11z' fill='%23ffffff'/%3E%3C/svg%3E">
  <style>${katexCss}</style>
  <style>${prismCss}</style>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #1e293b;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --primary: #3498db;
      --primary-dark: #2980b9;
      --code-bg: #1e1e1e;
      --code-text: #d4d4d4;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --border: #334155;
      --primary: #38bdf8;
      --primary-dark: #0284c7;
      --code-bg: #0f172a;
      --code-text: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.8;
      color: var(--text);
      background-color: var(--bg);
      padding: 40px 16px 80px;
      transition: background-color 0.2s, color 0.2s;
    }
    .article-container {
      max-width: 880px;
      margin: 0 auto;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 48px 56px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
    }
    @media (max-width: 640px) {
      .article-container { padding: 24px 20px; }
      body { padding: 16px 8px; }
    }
    /* Top Bar */
    .article-header {
      margin-bottom: 32px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .article-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .meta-badges {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 6px;
      background: rgba(52, 152, 219, 0.1);
      color: var(--primary);
      font-size: 11px;
      font-weight: 600;
    }
    .action-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text);
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .action-btn:hover {
      border-color: var(--primary);
      color: var(--primary);
    }
    /* Typography */
    h1, h2, h3, h4, h5, h6 { color: var(--text); margin-top: 1.6em; margin-bottom: 0.6em; font-weight: 600; line-height: 1.35; }
    h1 { font-size: 2em; border-bottom: 2px solid var(--border); padding-bottom: 0.3em; }
    h2 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 0.25em; }
    p { margin-bottom: 1.1em; }
    strong { font-weight: 600; }
    em { font-style: italic; }
    del { text-decoration: line-through; color: var(--text-muted); }
    hr.luogu-hr { height: 1px; border: none; background: var(--border); margin: 2em 0; }
    blockquote.luogu-blockquote {
      margin: 1.2em 0;
      padding: 10px 18px;
      border-left: 4px solid var(--primary);
      background: rgba(52, 152, 219, 0.05);
      border-radius: 0 8px 8px 0;
      color: var(--text-muted);
    }
    .luogu-inline-code {
      font-family: Consolas, Monaco, "Cascadia Code", monospace;
      font-size: 0.88em;
      padding: 2px 6px;
      background: rgba(0, 0, 0, 0.06);
      color: #e11d48;
      border-radius: 4px;
    }
    [data-theme="dark"] .luogu-inline-code {
      background: rgba(255, 255, 255, 0.08);
      color: #f43f5e;
    }
    /* Code Blocks */
    .luogu-code-block-wrapper {
      margin: 1.4em 0;
      border-radius: 8px;
      background: var(--code-bg);
      color: var(--code-text);
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border);
    }
    .luogu-code-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: rgba(0, 0, 0, 0.25);
      font-size: 11px;
      font-weight: 600;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      gap: 8px;
    }
    .luogu-code-lang { color: #38bdf8; letter-spacing: 0.5px; flex-shrink: 0; }
    .luogu-code-actions { display: flex; align-items: center; flex-shrink: 0; white-space: nowrap !important; }
    .luogu-code-copy-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 3px 10px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      color: #e2e8f0;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap !important;
      flex-shrink: 0 !important;
      min-width: 64px;
      height: 24px;
      line-height: 1;
      user-select: none;
    }
    .luogu-code-copy-btn:hover { background: rgba(255, 255, 255, 0.2); }
    .luogu-code-copy-btn .copy-text { white-space: nowrap !important; display: inline-block; }
    .luogu-code-copy-btn .copy-icon { width: 12px; height: 12px; flex-shrink: 0; display: inline-block; }
    .luogu-code-pre {
      margin: 0;
      padding: 14px 0;
      font-family: Consolas, Monaco, "Cascadia Code", monospace;
      font-size: 13px;
      line-height: 1.6;
      /* Each .code-line is its own horizontal scroll container, so the <pre>
         itself must NOT scroll; otherwise the gutter line number would be
         carried off-screen by a long line. */
      overflow-x: visible !important;
      width: 100%;
      box-sizing: border-box;
    }
    /* Use plain block flow, not flexbox, so lines stack reliably in older embedded
       WebView engines as well as modern browsers. (With display:flex the divs fall
       back to inline and every line collapses onto one row.) */
    .code-line { display: block; overflow-x: auto; white-space: pre; padding: 0 16px; min-width: 100%; width: 100%; box-sizing: border-box; }
    .code-line-number {
      display: inline-block;
      position: sticky;
      left: 0;
      width: 36px;
      min-width: 36px;
      padding-right: 14px;
      margin-right: 10px;
      text-align: right;
      color: #64748b;
      background: var(--code-bg);
      border-right: 1px solid rgba(255, 255, 255, 0.1);
      user-select: none;
      vertical-align: top;
      z-index: 2;
    }
    .code-line-text {
      display: inline;
      white-space: pre;
      vertical-align: top;
    }
    .code-line-highlighted {
      background: rgba(234, 179, 8, 0.15);
      border-left: 3px solid #eab308;
      padding-left: 13px;
    }
    .code-line-highlighted .code-line-number {
      background: linear-gradient(rgba(234, 179, 8, 0.15), rgba(234, 179, 8, 0.15)), var(--code-bg);
    }
    /* Tables */
    .luogu-table-wrapper { width: 100%; overflow-x: auto; margin: 1.4em 0; }
    .luogu-table { width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid var(--border); }
    .luogu-table th, .luogu-table td { padding: 9px 14px; border: 1px solid var(--border); }
    .luogu-table th { background: rgba(0, 0, 0, 0.03); font-weight: 600; }
    .luogu-tuack-table { border: 2px solid #3498db; border-radius: 6px; }
    .luogu-tuack-table th { background: #3498db; color: #ffffff; text-align: center; }
    .luogu-tuack-table td { border: 1px solid #d4e6f1; }
    .luogu-tuack-table tr:nth-child(even) td { background: #f4f9fd; }
    .luogu-tuack-table tr:hover td { background: #eaf2f8; }
    [data-theme="dark"] .luogu-tuack-table { border-color: #1f6feb; }
    [data-theme="dark"] .luogu-tuack-table th { background: #1f6feb; border-color: #1759c4; }
    [data-theme="dark"] .luogu-tuack-table td { border-color: #2d3a4a; }
    [data-theme="dark"] .luogu-tuack-table tr:nth-child(even) td { background: #1c2530; }
    [data-theme="dark"] .luogu-tuack-table tr:hover td { background: #24303e; }
    /* Callouts */
    .luogu-callout { margin: 1.3em 0; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
    .luogu-callout-summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-weight: 600; font-size: 13px; cursor: pointer; list-style: none; user-select: none; }
    .luogu-callout-summary::-webkit-details-marker { display: none; }
    .luogu-callout-icon { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex-shrink: 0; }
    .callout-icon-svg { width: 18px; height: 18px; display: block; }
    .luogu-callout-title { flex: 1; font-weight: 600; }
    .luogu-callout-arrow { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; transition: transform 0.2s ease; }
    .arrow-svg { width: 14px; height: 14px; display: block; }
    .luogu-callout[open] > .luogu-callout-summary .luogu-callout-arrow { transform: rotate(180deg); }
    .luogu-callout-content { padding: 14px 18px; border-top: 1px solid var(--border); font-size: 13px; }
    .luogu-callout-info { border-left: 4px solid #3498db; }
    .luogu-callout-info .luogu-callout-summary { background: #ebf5fb; color: #1f618d; }
    .luogu-callout-success { border-left: 4px solid #2ecc71; }
    .luogu-callout-success .luogu-callout-summary { background: #eafaf1; color: #196f3d; }
    .luogu-callout-warning { border-left: 4px solid #e67e22; }
    .luogu-callout-warning .luogu-callout-summary { background: #fef5e7; color: #b9770e; }
    .luogu-callout-error { border-left: 4px solid #e74c3c; }
    .luogu-callout-error .luogu-callout-summary { background: #fdedec; color: #943126; }
    /* Dark theme callouts (导出主题切换时折叠框也要随之变色) */
    [data-theme="dark"] .luogu-callout { border-color: #334155; }
    [data-theme="dark"] .luogu-callout-info { border-left-color: #3498db; }
    [data-theme="dark"] .luogu-callout-info .luogu-callout-summary { background: #12303f; color: #9ed6f5; }
    [data-theme="dark"] .luogu-callout-success { border-left-color: #2ecc71; }
    [data-theme="dark"] .luogu-callout-success .luogu-callout-summary { background: #12321e; color: #a6e6c0; }
    [data-theme="dark"] .luogu-callout-warning { border-left-color: #e67e22; }
    [data-theme="dark"] .luogu-callout-warning .luogu-callout-summary { background: #39280f; color: #f6cf8d; }
    [data-theme="dark"] .luogu-callout-error { border-left-color: #e74c3c; }
    [data-theme="dark"] .luogu-callout-error .luogu-callout-summary { background: #3a1d1d; color: #f2ada7; }
    /* Bilibili Video */
    .luogu-bilibili-container { margin: 1.5em 0; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; background: #111827; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .luogu-bilibili-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #1f2937; color: #f9fafb; font-size: 12px; }
    .luogu-bilibili-badge { background: #fb7299; color: #ffffff; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
    .luogu-bilibili-link { display: inline-flex; align-items: center; gap: 4px; color: #38bdf8; text-decoration: none; font-size: 12px; }
    .luogu-bilibili-link:hover { text-decoration: underline; }
    .ext-icon { width: 14px; height: 14px; display: inline-block; vertical-align: middle; }
    .luogu-bilibili-player-wrapper { position: relative; width: 100%; padding-top: 56.25%; }
    .luogu-bilibili-player-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
    .luogu-bilibili-facade { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; cursor: pointer; background: #111827; color: #e5e7eb; font-size: 13px; font-family: inherit; }
    .luogu-bilibili-facade:hover { background: #1f2937; }
    .luogu-bilibili-facade:focus-visible { outline: 2px solid #38bdf8; outline-offset: -2px; }
    .luogu-bilibili-play-icon { width: 56px; height: 56px; border-radius: 50%; background: #fb7299; color: #fff; display: flex; align-items: center; justify-content: center; }
    .luogu-bilibili-play-icon svg { width: 28px; height: 28px; margin-left: 3px; }
    /* Epigraph */
    .luogu-epigraph { position: relative; margin: 1.5em 0; padding: 16px 20px 16px 48px; background: rgba(0,0,0,0.02); border-left: 4px solid var(--primary); border-radius: 6px; }
    .luogu-epigraph-quote-mark { position: absolute; top: 6px; left: 14px; font-size: 38px; line-height: 1; font-family: Georgia, serif; color: var(--primary); opacity: 0.5; }
    .luogu-epigraph-body { font-style: italic; font-size: 14px; margin-bottom: 6px; }
    .luogu-epigraph-author { text-align: right; font-size: 12px; color: var(--text-muted); }
    .luogu-align-center { text-align: center; margin: 1.2em 0; }
    .luogu-align-right { text-align: right; margin: 1.2em 0; }
    /* KaTeX sizing uses the inlined 0.18.4 stylesheet (class .katex-sizing.reset-size6.sizeN);
       only keep the display/base font tweaks for the exported theme. */
    .katex { font: normal 1.15em KaTeX_Main, "Times New Roman", serif; line-height: 1.2; }
    .katex-display { display: block; margin: 1em 0; text-align: center; }
    .luogu-math-display { text-align: center; margin: 1.2em 0; overflow-x: auto; }
    /* Lists & Tasks */
    ul.luogu-list, ol.luogu-list { padding-left: 24px; margin-bottom: 1em; }
    li { margin-bottom: 0.4em; }
    ul.luogu-task-list { list-style: none; padding-left: 0; }
    .luogu-task-item { display: flex; align-items: center; margin-bottom: 6px; }
    .luogu-checkbox-label { display: flex; align-items: center; gap: 8px; cursor: default; }
    .luogu-task-checkbox { width: 15px; height: 15px; accent-color: var(--primary); pointer-events: none !important; cursor: default !important; }
    /* Toast */
    .toast-tip {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 8px 16px;
      background: #1e293b;
      color: #fff;
      border-radius: 6px;
      font-size: 12px;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.2);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s;
      pointer-events: none;
      z-index: 1000;
    }
    .toast-tip.show { opacity: 1; transform: translateY(0); }
    /* Print */
    @media print {
      /* Force a light palette so the printed PDF stays readable regardless of the
         exported document's active theme. */
      :root, [data-theme="dark"] {
        --bg: #ffffff;
        --card-bg: #ffffff;
        --text: #24292e;
        --text-muted: #6e7781;
        --border: #d0d7de;
        --primary: #3498db;
        --code-bg: #f6f8fa;
        --code-text: #24292e;
      }
      .luogu-tuack-table { border-color: #3498db !important; }
      .luogu-tuack-table th { background: #3498db !important; border-color: #2980b9 !important; color: #fff !important; }
      .luogu-tuack-table td { border-color: #d4e6f1 !important; }
      .luogu-tuack-table tr:nth-child(even) td { background: #f4f9fd !important; }
      .luogu-tuack-table tr:hover td { background: #eaf2f8 !important; }
      body { padding: 0; background: #fff; color: #1a1a1a; }
      .article-container { border: none; box-shadow: none; padding: 0; max-width: 100%; }
      .action-bar, .luogu-code-copy-btn, .toast-tip, .luogu-bilibili-container { display: none !important; }
      .luogu-callout { display: block !important; margin: 12px 0 !important; }
      .luogu-callout-content { display: block !important; }
      .luogu-callout-arrow { display: none !important; }
      .luogu-code-pre, .code-line, .code-line-text, pre, code {
        white-space: pre-wrap !important;
        word-break: break-all !important;
      }
      .code-line { display: block !important; }
      .code-line-text { display: inline !important; white-space: pre-wrap !important; }
      h1, h2, h3, h4, h5, h6, pre, .luogu-callout, table, tr { page-break-inside: avoid !important; break-inside: avoid !important; }
    }
  </style>
</head>
<body>
  <div class="article-container">
    <div class="article-header">
      <div class="article-meta">
        <div class="meta-badges">
          <span class="badge">洛谷 Markdown</span>
          <span>📅 ${nowStr}</span>
          <span>📖 ${words} 字 (约 ${readTime} 分钟)</span>
          <span>📐 ${formulas} 个公式</span>
        </div>
        <div class="action-bar">
          <button class="action-btn" onclick="toggleTheme()" title="切换亮暗主题">🌓 主题</button>
          <button class="action-btn" onclick="copyFullContent()" title="复制全文 Markdown">📋 复制</button>
        </div>
      </div>
    </div>

    <main class="article-content" id="articleBody">
      ${renderedHtml}
    </main>
  </div>

  <textarea id="rawMarkdownSource" style="display:none;" readonly>${escapeHtml(markdown)}</textarea>
  <div id="toastTip" class="toast-tip">已复制 Markdown 源码！</div>

  <script>
    // Bilibili players are loaded only on demand so an exported document stays
    // fully offline (and tracker-free) until the reader opts in.
    function loadBilibiliPlayer(btn) {
      var src = btn.getAttribute('data-src');
      if (!src) return;
      var iframe = document.createElement('iframe');
      iframe.setAttribute('src', src);
      iframe.setAttribute('scrolling', 'no');
      iframe.setAttribute('frameborder', 'no');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      // allow-same-origin is required for the player to reach its own storage; it is
      // safe because the frame is never same-origin with this page.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
      btn.replaceWith(iframe);
    }

    function toggleTheme() {
      var html = document.documentElement;
      var cur = html.getAttribute('data-theme') || 'light';
      html.setAttribute('data-theme', cur === 'light' ? 'dark' : 'light');
    }

    window.copyCodeBlock = function(btn) {
      var wrapper = btn.closest('.luogu-code-block-wrapper');
      if (!wrapper) return;
      var codeLines = Array.from(wrapper.querySelectorAll('.code-line-text')).map(function(el) { return el.innerText; });
      var text = codeLines.length > 0 ? codeLines.join('\\n') : (wrapper.querySelector('pre code') ? wrapper.querySelector('pre code').innerText : '');
      navigator.clipboard.writeText(text).then(function() {
        var span = btn.querySelector('.copy-text') || btn;
        var oldText = span.innerText;
        span.innerText = '✓ 已复制';
        btn.style.borderColor = '#2ecc71';
        btn.style.color = '#2ecc71';
        setTimeout(function() {
          span.innerText = oldText;
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 1800);
      }).catch(function() {
        showToast('复制失败，请手动选择复制');
      });
    };
    window.LuoguEditor = window.LuoguEditor || {};
    window.LuoguEditor.copyCode = window.copyCodeBlock;

    function copyFullContent() {
      var rawEl = document.getElementById('rawMarkdownSource');
      if (!rawEl) return;
      var md = rawEl.value || rawEl.textContent;
      navigator.clipboard.writeText(md).then(function() {
        showToast('已复制 Markdown 源码！');
      }).catch(function() {
        showToast('复制失败，请手动复制');
      });
    }

    function showToast(msg) {
      var tip = document.getElementById('toastTip');
      if (!tip) return;
      tip.innerText = msg;
      tip.classList.add('show');
      setTimeout(function() { tip.classList.remove('show'); }, 2000);
    }

    // Auto expand all callouts during print in exported HTML
    window.addEventListener('beforeprint', function() {
      var callouts = document.querySelectorAll('details.luogu-callout');
      for (var i = 0; i < callouts.length; i++) {
        callouts[i].setAttribute('open', '');
      }
    });
  <` + `/script>
</body>
</html>`;

      const fileName = `${title}.html`;
      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });

      // Prefer the File System Access API so the user can choose the save location
      // and rename the file (native "Save As" dialog). Fall back to a normal
      // download where the API isn't available (Firefox / Safari).
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: 'HTML 文档', accept: { 'text/html': ['.html'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(fullHtml);
          await writable.close();
          this.showToast('已导出高颜值独立 HTML 文档！', 'success');
          return;
        } catch (err) {
          // AbortError = user cancelled the dialog: stop silently.
          if (err && err.name === 'AbortError') return;
          // Any other error (e.g. permission) → fall through to the normal download.
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.showToast('已导出高颜值独立 HTML 文档！', 'success');
    }

    // Print / PDF Export
    printDocument() {
      // Temporarily open all details so every browser engine prints them expanded
      const allDetails = document.querySelectorAll('details.luogu-callout');
      const states = [];
      allDetails.forEach(d => {
        states.push(d.hasAttribute('open'));
        d.setAttribute('open', '');
      });

      window.print();

      // Restore states after print dialog closes
      setTimeout(() => {
        allDetails.forEach((d, idx) => {
          if (!states[idx]) {
            d.removeAttribute('open');
          }
        });
      }, 600);
    }

    // Toast notifications
    showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerText = message;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.2s';
        setTimeout(() => toast.remove(), 200);
      }, 3000);
    }
  }

  // Helpers
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeJsString(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  }

  // Instantiate global editor
  const LuoguEditor = new LuoguEditorApp();

  // Global helper for code block copy buttons
  global.copyCodeBlock = function (btn) {
    if (typeof LuoguEditor !== 'undefined' && LuoguEditor.copyCode) {
      LuoguEditor.copyCode(btn);
    }
  };
  // Click-to-load for Bilibili embeds.
  //
  // The iframe used to be emitted eagerly, so merely opening the editor (whose
  // welcome document contains a video) fired requests to player.bilibili.com and
  // hdslb.com. That broke the "fully offline" guarantee and silently leaked a
  // request — plus third-party tracking cookies — before the user did anything.
  // The player is now only fetched after an explicit click.
  // Which video URLs the user has explicitly opted into playing. Survives preview
  // re-renders so an edit elsewhere in the document never demotes a live player back
  // to its "click to load" facade.
  const loadedBiliSrcs = new Set();

  global.loadBilibiliPlayer = function (btn) {
    const src = btn.getAttribute('data-src');
    if (!src) return;
    loadedBiliSrcs.add(src);
    const iframe = document.createElement('iframe');
    iframe.setAttribute('src', src);
    iframe.setAttribute('scrolling', 'no');
    iframe.setAttribute('frameborder', 'no');
    iframe.setAttribute('framespacing', '0');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    // allow-same-origin is required: without it the frame gets an opaque origin, the
    // player's storage access throws, and it dies as an empty black box. It is safe
    // here because escaping a sandbox via allow-scripts+allow-same-origin requires the
    // frame to be SAME-origin with its parent; player.bilibili.com never is, so the
    // frame merely regains its own origin and still cannot touch this document.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
    // Mirrored onto the iframe so the preview differ can recognise this subtree as
    // "the same video" as the facade the next render produces.
    iframe.setAttribute('data-src', src);
    btn.replaceWith(iframe);
  };

  // Global helper for task checkbox toggle
  global.toggleTaskCheckbox = function (cb) {
    if (typeof LuoguEditor !== 'undefined' && LuoguEditor.toggleTask) {
      LuoguEditor.toggleTask(cb);
    }
  };

  if (typeof window !== 'undefined') {
    window.copyCodeBlock = global.copyCodeBlock;
    window.toggleTaskCheckbox = global.toggleTaskCheckbox;
    window.loadBilibiliPlayer = global.loadBilibiliPlayer;
  }

  global.LuoguEditorApp = LuoguEditorApp;
  global.LuoguEditor = LuoguEditor;
  if (typeof window !== 'undefined') {
    window.LuoguEditorApp = LuoguEditorApp;
    window.LuoguEditor = LuoguEditor;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LuoguEditorApp, LuoguEditor };
  }

  // Auto initialize immediately and on load
  function autoInit() {
    function tryInit() {
      if (typeof document !== 'undefined' && document.getElementById('editorTextarea')) {
        LuoguEditor.init();
        return true;
      }
      return false;
    }

    if (!tryInit()) {
      if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => tryInit());
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('load', () => tryInit());
      }
    }
  }

  if (typeof document !== 'undefined') {
    autoInit();
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
