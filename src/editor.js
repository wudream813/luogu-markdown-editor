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

  // i18n：应用里是真正的翻译函数（src/i18n.js 先于本文件加载）；
  // 单元测试（node 直接 require 本文件）里它退化成"原样返回 + 插值"。
  const T = (global.LuoguI18n && global.LuoguI18n.t) || ((s, v) => (v
    ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : m))
    : s));
  const LatexTools = global.LuoguLatexEditorTools
    || (typeof require === 'function' ? require('./latex-editor-tools.js') : null);
  const EDITOR_FONT_SIZES = [13, 14, 15, 16, 18, 20];
  const PREVIEW_FONT_SIZES = [14, 15, 16, 17, 18, 20];

  function storedFontSize(key, allowed, fallback) {
    const value = Number(safeStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  }


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
      
      this.docName = T('洛谷题解_未命名.md');
      // Scroll sync defaults to on; a stored '0' turns it off.
      this.scrollSyncEnabled = safeStorage.getItem('luogu_editor_scroll_sync') !== '0';
      // Typography lint display defaults to on; a stored '0' hides it.
      this.lintDisplayEnabled = safeStorage.getItem('luogu_editor_lint_display') !== '0';
      this.currentMode = 'split'; // 'split' | 'editor-only' | 'preview-only' | 'typora'
      // 双栏比例（左侧百分比）。拖动一次就记住，下次打开还是这个分法。
      this.splitRatio = (() => {
        const raw = Number(safeStorage.getItem('luogu_editor_split_ratio'));
        return Number.isFinite(raw) && raw >= 15 && raw <= 85 ? raw : 50;
      })();
      this.typora = null;         // lazily constructed once the DOM is bound
      this.currentTheme = 'luogu';
      this.editorFontSize = storedFontSize('luogu_editor_font_size', EDITOR_FONT_SIZES, 15);
      this.previewFontSize = storedFontSize('luogu_preview_font_size', PREVIEW_FONT_SIZES, 16);
      this._latexCompletionContext = null;
      this._latexCompletionItems = [];
      this._latexCompletionIndex = 0;
      this._latexBracketPair = null;
      this._latexCaretMirror = null;
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
      this.applyFontSizes();

      // Typora mode edits blocks straight in the preview. It is optional: if the
      // module is absent the editor keeps working, just without the fourth mode.
      const TyporaClass = (typeof LuoguTypora !== 'undefined') ? LuoguTypora
        : (typeof window !== 'undefined' ? window.LuoguTypora : null);
      this.typora = TyporaClass ? new TyporaClass(this) : null;

      this._restoringWorkspace = true;
      // Load saved draft or initial demo template
      const savedContent = safeStorage.getItem('luogu_editor_draft');
      const savedDocName = safeStorage.getItem('luogu_editor_doc_name');
      const savedTheme = safeStorage.getItem('luogu_editor_theme') || 'luogu';

      if (savedDocName) {
        this.docName = savedDocName;
        if (this.docNameInput) this.docNameInput.value = this.docName;
      }

      this.setTheme(savedTheme);
      // 语言：首次跟随系统，之后记住选择（见 LuoguI18n）。
      LuoguI18n.init();
      this._syncSettingsModal();
      // Reflect the stored scroll-sync preference on the toolbar button.
      this.toggleScrollSync(this.scrollSyncEnabled);
      this.applyLintDisplay();
      // 上一次用的视图模式（双栏 / 纯编辑 / 纯预览 / Typora）也一并恢复。
      this.setViewMode(safeStorage.getItem('luogu_editor_view_mode') || 'split', true);

      if (savedContent && savedContent.trim().length > 0) {
        this.resetCalloutToggles();
        this.setContent(savedContent, false);
      } else if (typeof LuoguTemplates !== 'undefined' && LuoguTemplates.demo) {
        this.resetCalloutToggles();
        this.setContent(LuoguTemplates.demo, false);
      } else {
        this.resetCalloutToggles();
        this.setContent(T('# 未命名标题\n\n在此开始编写洛谷 Markdown 内容……\n'), false);
      }

      // Tabs in both builds; folder tree and disk access are desktop-only.
      // It has to come *after* the content above: the first
      // tab adopts whatever the editor is showing at this moment, and mounting earlier
      // left the panel holding an empty document while the editor showed the draft.
      if (typeof LuoguWorkspace !== 'undefined') {
        try {
          const ws = new LuoguWorkspace(this);
          if (ws.mount()) {
            this.workspace = ws;
            ws._syncSettingsMenu();
          }
        } catch (e) { /* never let the panel break startup */ }
      }

      this._restoringWorkspace = false;
      this.autoSave();
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
        // Ctrl+P bypasses printDocument(), so the light/dark decision has to be made
        // here too, or a keyboard-initiated print would fall through with no
        // print-light/print-dark class and lose every print rule.
        const root = document.documentElement;
        if (!root.classList.contains('print-light') && !root.classList.contains('print-dark')) {
          const theme = root.getAttribute('data-theme') || 'light';
          root.classList.add(theme === 'dark' ? 'print-dark' : 'print-light');
        }

        savedStates = [];
        const callouts = document.querySelectorAll('details.luogu-callout');
        callouts.forEach(d => {
          savedStates.push({ el: d, wasOpen: d.hasAttribute('open') });
          d.setAttribute('open', '');
        });
      });

      window.addEventListener('afterprint', () => {
        document.documentElement.classList.remove('print-light', 'print-dark', 'print-noi');
        savedStates.forEach(item => {
          if (!item.wasOpen) {
            item.el.removeAttribute('open');
          }
        });
        savedStates = [];
      });
    }

    bindEvents() {
      // 设置页按 Esc 关掉。别的弹窗没这个待遇：它们大多是"再点一下就去做事"的插入
      // 面板，而设置页是用户会停留、改完就想走的地方。
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('settingsModal');
        if (modal && modal.classList.contains('active')) {
          e.preventDefault();
          this.closeModal('settingsModal');
        }
      });

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
        // Pair matching and command suggestions respond immediately; the expensive
        // preview/linter work keeps its existing idle debounce.
        this.refreshLatexAssist();
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
        // The highlight layer is a separate element, so it has to be scrolled in
        // lockstep or the boxes slide away from their glyphs.
        const hl = document.getElementById('findHighlights');
        if (hl) {
          hl.scrollTop = this.textarea.scrollTop;
          hl.scrollLeft = this.textarea.scrollLeft;
        }
        if (this._latexCompletionPopup && !this._latexCompletionPopup.hidden) {
          this.positionLatexCompletion();
        }
        if (this.isEchoScroll(this.textarea)) return;
        this.syncScroll('editor');
      });

      this.previewEl.addEventListener('scroll', () => {
        if (this.isEchoScroll(this.previewEl)) return;
        this.syncScroll('preview');
      });

      // Keyboard shortcuts and LaTeX editing assists.
      this.textarea.addEventListener('keydown', (e) => this.handleKeyDown(e));
      this.textarea.addEventListener('keyup', () => this.updateBracketHighlight());
      this.textarea.addEventListener('click', () => this.refreshLatexAssist());
      this.textarea.addEventListener('select', () => this.refreshLatexAssist());
      this.textarea.addEventListener('focus', () => this.refreshLatexAssist());
      this.textarea.addEventListener('blur', () => {
        this.hideLatexCompletion();
        this._latexBracketPair = null;
        this._paintHighlights();
      });
      document.addEventListener('selectionchange', () => {
        if (document.activeElement === this.textarea) this.refreshLatexAssist();
      });
      const completionPopup = document.getElementById('latexCompletionPopup');
      if (completionPopup) {
        completionPopup.addEventListener('mousedown', (e) => {
          // Keep the textarea selection/caret (and its keyboard focus) while choosing
          // a completion with the pointer.
          if (e.target.closest('.latex-completion-item')) e.preventDefault();
        });
        completionPopup.addEventListener('click', (e) => {
          const item = e.target.closest('.latex-completion-item');
          if (!item) return;
          this.acceptLatexCompletion(Number(item.dataset.index));
        });
      }

      // Find bar: live search as you type, Enter / Shift+Enter to step, Esc to close.
      const findInput = document.getElementById('findInput');
      const replaceInput = document.getElementById('replaceInput');
      // Undo/redo must keep working while the caret sits in the find or replace box.
      // Those are ordinary <input>s, so the browser would apply *their* own undo
      // stack (usually empty) and the document edit would appear un-undoable — the
      // exact symptom of "Ctrl+Z cannot take back my replacements", since after a
      // replace the focus is still in the replace box.
      const docUndoKeys = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return false;
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return true;
        }
        if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          this.redo();
          return true;
        }
        return false;
      };

      if (findInput) {
        findInput.addEventListener('input', () => this.runFind());
        findInput.addEventListener('keydown', (e) => {
          if (docUndoKeys(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) this.findPrev(); else this.findNext();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.closeFind();
          }
        });
      }
      if (replaceInput) {
        replaceInput.addEventListener('keydown', (e) => {
          if (docUndoKeys(e)) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            // Ctrl+Enter replaces everything; plain Enter replaces just this one.
            if (e.ctrlKey || e.metaKey) this.replaceAll(); else this.replaceOne();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.closeFind();
          }
        });
      }

      // Doc name input
      if (this.docNameInput) {
        this.docNameInput.addEventListener('change', (e) => {
          this.docName = e.target.value.trim() || T('未命名.md');
          safeStorage.setItem('luogu_editor_doc_name', this.docName);
        });
      }

      // Drag and Drop files onto editor
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        // 桌面版：OS 的文件拖放由工作区接管（Tauri 的原生事件带绝对路径，拖进来的
        // 文件因此能写回原文件）。HTML5 这条留给网页版——浏览器里没有别的路可走。
        if (this.workspace && this.workspace.nativeDrop) return;
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files || files.length === 0) return;

        // Only text-ish documents can be opened. Dropping an image used to load its
        // binary content into the editor as mojibake with no explanation.
        const TEXT_EXT = /\.(md|markdown|txt|text)$/i;
        const file = files[0];
        if (!TEXT_EXT.test(file.name)) {
          this.showToast(T('无法打开「{a}」：仅支持 .md / .markdown / .txt 文件', { a: file.name }), 'error');
          return;
        }
        if (files.length > 1) {
          this.showToast(T('已打开「{a}」，其余 {b} 个文件被忽略', { a: file.name, b: files.length - 1 }), 'info');
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

        // Watch the preview too. Its anchors move whenever its content reflows —
        // KaTeX finishing layout, an image or the Bilibili iframe arriving, a font
        // swap — none of which bump _renderSeq. Without this the sync can aim at
        // coordinates that are already obsolete.
        const pro = new ResizeObserver(() => { this._anchorsKey = null; });
        pro.observe(this.previewEl);
        this._previewResizeObserver = pro;
      }

      // <details> toggling changes layout without resizing the scroll container in
      // every case, so invalidate explicitly on toggle as well.
      this.previewEl.addEventListener('toggle', (e) => {
        this._anchorsKey = null;
        // Remember boxes the reader opened/closed by hand, keyed by document order.
        // Order survives a rename or a type change, which the old title-based key did
        // not: renaming a box changed its key and silently dropped its open state.
        const d = e.target;
        if (!d || !d.classList || !d.classList.contains('luogu-callout')) return;
        // Key on the source line, not document order: it survives a rename or a type
        // change (both rewrite the same line in place) while still pointing at one
        // specific box in the document.
        const key = d.getAttribute('data-src-line');
        if (key === null) return;
        if (!this._calloutToggles) this._calloutToggles = new Map();
        this._calloutToggles.set(key, d.open);
      }, true);
      window.addEventListener('resize', () => {
        this._lineTopsKey = null;
        this._anchorsKey = null;
        this.updateLineNumbers();
        if (this._latexCompletionPopup && !this._latexCompletionPopup.hidden) {
          this.positionLatexCompletion();
        }
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

      // 两侧面板的 basis 用 calc 各扣掉半个分割条：这样三者之和恰好等于容器宽度，
      // 分割条既不会被挤掉，也不会把内容顶出容器。
      this.applySplitFlex = (mode) => {
        if (mode !== 'split') {
          editorPane.style.flex = '';
          previewPane.style.flex = '';
          return;
        }
        const left = this.splitRatio;
        editorPane.style.flex = `0 0 calc(${left}% - 3px)`;
        previewPane.style.flex = `0 0 calc(${100 - left}% - 3px)`;
      };

      const onPointerMove = (e) => {
        const rect = workspace.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const totalWidth = rect.width;
        if (offsetX > MIN_PANE_WIDTH && (totalWidth - offsetX) > MIN_PANE_WIDTH) {
          this.splitRatio = Math.round((offsetX / totalWidth) * 1000) / 10;
          this.applySplitFlex('split');
        }
      };

      const endDrag = () => {
        if (activePointerId === null) return;
        this._saveSplitRatio();
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

      // 启动时把上次的比例摆回去（比例本身只对双栏有意义）。
      this.applySplitFlex(this.currentMode);

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
      resizer.setAttribute('aria-label', T('调整编辑区与预览区宽度'));
      resizer.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const rect = workspace.getBoundingClientRect();
        const current = editorPane.getBoundingClientRect().width;
        const delta = e.key === 'ArrowLeft' ? -32 : 32;
        const next = current + delta;
        if (next > MIN_PANE_WIDTH && (rect.width - next) > MIN_PANE_WIDTH) {
          this.splitRatio = Math.round((next / rect.width) * 1000) / 10;
          this.applySplitFlex('split');
          this._saveSplitRatio();
        }
      });
    }

    /**
     * 切换界面语言。除了静态文案（由 i18n 的 applyDom 负责），还有一批文案是
     * 渲染时算出来的——标签页名、状态栏、面板标题、公式面板——所以切完要让它们重画。
     */
    setLanguage(next) {
      const lang = LuoguI18n.setLang(next);
      this._syncSettingsModal();
      // 重画动态文案：面板（标签页 / 状态栏 / 文件树菜单）、公式面板、排版问题面板。
      if (this.workspace && this.workspace.render) this.workspace.render();
      if (this.workspace && this.workspace._syncSettingsMenu) this.workspace._syncSettingsMenu();
      if (typeof this.renderMathCheatsheet === 'function') this.renderMathCheatsheet();
      if (typeof this.applyLintDisplay === 'function') this.applyLintDisplay();
      if (typeof this.updateStatusBar === 'function') this.updateStatusBar();
      this.showToast(lang === 'zh' ? T('界面语言：简体中文') : T('Interface language: English'), 'success');
      return lang;
    }

    /**
     * 把当前设置同步到设置弹窗里的控件。
     *
     * 设置页里的控件是"显示状态"的一方，不是"保存状态"的一方：所有状态都存在各自的
     * 模块里（编辑器 / 工作区 / i18n），这里只负责把它们画到界面上。这样从别处改动
     * （快捷键、状态栏按钮、程序恢复）也会反映过来。
     */
    _syncSettingsModal() {
      const theme = document.getElementById('settingsThemeSelect');
      if (theme) theme.value = this.currentTheme === 'dark' ? 'dark' : 'light';

      const lang = document.getElementById('settingsLangSelect');
      if (lang) lang.value = LuoguI18n.currentSetting();

      const lint = document.getElementById('lintDisplayToggle');
      if (lint) lint.checked = !!this.lintDisplayEnabled;

      const editorSize = document.getElementById('settingsEditorFontSize');
      if (editorSize) editorSize.value = String(this.editorFontSize);
      const previewSize = document.getElementById('settingsPreviewFontSize');
      if (previewSize) previewSize.value = String(this.previewFontSize);

      if (this.workspace && this.workspace._syncSettingsMenu) this.workspace._syncSettingsMenu();
    }

    /** 齿轮：先同步控件状态，再打开。 */
    openSettings() {
      this._syncSettingsModal();
      this.openModal('settingsModal');
    }

    _saveSplitRatio() {
      safeStorage.setItem('luogu_editor_split_ratio', String(this.splitRatio));
    }

    applyFontSizes() {
      const root = document.documentElement;
      root.style.setProperty('--editor-font-size', `${this.editorFontSize}px`);
      root.style.setProperty('--preview-font-size', `${this.previewFontSize}px`);
      this._syncSettingsModal();
    }

    setFontSize(target, rawValue) {
      const editor = target === 'editor';
      const allowed = editor ? EDITOR_FONT_SIZES : PREVIEW_FONT_SIZES;
      const value = Number(rawValue);
      if (!allowed.includes(value)) return false;

      if (editor) {
        this.editorFontSize = value;
        safeStorage.setItem('luogu_editor_font_size', String(value));
      } else if (target === 'preview') {
        this.previewFontSize = value;
        safeStorage.setItem('luogu_preview_font_size', String(value));
      } else {
        return false;
      }

      this.applyFontSizes();
      this._lineTopsKey = null;
      this._anchorsKey = null;
      if (this.textarea) this.updateLineNumbers();
      if (this._latexCompletionPopup && !this._latexCompletionPopup.hidden) {
        this.positionLatexCompletion();
      }
      return value;
    }

    // Synchronize scrolling between editor and preview
    // Build a sorted list of {srcLine, previewTop} anchors from the rendered blocks.
    // These pair a source line with where its output actually sits, which is the only
    // way tall constructs (code fences, display math, wide tables) can stay aligned:
    // their source height and rendered height are unrelated, so a percentage mapping
    // is guaranteed to drift.
    buildScrollAnchors() {
      if (!this.previewEl) return [];
      // The cache key must capture everything the anchor GEOMETRY depends on, not just
      // the render generation. Anchor tops are layout values, and layout changes with
      // no re-render at all: expanding a <details>, KaTeX/images/iframes finishing an
      // async load, a font swap, or the splitter being dragged. Keying on _renderSeq
      // alone meant sync kept using coordinates from before such a shift, so it aimed
      // at a position that no longer existed — the preview flew off and then settled
      // somewhere wrong. Fold the preview's own scroll height and width into the key so
      // any reflow invalidates it.
      const key = `${this._renderSeq || 0}\u0000${this.previewEl.scrollHeight}\u0000${this.previewEl.clientWidth}`;
      if (this._anchorsKey === key && this._anchors) return this._anchors;

      const nodes = this.previewEl.querySelectorAll('[data-src-line]');
      const baseTop = this.previewEl.getBoundingClientRect().top - this.previewEl.scrollTop;
      const anchors = [];
      nodes.forEach((el) => {
        const line = parseInt(el.getAttribute('data-src-line'), 10);
        if (!Number.isFinite(line)) return;

        // Content inside a COLLAPSED <details> has no box of its own. It used to be
        // skipped outright, which left a hole in the anchor list: every hidden line
        // got linearly smeared across the gap between the anchors on either side, so
        // scrolling a 13-line collapsed body moved the preview by ~6px and then made
        // it lurch. Map such lines onto their nearest visible ancestor instead — the
        // callout box that actually represents them — so the preview parks on that box
        // for as long as the editor is inside it.
        // Content inside a COLLAPSED <details> has no box of its own, so it cannot
        // contribute a position. Drop it here; the span handling below covers those
        // lines using the callout box itself.
        if (el.offsetParent === null && el !== this.previewEl) return;
        const top = el.getBoundingClientRect().top - baseTop;
        const prev = anchors[anchors.length - 1];
        if (prev && prev.line === line) return;
        anchors.push({ line, top });
      });

      // A collapsed callout stands for every source line between its ':::' delimiters,
      // but contributes a single anchor at its opening line. Without a second anchor at
      // its END line, all those lines were smeared across the gap to the next visible
      // block: scrolling a 13-line collapsed body nudged the preview ~6px and then made
      // it lurch. Adding an end anchor at the same box makes the mapping deliberately
      // flat over the hidden range — the preview parks on the callout while the editor
      // travels through it, then resumes cleanly.
      this.previewEl.querySelectorAll('details.luogu-callout[data-src-end-line]').forEach((d) => {
        if (d.hasAttribute('open')) return;              // expanded: real boxes exist
        if (d.offsetParent === null) return;             // itself hidden (nested)
        const endLine = parseInt(d.getAttribute('data-src-end-line'), 10);
        if (!Number.isFinite(endLine)) return;
        const r = d.getBoundingClientRect();
        anchors.push({ line: endLine, top: r.bottom - baseTop });
      });
      anchors.sort((a, b) => a.line - b.line || a.top - b.top);

      // Both binary searches below (previewTopForLine / lineForPreviewTop) require top
      // to be non-decreasing as line increases. Legitimate markup can violate that:
      // inside nested <details>, the innermost content has a high source line but sits
      // physically above the closing markup of the outer levels. Feeding a
      // non-monotonic array to a binary search yields an essentially random hit, which
      // is what threw the preview to a far-off offset (the "bounce"). Clamp each entry
      // to its predecessor so the sequence is monotonic; a handful of anchors then
      // share a top, which merely makes the mapping locally flat instead of wrong.
      for (let i = 1; i < anchors.length; i++) {
        if (anchors[i].top < anchors[i - 1].top) anchors[i].top = anchors[i - 1].top;
      }


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

    /**
     * Turn scroll synchronisation on or off.
     *
     * Some people write with the two panes deliberately at different places (editing
     * a footnote while reading the top of the article), where the auto-scroll fights
     * them. The preference is remembered.
     */
    toggleScrollSync(force) {
      this.scrollSyncEnabled = (force === undefined) ? !this.scrollSyncEnabled : !!force;
      safeStorage.setItem('luogu_editor_scroll_sync', this.scrollSyncEnabled ? '1' : '0');
      const btn = document.getElementById('scrollSyncBtn');
      if (btn) {
        btn.classList.toggle('active', this.scrollSyncEnabled);
        btn.setAttribute('aria-pressed', this.scrollSyncEnabled ? 'true' : 'false');
        btn.title = T('滚动同步：{a}', { a: this.scrollSyncEnabled ? T('开') : T('关') });
      }
      // Turning it back on must close the gap that opened while it was off,
      // otherwise the two panes stay stranded until the next scroll event.
      if (this.scrollSyncEnabled) {
        this._echo = null;
        this.syncScroll('editor');
      }
      if (this.showToast) {
        this.showToast(T('滚动同步已{a}', { a: this.scrollSyncEnabled ? T('开启') : T('关闭') }), 'info');
      }
      return this.scrollSyncEnabled;
    }

    syncScroll(source) {
      if (!this.scrollSyncEnabled) return;
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
          let target = this.previewTopForLine(anchors, docLine, frac);
          if (target !== null) {
            // Scrolled fully to the top, the preview must be at 0 too.
            //
            // The first block sits below the preview's own top padding plus its own
            // margin, so line 0 legitimately maps to a positive offset (~63px under a
            // leading <h1>) — that offset is what keeps a heading aligned with its
            // source line everywhere else, so it must not be scaled away. But applying
            // it at y === 0 scrolls the document's leading whitespace out of view, and
            // the preview looks stuck just below the start with no way to reach it.
            //
            // Treat only the exact top as the special case it is.
            if (y <= 0) target = 0;
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

    refreshLatexAssist() {
      this.updateBracketHighlight();
      this.updateLatexCompletion();
    }

    updateBracketHighlight() {
      if (!this.textarea || !LatexTools) return;
      const collapsed = this.textarea.selectionStart === this.textarea.selectionEnd;
      if (document.activeElement !== this.textarea || !collapsed) {
        this._latexBracketPair = null;
      } else {
        this._latexBracketPair = LatexTools.findMatchingDelimiter(
          this.textarea.value, this.textarea.selectionStart,
        );
      }
      this._paintHighlights();
    }

    updateLatexCompletion() {
      const popup = document.getElementById('latexCompletionPopup');
      this._latexCompletionPopup = popup;
      if (!popup || !this.textarea || !LatexTools
          || document.activeElement !== this.textarea
          || this.textarea.selectionStart !== this.textarea.selectionEnd) {
        this.hideLatexCompletion();
        return;
      }

      const text = this.textarea.value;
      const context = LatexTools.getCompletionContext(text, this.textarea.selectionStart);
      const items = LatexTools.getLatexSuggestions(context);
      if (!context || !items.length) {
        this.hideLatexCompletion();
        return;
      }

      const previousName = this._latexCompletionItems[this._latexCompletionIndex]
        && this._latexCompletionItems[this._latexCompletionIndex].name;
      this._latexCompletionContext = context;
      this._latexCompletionItems = items;
      const previousIndex = items.findIndex((item) => item.name === previousName);
      this._latexCompletionIndex = previousIndex >= 0 ? previousIndex : 0;

      const list = document.getElementById('latexCompletionItems');
      if (!list) { this.hideLatexCompletion(); return; }
      list.textContent = '';
      items.forEach((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = `latexCompletionItem${index}`;
        button.dataset.index = String(index);
        button.className = 'latex-completion-item'
          + (index === this._latexCompletionIndex ? ' is-active' : '');
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', index === this._latexCompletionIndex ? 'true' : 'false');

        const command = document.createElement('span');
        command.className = 'latex-completion-command';
        command.textContent = item.display;
        const preview = document.createElement('span');
        preview.className = 'latex-completion-preview';
        preview.textContent = item.preview || '';
        button.append(command, preview);
        list.appendChild(button);
      });

      popup.hidden = false;
      popup.setAttribute('aria-activedescendant', `latexCompletionItem${this._latexCompletionIndex}`);
      this.positionLatexCompletion();
    }

    hideLatexCompletion() {
      const popup = this._latexCompletionPopup || document.getElementById('latexCompletionPopup');
      if (popup) {
        popup.hidden = true;
        popup.removeAttribute('aria-activedescendant');
      }
      this._latexCompletionContext = null;
      this._latexCompletionItems = [];
      this._latexCompletionIndex = 0;
    }

    positionLatexCompletion() {
      const popup = this._latexCompletionPopup || document.getElementById('latexCompletionPopup');
      const textarea = this.textarea;
      const stack = textarea && textarea.parentElement;
      if (!popup || popup.hidden || !textarea || !stack) return;

      let mirror = this._latexCaretMirror;
      if (!mirror || mirror.parentElement !== stack) {
        mirror = document.createElement('div');
        mirror.className = 'latex-caret-mirror';
        mirror.setAttribute('aria-hidden', 'true');
        stack.appendChild(mirror);
        this._latexCaretMirror = mirror;
      }
      const style = window.getComputedStyle(textarea);
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.fontFamily = style.fontFamily;
      mirror.style.fontSize = style.fontSize;
      mirror.style.fontWeight = style.fontWeight;
      mirror.style.fontStyle = style.fontStyle;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.letterSpacing = style.letterSpacing;
      mirror.style.padding = style.padding;
      mirror.style.tabSize = style.tabSize;
      mirror.style.whiteSpace = style.whiteSpace;
      mirror.style.wordBreak = style.wordBreak;
      mirror.style.overflowWrap = style.overflowWrap;
      mirror.textContent = '';
      mirror.appendChild(document.createTextNode(textarea.value.slice(0, textarea.selectionStart)));
      const marker = document.createElement('span');
      marker.textContent = '\u200b';
      marker.style.display = 'inline-block';
      marker.style.width = '0';
      marker.style.height = '1em';
      marker.style.padding = '0';
      marker.style.margin = '0';
      marker.style.border = '0';
      marker.style.overflow = 'hidden';
      mirror.appendChild(marker);

      const caret = marker.getBoundingClientRect();
      const stackRect = stack.getBoundingClientRect();
      const popupWidth = popup.offsetWidth || 320;
      const popupHeight = popup.offsetHeight || 160;
      let left = caret.left - stackRect.left - textarea.scrollLeft;
      let top = caret.bottom - stackRect.top - textarea.scrollTop + 5;
      if (top + popupHeight > stack.clientHeight) {
        top = caret.top - stackRect.top - textarea.scrollTop - popupHeight - 5;
      }
      left = Math.max(4, Math.min(left, stack.clientWidth - popupWidth - 4));
      top = Math.max(4, Math.min(top, stack.clientHeight - popupHeight - 4));
      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
    }

    acceptLatexCompletion(index) {
      const item = this._latexCompletionItems[index];
      const context = this._latexCompletionContext;
      if (!item || !context || !this.textarea) return false;
      this.hideLatexCompletion();
      const caret = context.start + item.caretOffset;
      this.applyEditorTextEdit(context.start, context.end, item.insert, caret, caret);
      return true;
    }

    applyEditorTextEdit(start, end, insert, selectionStart, selectionEnd) {
      if (!this.textarea) return false;
      const value = this.textarea.value;
      this.textarea.value = value.slice(0, start) + insert + value.slice(end);
      const a = selectionStart === undefined ? start + insert.length : selectionStart;
      const b = selectionEnd === undefined ? a : selectionEnd;
      this.textarea.focus();
      this.textarea.setSelectionRange(a, b);
      this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    handleLatexCompletionKeyDown(e) {
      const popup = this._latexCompletionPopup || document.getElementById('latexCompletionPopup');
      if (!popup || popup.hidden || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const count = this._latexCompletionItems.length;
        if (!count) return true;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        this._latexCompletionIndex = (this._latexCompletionIndex + delta + count) % count;
        const buttons = popup.querySelectorAll('.latex-completion-item');
        buttons.forEach((button, i) => {
          const active = i === this._latexCompletionIndex;
          button.classList.toggle('is-active', active);
          button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        popup.setAttribute('aria-activedescendant', `latexCompletionItem${this._latexCompletionIndex}`);
        return true;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideLatexCompletion();
        return true;
      }
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        this.acceptLatexCompletion(this._latexCompletionIndex);
        return true;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.acceptLatexCompletion(this._latexCompletionIndex);
        return true;
      }
      return false;
    }

    handleLatexPairKeyDown(e) {
      if (!this.textarea || !LatexTools || e.isComposing
          || e.ctrlKey || e.metaKey || e.altKey) return false;
      const value = this.textarea.value;
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const key = e.key;
      const openKeys = ['(', '[', '{'];
      if (!openKeys.includes(key) && ![')', ']', '}', '|', '.', '<'].includes(key)) return false;

      if (start !== end) {
        if (!openKeys.includes(key)) return false;
        const range = LatexTools.getMathRangeAt(value, start);
        const endRange = LatexTools.getMathRangeAt(value, end);
        if (!range || !endRange || range.start !== endRange.start || range.end !== endRange.end
            || LatexTools.isCommentedAt(value, start)) return false;
        const close = { '(': ')', '[': ']', '{': '}' }[key];
        e.preventDefault();
        this.applyEditorTextEdit(start, end, key + value.slice(start, end) + close,
          start + 1, start + 1 + (end - start));
        return true;
      }

      const mathRange = LatexTools.getMathRangeAt(value, start);
      if (!mathRange || LatexTools.isCommentedAt(value, start)) return false;
      const before = value.slice(0, start);

      // `\begin{` offers environments in the completion menu; leave its opening brace
      // unpaired so typing the environment name and `}` can create the matching end.
      if (key === '{') {
        const context = LatexTools.getCompletionContext(value, start);
        if (context && context.type === 'begin-command') {
          e.preventDefault();
          this.applyEditorTextEdit(start, end, '{', start + 1, start + 1);
          return true;
        }
      }

      // Move over a closer that is already present before trying environment
      // completion; otherwise typing through an existing `}` could duplicate it.
      if ([')', ']', '}'].includes(key) && value[start] === key) {
        e.preventDefault();
        this.textarea.setSelectionRange(start + 1, start + 1);
        this.refreshLatexAssist();
        return true;
      }

      // Complete an environment as soon as its closing brace is typed. If an outer
      // matching `\end{...}` already exists later in the source, keep the edit literal.
      if (key === '}') {
        const environment = LatexTools.getEnvironmentAtCloseBrace(value, start);
        if (environment) {
          e.preventDefault();
          if (LatexTools.hasMatchingEnvironmentEnd(value, environment.name, end)) {
            this.applyEditorTextEdit(start, end, '}', start + 1, start + 1);
          } else {
            const insert = `}\n\n\\end{${environment.name}}`;
            this.applyEditorTextEdit(start, end, insert, start + 2, start + 2);
          }
          return true;
        }
      }

      // `\left(` becomes `\left(\right)`; the escaped brace spelling is handled
      // separately because ordinary TeX braces have different source tokens.
      if (key === '{' && /\\left\\$/.test(before)) {
        e.preventDefault();
        this.applyEditorTextEdit(start, end, '{\\right\\}', start + 1, start + 1);
        return true;
      }
      if (['(', '[', '{', '|', '.', '<'].includes(key) && /\\left\s*$/.test(before)) {
        const open = key === '{' ? '\\{' : key;
        const close = { '(': ')', '[': ']', '{': '\\}', '|': '|', '.': '.', '<': '>' }[key];
        const insert = `${open}\\right${close}`;
        e.preventDefault();
        this.applyEditorTextEdit(start, end, insert, start + open.length, start + open.length);
        return true;
      }

      // TeX's set delimiters are escaped (`\{` / `\}`), so pair those as two-character
      // tokens instead of inserting a bare closing brace.
      if (key === '{' && LatexTools.isEscaped(value, start)) {
        e.preventDefault();
        this.applyEditorTextEdit(start, end, '{\\}', start + 1, start + 1);
        return true;
      }

      const close = { '(': ')', '[': ']', '{': '}' }[key];
      if (close) {
        e.preventDefault();
        this.applyEditorTextEdit(start, end, key + close, start + 1, start + 1);
        return true;
      }
      return false;
    }

    // Keydown shortcuts
    handleKeyDown(e) {
      // Ctrl / Cmd shortcuts
      const isCtrl = e.ctrlKey || e.metaKey;

      if (isCtrl) {
        // Ctrl+F is Luogu's documented search key; Ctrl+H adds replace.
        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          this.openFind(false);
          return;
        }
        // Shift must be excluded: Ctrl+Shift+H is Luogu's horizontal-rule key and is
        // handled further down. Without this guard, replace swallowed it.
        if ((e.key === 'h' || e.key === 'H') && !e.shiftKey) {
          e.preventDefault();
          this.openFind(true);
          return;
        }
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          // Fire-and-forget: it is async now (may await a file picker).
          Promise.resolve(this.saveMarkdownFile()).catch(() => {});
          return;
        }
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          this.insertBold();
          return;
        }
        // Must not swallow Mod+Shift+I (insert image) — check the modifier first.
        if ((e.key === 'i' || e.key === 'I') && !e.shiftKey) {
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

        // Luogu's own bindings (handbook article/70w8j2pj). Where this editor
        // already had a different key for the same action, BOTH are kept: muscle
        // memory built here keeps working, and anyone coming from Luogu finds the
        // documented key. Mod+D is strikethrough on Luogu; browsers use it for
        // "bookmark", so preventDefault is required.
        if (e.key === 'd' || e.key === 'D') {
          if (!e.shiftKey) {
            e.preventDefault();
            this.insertStrikethrough();
            return;
          }
        }
        if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          // Luogu: Mod+M = math. Existing binding: Mod+Shift+M = display math.
          if (e.shiftKey) this.insertMathBlock();
          else this.insertMathInline();
          return;
        }
        if (e.shiftKey && (e.key === 'h' || e.key === 'H')) {
          e.preventDefault();
          this.insertHR();
          return;
        }
        if (e.shiftKey && (e.key === 'l' || e.key === 'L')) {
          e.preventDefault();
          this.openModal('linkModal');
          return;
        }
        if (e.shiftKey && (e.key === 'i' || e.key === 'I')) {
          e.preventDefault();
          this.openModal('imageModal');
          return;
        }
        if (e.shiftKey && (e.key === 'q' || e.key === 'Q')) {
          e.preventDefault();
          this.insertQuote();
          return;
        }
        // Mod+Shift+<digit>. `e.key` is unreliable for digits with Shift held —
        // on many layouts Shift+1 reports "!" — so match e.code instead, which is
        // the physical key and stays "Digit1" regardless of modifiers or layout.
        if (e.shiftKey && /^Digit[12789]$/.test(e.code || '')) {
          const action = {
            Digit1: () => this.openModal('codeModal'),
            // initTableBuilder both builds the grid and opens the modal; opening
            // the modal directly would show an unpopulated builder.
            Digit2: () => this.initTableBuilder(3, 4),
            Digit7: () => this.insertUnorderedList(),
            Digit8: () => this.insertOrderedList(),
            Digit9: () => this.insertTaskList(),
          }[e.code];
          if (action) {
            e.preventDefault();
            action();
            return;
          }
        }
        // Promote / demote the current heading, as in Luogu's own editor
        // (Mod+Shift+Up / Mod+Shift+Down). Levels clamp to the 1..6 range that
        // Markdown defines; a plain paragraph becomes an <h1> when promoted.
        if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          this.shiftHeadingLevel(e.key === 'ArrowUp' ? -1 : 1);
          return;
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

      // LaTeX suggestions take priority over normal Tab/Enter behaviour while the
      // popup is open; delimiter pairing runs before list continuation and indentation.
      if (this.handleLatexCompletionKeyDown(e)) return;
      if (this.handleLatexPairKeyDown(e)) return;

      // Enter inside a list continues it automatically.
      //
      // Typing a long list otherwise means re-typing the marker on every line, and
      // renumbering by hand whenever an item is inserted in the middle.
      // `isComposing` guards the IME: while a Chinese/Japanese candidate window is
      // open, Enter commits the candidate and must not be treated as a newline —
      // hijacking it would swallow the confirmation and mangle the text.
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229
          && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        // Only for a plain caret, not a selection replacement.
        if (start === end) {
          const val = this.textarea.value;
          const lineStart = val.lastIndexOf('\n', start - 1) + 1;
          const line = val.slice(lineStart, start);

          //  indent  marker        checkbox        content
          const m = line.match(/^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(?:\[([ xX])\]\s+)?(.*)$/);
          if (m) {
            const [, indent, bullet, num, delim, gap, box, content] = m;

            if (content.trim() === '' && box === undefined) {
              // Enter on an empty item ends the list rather than adding another
              // empty bullet — the usual way out of a list.
              e.preventDefault();
              this.textarea.value = val.slice(0, lineStart) + val.slice(start);
              this.textarea.selectionStart = this.textarea.selectionEnd = lineStart;
              this.pushHistory();
              this.refreshLatexAssist();
              this.render();
              this.updateLineNumbers();
              this.autoSave();
              return;
            }

            // An empty task item is also an exit, but only once the checkbox is gone;
            // strip it first so the second Enter leaves the list.
            let marker;
            if (bullet) {
              marker = bullet + gap;
            } else {
              // Continue the numbering from this item.
              marker = (parseInt(num, 10) + 1) + delim + gap;
            }
            if (box !== undefined) {
              if (content.trim() === '') {
                e.preventDefault();
                const bare = indent + (bullet ? bullet + gap : num + delim + gap);
                this.textarea.value = val.slice(0, lineStart) + bare + val.slice(start);
                const pos = lineStart + bare.length;
                this.textarea.selectionStart = this.textarea.selectionEnd = pos;
                this.pushHistory();
                this.refreshLatexAssist();
                this.render();
                this.updateLineNumbers();
                this.autoSave();
                return;
              }
              // A new task item always starts unchecked.
              marker += '[ ] ';
            }

            e.preventDefault();
            const insert = '\n' + indent + marker;
            this.textarea.value = val.slice(0, start) + insert + val.slice(end);
            const pos = start + insert.length;
            this.textarea.selectionStart = this.textarea.selectionEnd = pos;
            this.pushHistory();
            this.refreshLatexAssist();
            this.render();
            this.updateLineNumbers();
            this.autoSave();
            return;
          }
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
        this.refreshLatexAssist();
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
      // Undo triggered from the find/replace boxes must not steal the caret out of
      // them: the reader is mid-task there and would have to click back for every
      // single undo. Only grab focus when it is not already in the find bar.
      const inFindBar = document.activeElement
        && document.activeElement.closest
        && document.activeElement.closest('#findBar');
      if (!inFindBar) this.textarea.focus();
      this.scrollCaretIntoView();
      this.refreshLatexAssist();
      if (this.workspace) this.workspace.syncActiveContent();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
      // Matches shifted with the text, so the painted boxes are stale.
      if (this.isFindOpen && this.isFindOpen()) this.runFind();
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
      const toggles = this._calloutToggles || (this._calloutToggles = new Map());

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

      // 3. Re-apply states the reader set by hand. Only boxes they actually toggled
      // are overridden, so editing `{open}` in the source still takes effect on the
      // boxes they never touched. Both directions are restored: a `{open}` box the
      // reader collapsed must stay collapsed, not spring back open on every keystroke.
      if (toggles.size) {
        this.previewEl.querySelectorAll('details.luogu-callout').forEach((d) => {
          const key = d.getAttribute('data-src-line');
          if (key === null || !toggles.has(key)) return;
          if (toggles.get(key)) d.setAttribute('open', '');
          else d.removeAttribute('open');
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

      // Re-check the parent at call time, not at capture time: committing a Typora
      // editor runs on blur and can detach nodes while this loop is walking, which
      // made removeChild() throw "node is no longer a child of this node".
      const drop = (n) => {
        if (n && n.parentNode === parent) {
          try { parent.removeChild(n); } catch (err) { /* already detached */ }
        }
      };

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
        // The find highlight layer mirrors the textarea's box; if its padding does
        // not follow, every painted box drifts from the glyph it belongs to.
        const hl = document.getElementById('findHighlights');
        if (hl) hl.style.paddingBottom = `${wantTa}px`;
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
        statsEl.innerText = T('{a} 行 | {b} 字 | {c} 字符 | {d} 公式 | 预估阅读 {e} 分钟', { a: lines, b: words, c: chars, d: formulas, e: readTime });
      }

      // Check with linter.
      //
      // Skipped entirely when the display is off, not merely hidden: lint() runs on
      // every (debounced) render and costs ~50ms on a 400KB document, so paying for
      // a result nobody will see would tax exactly the long solutions where typing
      // latency already hurts most.
      const scoreBadge = document.getElementById('linterScoreBadge');
      if (!this.lintDisplayEnabled) {
        if (scoreBadge) scoreBadge.hidden = true;
        return;
      }
      const lintResult = this.linter.lint(text);
      if (scoreBadge) {
        scoreBadge.hidden = false;
        scoreBadge.innerText = T('排版评分: {a}分', { a: lintResult.score });
        scoreBadge.className = `status-score-badge ${lintResult.score >= 90 ? 'status-score-good' : 'status-score-warn'}`;
      }
    }

    // Web drafts and tabs share the workspace's configurable idle timer.
    autoSave() {
      if (this.workspace && !this.workspace.isDesktop) {
        this.workspace._scheduleWebPersist();
        return;
      }
      // During startup wait until the tab snapshot has been restored.
      if (this._restoringWorkspace) return;
      this._saveDraftNow();
    }

    _saveDraftNow() {
      const content = this.getContent();
      const ok = safeStorage.setItem('luogu_editor_draft', content);
      const saveStatus = document.getElementById('saveStatusIndicator');

      if (!ok) {
        // A failed write is the one case the user MUST know about — otherwise the
        // "已自动保存" label is an outright lie and the draft is lost on refresh.
        if (saveStatus) {
          saveStatus.innerText = T('⚠ 自动保存失败，请手动导出！');
          saveStatus.classList.add('save-failed');
        }
        if (!this._saveFailWarned) {
          this._saveFailWarned = true;
          this.showToast(T('本地自动保存失败（存储空间不足或被浏览器禁用），请使用 Ctrl+S 手动保存文件！'), 'error');
        }
        return;
      }

      this._saveFailWarned = false;
      if (saveStatus) {
        saveStatus.classList.remove('save-failed');
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        saveStatus.innerText = T('已自动保存 ({a})', { a: timeStr });
      }
    }

    // Get & Set content

    setContent(content, pushHistory = true) {
      this.textarea.value = content;
      if (pushHistory) this.pushHistory();
      this.refreshLatexAssist();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    // ---- Find & replace ------------------------------------------------------
    //
    // Operates on the Markdown source in the textarea, not on the rendered preview:
    // that is what the author actually edits, and it keeps "replace" a plain string
    // edit instead of a DOM rewrite that would have to be mapped back to source.

    openFind(withReplace) {
      const bar = document.getElementById('findBar');
      const input = document.getElementById('findInput');
      if (!bar || !input) return;
      bar.hidden = false;
      // Seed the box with the current selection, the way most editors do.
      const sel = this.textarea
        ? this.textarea.value.slice(this.textarea.selectionStart, this.textarea.selectionEnd)
        : '';
      if (sel && !sel.includes('\n')) input.value = sel;
      this.runFind();
      const focusEl = withReplace ? document.getElementById('replaceInput') : input;
      if (focusEl) { focusEl.focus(); focusEl.select(); }
    }

    closeFind() {
      this._disarmReplaceAll();
      const bar = document.getElementById('findBar');
      if (bar) bar.hidden = true;
      this._findMatches = null;
      const layer = document.getElementById('findHighlights');
      if (layer) layer.textContent = '';
      if (this.textarea) {
        this.textarea.focus();
        this.updateBracketHighlight();
      }
    }

    isFindOpen() {
      const bar = document.getElementById('findBar');
      return !!bar && !bar.hidden;
    }

    /** Build the search regex from the query and the option checkboxes, or null. */
    _findRegex() {
      const q = (document.getElementById('findInput') || {}).value || '';
      const err = document.getElementById('findError');
      if (err) err.textContent = '';
      if (!q) return null;

      const useRe = !!(document.getElementById('findRegex') || {}).checked;
      const caseSensitive = !!(document.getElementById('findCase') || {}).checked;
      const wholeWord = !!(document.getElementById('findWord') || {}).checked;

      // A literal query must have every metacharacter escaped, otherwise searching
      // for "$x^2$" would be interpreted as a pattern and match nothing (or throw).
      let body = useRe ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // \b is ASCII-only, so it never fires between CJK characters; spell the
      // boundary out to include the CJK range.
      if (wholeWord) body = '(?<![\\w\\u4e00-\\u9fa5])(?:' + body + ')(?![\\w\\u4e00-\\u9fa5])';

      try {
        return new RegExp(body, caseSensitive ? 'gm' : 'gim');
      } catch (e) {
        if (err) err.textContent = T('正则无效：') + e.message;
        return null;
      }
    }

    /** Recompute all matches and reveal the current one. */
    runFind(keepIndex) {
      if (!this.isFindOpen() || !this.textarea) return;
      // The pending confirmation belongs to the previous query; a new search must
      // not be able to inherit someone else's "yes".
      if (this._replaceAllArmed) this._disarmReplaceAll();
      const re = this._findRegex();
      const countEl = document.getElementById('findCount');
      const text = this.textarea.value;
      const matches = [];

      if (re) {
        let m;
        let guard = 0;
        while ((m = re.exec(text)) !== null) {
          matches.push({ start: m.index, end: m.index + m[0].length });
          // A pattern that can match the empty string (e.g. `a*`) never advances
          // lastIndex by itself and would spin forever.
          if (m[0].length === 0) re.lastIndex++;
          if (++guard > 100000) break;
        }
      }

      this._findMatches = matches;
      if (!keepIndex || this._findIndex == null || this._findIndex >= matches.length) {
        // Start from the first match at or after the caret, so opening the bar
        // continues from where the author is rather than from the top.
        const caret = this.textarea.selectionStart;
        let at = -1;
        for (let i = 0; i < matches.length; i++) {
          if (matches[i].start >= caret) { at = i; break; }
        }
        this._findIndex = matches.length ? (at === -1 ? 0 : at) : -1;
      }
      if (countEl) {
        countEl.textContent = matches.length
          ? (this._findIndex + 1) + '/' + matches.length : '0/0';
      }
      this._paintHighlights();
      if (matches.length) this._revealMatch();
    }

    /**
     * Paint every match behind the textarea, marking the current one.
     *
     * A <textarea> cannot hold markup, so the matches are drawn on a mirror layer
     * with identical metrics sitting underneath. Only the boxes are visible: the
     * mirror's own text is transparent, and the real glyphs come from the textarea
     * on top.
     */
    _paintHighlights() {
      const layer = document.getElementById('findHighlights');
      if (!layer || !this.textarea) return;
      const matches = (this.isFindOpen() && this._findMatches) || [];
      const pair = this._latexBracketPair;
      if (!matches.length && !pair) {
        if (layer.firstChild) layer.textContent = '';
        layer.scrollTop = this.textarea.scrollTop;
        layer.scrollLeft = this.textarea.scrollLeft;
        return;
      }

      const text = this.textarea.value;
      const events = new Map();
      const eventAt = (position) => {
        if (!events.has(position)) events.set(position, { starts: [], ends: [], zeros: [] });
        return events.get(position);
      };
      const addInterval = (start, end, kind, isCurrent) => {
        const a = Math.max(0, Math.min(text.length, start));
        const b = Math.max(a, Math.min(text.length, end));
        if (a === b) {
          if (kind === 'find') eventAt(a).zeros.push({ isCurrent });
          return;
        }
        eventAt(a).starts.push({ kind, isCurrent });
        eventAt(b).ends.push({ kind, isCurrent });
      };

      matches.forEach((match, index) => addInterval(
        match.start, match.end, 'find', index === this._findIndex,
      ));
      if (pair) {
        addInterval(pair.open.start, pair.open.end, 'pair', false);
        addInterval(pair.close.start, pair.close.end, 'pair', false);
      }

      const frag = document.createDocumentFragment();
      let cursor = 0;
      let activeFind = 0;
      let activeCurrent = 0;
      let activePair = 0;
      const appendText = (start, end) => {
        if (end <= start) return;
        const content = text.slice(start, end);
        if (!activeFind && !activePair) {
          frag.appendChild(document.createTextNode(content));
          return;
        }
        const mark = document.createElement('mark');
        const classes = [];
        if (activeCurrent) classes.push('is-current');
        if (activePair) classes.push('latex-match-pair');
        if (classes.length) mark.className = classes.join(' ');
        mark.textContent = content;
        frag.appendChild(mark);
      };
      const positions = [...events.keys()].sort((a, b) => a - b);
      positions.forEach((position) => {
        appendText(cursor, position);
        const event = events.get(position);
        event.ends.forEach(({ kind, isCurrent }) => {
          if (kind === 'find') {
            activeFind = Math.max(0, activeFind - 1);
            if (isCurrent) activeCurrent = Math.max(0, activeCurrent - 1);
          } else if (kind === 'pair') activePair = Math.max(0, activePair - 1);
        });
        event.starts.forEach(({ kind, isCurrent }) => {
          if (kind === 'find') {
            activeFind++;
            if (isCurrent) activeCurrent++;
          } else if (kind === 'pair') activePair++;
        });
        event.zeros.forEach(({ isCurrent }) => {
          const mark = document.createElement('mark');
          const classes = [];
          if (isCurrent) classes.push('is-current');
          if (activePair) classes.push('latex-match-pair');
          if (classes.length) mark.className = classes.join(' ');
          // A zero-width search result would paint nothing; give it a visible anchor.
          mark.textContent = '\u200b';
          frag.appendChild(mark);
        });
        cursor = position;
      });
      appendText(cursor, text.length);
      // Trailing newline keeps the last line's height so the layer scrolls in step.
      frag.appendChild(document.createTextNode('\n'));
      layer.textContent = '';
      layer.appendChild(frag);
      layer.scrollTop = this.textarea.scrollTop;
      layer.scrollLeft = this.textarea.scrollLeft;
    }
    _revealMatch() {
      const m = (this._findMatches || [])[this._findIndex];
      if (!m || !this.textarea) return;
      this.textarea.setSelectionRange(m.start, m.end);
      // Scrolling is manual: setSelectionRange does not move a textarea that is
      // already scrolled somewhere else.
      const line = this.textarea.value.slice(0, m.start).split('\n').length - 1;
      const lineH = parseFloat(getComputedStyle(this.textarea).lineHeight) || 21;
      const target = line * lineH;
      const view = this.textarea.clientHeight;
      if (target < this.textarea.scrollTop
        || target > this.textarea.scrollTop + view - lineH * 2) {
        this.textarea.scrollTop = Math.max(0, target - view / 2);
      }
      this.updateGutterScroll();
    }

    _stepFind(delta) {
      if (!this.isFindOpen()) return;
      const n = (this._findMatches || []).length;
      if (!n) return;
      this._findIndex = ((this._findIndex + delta) % n + n) % n;   // wraps both ways
      const countEl = document.getElementById('findCount');
      if (countEl) countEl.textContent = (this._findIndex + 1) + '/' + n;
      this._paintHighlights();
      this._revealMatch();
    }

    findNext() { this._stepFind(1); }
    findPrev() { this._stepFind(-1); }

    /** Put the "replace all" button back to its resting state. */
    _disarmReplaceAll() {
      clearTimeout(this._replaceAllTimer);
      this._replaceAllArmed = false;
      const btn = document.getElementById('replaceAllBtn');
      if (btn) {
        btn.classList.remove('is-armed');
        btn.textContent = T('全部');
      }
    }

    /** Replacement text, honouring $1..$9 group references in regex mode. */
    _expandReplacement(matchText) {
      const rep = (document.getElementById('replaceInput') || {}).value || '';
      if (!(document.getElementById('findRegex') || {}).checked) return rep;
      const re = this._findRegex();
      if (!re) return rep;
      // Re-run on this match alone so the capture groups belong to it.
      const one = new RegExp(re.source, re.flags.replace('g', ''));
      const m = one.exec(matchText);
      if (!m) return rep;
      return rep.replace(/\$(\d)/g, (s, d) => (m[+d] !== undefined ? m[+d] : s));
    }

    replaceOne() {
      if (!this.isFindOpen() || !this.textarea) return;
      const m = (this._findMatches || [])[this._findIndex];
      if (!m) return;
      const text = this.textarea.value;
      const rep = this._expandReplacement(text.slice(m.start, m.end));
      // setContent(), not textarea.value: it pushes an undo entry (so Ctrl+Z reverts
      // the replacement), re-renders the preview and schedules autosave.
      this.setContent(text.slice(0, m.start) + rep + text.slice(m.end));
      const caret = m.start + rep.length;
      this.textarea.setSelectionRange(caret, caret);
      this._findIndex = null;
      this.runFind();
    }

    /**
     * Replace every match — but never on a single click.
     *
     * "Replace all" rewrites the whole document in one irreversible-looking step, so
     * it asks first and names the count. The confirmation is a second click on the
     * button itself (armed for a few seconds) rather than a modal, so the matches
     * stay visible while deciding; `force` skips it for programmatic callers.
     */
    replaceAll(force) {
      if (!this.isFindOpen() || !this.textarea) return;
      const matches = this._findMatches || [];
      if (!matches.length) return;

      const btn = document.getElementById('replaceAllBtn');
      if (!force && !this._replaceAllArmed) {
        this._replaceAllArmed = true;
        if (btn) {
          btn.classList.add('is-armed');
          btn.textContent = T('确认替换 {a} 处？', { a: matches.length });
        }
        if (this.showToast) {
          this.showToast(T('将替换 {a} 处，请再点一次确认', { a: matches.length }), 'info');
        }
        clearTimeout(this._replaceAllTimer);
        this._replaceAllTimer = setTimeout(() => this._disarmReplaceAll(), 4000);
        return;
      }
      this._disarmReplaceAll();

      const text = this.textarea.value;
      // Walk backwards so each splice leaves the earlier offsets valid.
      let out = text;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        out = out.slice(0, m.start)
          + this._expandReplacement(text.slice(m.start, m.end))
          + out.slice(m.end);
      }
      const n = matches.length;
      this.setContent(out);
      this._findIndex = null;
      this.runFind();
      if (this.showToast) this.showToast(T('已替换 ') + n + T(' 处'), 'success');
    }

    /**
     * Forget hand-set fold states. Called when the document is replaced wholesale:
     * line N in the new text is a different box, or none at all. In-place edits
     * (rename, type switch) deliberately do NOT reset, so the box you are editing
     * keeps the open/closed state you put it in.
     */
    resetCalloutToggles() {
      if (this._calloutToggles) this._calloutToggles.clear();
    }

    /** Sync the lint UI to the stored preference without announcing it. */
    applyLintDisplay() {
      const mark = document.getElementById('lintToggleMark');
      if (mark) mark.textContent = this.lintDisplayEnabled ? '✅' : '⬜';
      const badge = document.getElementById('linterScoreBadge');
      if (badge) badge.hidden = !this.lintDisplayEnabled;
    }

    /**
     * Show or hide the typography lint readout.
     *
     * The switch lives in the settings menu rather than on the badge itself: hiding
     * a control from the control you just hid would leave no way back.
     */
    toggleLintDisplay(force) {
      this.lintDisplayEnabled = (force === undefined) ? !this.lintDisplayEnabled : !!force;
      safeStorage.setItem('luogu_editor_lint_display', this.lintDisplayEnabled ? '1' : '0');

      const item = document.getElementById('lintDisplayToggle');
      if (item) item.checked = this.lintDisplayEnabled;

      const badge = document.getElementById('linterScoreBadge');
      if (badge) badge.hidden = !this.lintDisplayEnabled;

      // Turning it off while the report is open would leave a panel on screen that
      // the setting says should not exist.
      if (!this.lintDisplayEnabled) this.closeModal('linterModal');
      // Turning it back on needs a fresh score: the document moved on while the
      // linter was not running.
      if (this.lintDisplayEnabled) this.updateStats(this.getContent());

      if (this.showToast) {
        this.showToast(T('排版问题显示已{a}', { a: this.lintDisplayEnabled ? T('开启') : T('关闭') }), 'info');
      }
      return this.lintDisplayEnabled;
    }

    // Theme switcher
    setTheme(theme) {
      if (theme === 'luogu') theme = 'light';
      this.currentTheme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      safeStorage.setItem('luogu_editor_theme', theme);
      
      const select = document.getElementById('settingsThemeSelect');
      if (select) select.value = theme === 'dark' ? 'dark' : 'light';

      const themeLabel = document.getElementById('currentThemeLabel');
      if (themeLabel) {
        const labels = {
          light: T('亮色'),
          dark: T('暗色')
        };
        themeLabel.innerText = labels[theme] || theme;
      }
    }

    // View Mode Switcher
    setViewMode(mode, restore) {
      // Leaving Typora mode must flush any block still open for editing, otherwise
      // the in-progress text is discarded when the pane is hidden.
      if (this.currentMode === 'typora' && mode !== 'typora' && this.typora) {
        this.typora.disable();
      }

      this.currentMode = mode;
      // 记下这次选择：下次打开还在这个模式。恢复时不重复写盘，也没必要弹提示。
      if (!restore) safeStorage.setItem('luogu_editor_view_mode', mode);
      const workspace = document.getElementById('mainWorkspace');
      if (!workspace) return;

      workspace.classList.remove('mode-split', 'mode-editor-only', 'mode-preview-only', 'mode-typora');
      workspace.classList.add(`mode-${mode}`);

      if (mode === 'typora' && this.typora) this.typora.enable();
      // 只剩一栏时把拖动留下的内联宽度清掉，让这一栏铺满（CSS 里也有 !important 兜底）。
      if (typeof this.applySplitFlex === 'function') this.applySplitFlex(mode);

      // Update button active states
      document.querySelectorAll('.view-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
      });
    }

    // Inserting is an editing action even when the last tab has been closed.
    // Create a real draft first, so preview, undo, autosave and Save share one document.
    _ensureInsertionDocument() {
      if (!this.workspace || this.workspace.docs.length) return;
      this.workspace.newTab();
      this.undoStack = [];
      this.redoStack = [];
      this.pushHistory(); // an insertion can be undone back to the empty draft
    }

    // Text Insertion Helpers
    wrapSelection(prefix, suffix, defaultText = '') {
      this._ensureInsertionDocument();
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
      if (this.workspace) this.workspace.syncActiveContent();
      this.autoSave();
    }

    insertAtCursor(text) {
      this._ensureInsertionDocument();
      const start = this.textarea.selectionStart;
      const end = this.textarea.selectionEnd;
      const val = this.textarea.value;

      this.textarea.value = val.substring(0, start) + text + val.substring(end);
      this.textarea.focus();
      this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;

      this.pushHistory();
      this.render();
      this.updateLineNumbers();
      if (this.workspace) this.workspace.syncActiveContent();
      this.autoSave();
    }

    // Quick Formatting Actions
    insertBold() { this.wrapSelection('**', '**', T('加粗文本')); }
    insertItalic() { this.wrapSelection('*', '*', T('斜体文本')); }
    insertStrikethrough() { this.wrapSelection('~~', '~~', T('删除线文本')); }
    insertInlineCode() { this.wrapSelection('`', '`', 'code'); }
    insertQuote() { this.wrapSelection('\n> ', '\n', T('引用内容')); }
    insertHR() { this.insertAtCursor('\n\n---\n\n'); }
    insertMathInline() { this.wrapSelection('$', '$', 'x'); }
    insertMathBlock() { this.insertAtCursor('\n\n$$\n\\sum_{i=1}^n a_i = S_n\n$$\n\n'); }

    insertHeading(level) {
      const prefix = '#'.repeat(level) + ' ';
      this.wrapSelection(`\n${prefix}`, '\n', T('标题 {a}', { a: level }));
    }

    // Raise (delta < 0) or lower (delta > 0) the heading level of the line the caret
    // is on. A non-heading line becomes an <h1> when promoted; an <h6> demoted past
    // level 6 loses its markers and reverts to a paragraph. Levels never wrap.
    shiftHeadingLevel(delta) {
      const val = this.textarea.value;
      const caret = this.textarea.selectionStart;
      const lineStart = val.lastIndexOf('\n', caret - 1) + 1;
      let lineEnd = val.indexOf('\n', caret);
      if (lineEnd === -1) lineEnd = val.length;
      const line = val.slice(lineStart, lineEnd);

      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const current = m ? m[1].length : 0;
      const text = m ? m[2] : line.trim();
      // Nothing to demote on an empty line, and no heading to strip below level 1.
      if (!text) return;

      // Promoting a plain paragraph (level 0) makes it an <h1>; without this it
      // would clamp straight back to 0 and the shortcut would appear dead.
      let next;
      if (current === 0) {
        next = delta < 0 ? 1 : 0;
      } else {
        next = current + delta;
        if (next < 0) next = 0;
        if (next > 6) next = 6;
      }
      if (next === current) return;

      const replacement = next === 0 ? text : '#'.repeat(next) + ' ' + text;
      this.textarea.value = val.slice(0, lineStart) + replacement + val.slice(lineEnd);
      // Keep the caret at the same offset within the text, not the raw line, so it
      // does not drift as the '#' markers change length.
      const delta2 = replacement.length - line.length;
      const pos = Math.max(lineStart, caret + delta2);
      this.textarea.selectionStart = this.textarea.selectionEnd = pos;

      this.pushHistory();
      this.render();
      this.updateLineNumbers();
      this.autoSave();
    }

    insertTaskList() {
      this.insertAtCursor(T('\n- [ ] 未完成任务项\n- [x] 已完成任务项\n'));
    }

    insertUnorderedList() {
      this.insertAtCursor(T('\n- 列表项一\n- 列表项二\n- 列表项三\n'));
    }

    insertOrderedList() {
      this.insertAtCursor(T('\n1. 列表项一\n2. 列表项二\n3. 列表项三\n'));
    }

    // Insert Luogu Containers
    insertCallout(type, title, isOpen) {
      const openParam = isOpen ? '{open}' : '';
      const titleParam = title ? `[${title}]` : '';
      this.insertAtCursor(T('\n\n::::{a}{b}{c}\n这里是{d}折叠框的内容。\n::::\n\n', { a: type, b: titleParam, c: openParam, d: type }));
    }

    insertEpigraph(author, content) {
      const authorParam = author ? `[——${author}]` : '';
      this.insertAtCursor(T('\n\n:::epigraph{a}\n{b}\n:::\n\n', { a: authorParam, b: content || T('千里之行，始于足下。') }));
    }

    insertAlign(mode) {
      this.insertAtCursor(T('\n\n:::align{{mode}}\n这里是{a}排版的内容\n:::\n\n', { mode, a: mode === 'center' ? T('居中') : T('居右') }));
    }

    // ---- Paging markers ------------------------------------------------------
    //
    // These are leaf directives on a line of their own. They must not be glued to
    // the surrounding text, so each insert is padded with blank lines.

    insertPagination() {
      this.insertAtCursor('\n\n:::Pagination\n\n');
    }

    insertPageHeader() {
      this.insertAtCursor(T('\n\n:::Header[页眉文字]\n\n'));
    }

    insertPageFooter() {
      // Seeded with the page counters, since that is the main reason to want a
      // footer and the placeholders are not otherwise discoverable.
      this.insertAtCursor(T('\n\n:::Footer[第 {page} 页 / 共 {pages} 页]\n\n'));
    }

    insertBilibili(id) {
      if (!id) return;
      this.insertAtCursor(`\n\n![](bilibili:${id})\n\n`);
    }

    insertTemplate(key) {
      if (typeof LuoguTemplates !== 'undefined' && LuoguTemplates[key]) {
        if (confirm(T('应用模板将覆盖当前编辑区内容，是否继续？'))) {
          this._ensureInsertionDocument();
          this.resetCalloutToggles();
          this.setContent(LuoguTemplates[key]);
          if (this.workspace) this.workspace.syncActiveContent();
          this.showToast(T('模板应用成功！'), 'success');
        }
      }
    }

    // Auto fix spacing using Luogu Linter
    autoFixSpacing() {
      const current = this.textarea.value;
      const formatted = this.linter.formatSpacing(current);
      if (current !== formatted) {
        this.setContent(formatted);
        this.showToast(T('已自动完成中英文与公式空格排版规范修复！'), 'success');
      } else {
        this.showToast(T('排版格式已完全符合规范，无需调整！'), 'info');
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
        if (copyText) copyText.innerText = T('已复制!');
        setTimeout(() => {
          if (copyText) copyText.innerText = T('复制');
        }, 1800);
      }).catch(err => {
        this.showToast(T('复制失败: ') + err.message, 'error');
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
      this.showToast(T('已插入数学公式！'), 'success');
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
            <h4 style="color: var(--luogu-green); margin-bottom: 8px;">${T('太棒了！排版完全符合洛谷规范')}</h4>
            <p style="color: var(--text-secondary); font-size: 13px;">${T('未检测到中英文缺少空格、裸露公式符号或代码块未指定语言等问题，可放心在洛谷发布！')}</p>
          </div>
        `;
        return;
      }

      let html = `
        <div style="margin-bottom: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
          <strong>${T('排版综合健康度评分：')}</strong>
          <span style="font-size: 18px; font-weight: bold; color: ${result.score >= 90 ? 'var(--luogu-green)' : 'var(--luogu-orange)'};">${T('{score} / 100 分', { score: result.score })}</span>
          <p style="font-size: 12px; color: var(--text-secondary); margin-top: 4px;">${T('共发现 {n} 处建议改进项：', { n: result.issues.length })}</p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 8px;">
      `;

      result.issues.forEach(issue => {
        const badgeColors = {
          error: 'background:#fdedec; color:#c0392b;',
          warning: 'background:#fef5e7; color:#d35400;',
          info: 'background:#ebf5fb; color:#2980b9;'
        };
        const typeLabels = { error: T('错误'), warning: T('警告'), info: T('建议') };

        html += `
          <div style="padding: 10px 12px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary);">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
              <span style="font-weight: 600; font-size: 13px;">${escapeHtml(issue.title)}</span>
              <div>
                <span style="font-size: 10px; padding: 1px 6px; border-radius: 3px; ${badgeColors[issue.type] || ''}">${typeLabels[issue.type] || issue.type}</span>
                <span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">${T('第 {line} 行', { line: issue.line })}</span>
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
            text: r === 0 ? T('标题 {n}', { n: c + 1 }) : T('数据 {r},{c}', { r, c: c + 1 })
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
                  <button type="button" class="btn-mini" onclick="LuoguEditor.updateTableCell(${r}, ${c}, '^')" title="${T('向上合并 (^) {x}', { x: r > 0 ? '' : T('(不可用)') })}">^</button>
                  <button type="button" class="btn-mini" onclick="LuoguEditor.updateTableCell(${r}, ${c}, '<')" title="${T('向左合并 (<) {x}', { x: c > 0 ? '' : T('(不可用)') })}">&lt;</button>
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
        newRow.push({ text: T('数据 {a},{b}', { a: r, b: c + 1 }) });
      }
      this.tableGridData.push(newRow);
      this.renderTableBuilderGrid();
    }

    addTableCol() {
      const c = this.tableGridData[0] ? this.tableGridData[0].length : 0;
      for (let r = 0; r < this.tableGridData.length; r++) {
        this.tableGridData[r].push({
          text: r === 0 ? T('标题 {n}', { n: c + 1 }) : T('数据 {r},{c}', { r, c: c + 1 })
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
      this.showToast(T('表格已成功生成并插入！'), 'success');
    }

    // File Operations
    newDocument() {
      // 桌面版：新建就是开一个标签页。不需要确认——开标签页不会覆盖东西，弹一句
      // "确定要新建文档吗"只会让人误以为要丢内容。
      if (this.workspace) return this.workspace.newTab();

      if (confirm(T('确定要新建文档吗？未保存的内容可在历史记录中恢复。'))) {
        this.docName = T('未命名_洛谷文章.md');
        this._fileHandle = null;
        if (this.docNameInput) this.docNameInput.value = this.docName;
        this.resetCalloutToggles();
        this.setContent(T('# 未命名标题\n\n在此开始编写洛谷 Markdown 内容……\n'));
        this.showToast(T('已新建文档！'), 'info');
      }
    }

    openLocalFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        this.docName = file.name;
        if (this.docNameInput) this.docNameInput.value = this.docName;
        this.resetCalloutToggles();
        this.setContent(text);
        // 让面板知道这份文档存在。拖进窗口、系统"打开方式"、浏览器里选文件都走这里，
        // 全都不经过 openPath()——不通知的话，右侧渲染着内容，左侧却写着"没有打开的文件"。
        if (this.workspace) {
          this.workspace.adoptExternal({ name: file.name, content: text, path: file.path || null });
        }
        this.showToast(T('已成功打开文件: {a}', { a: file.name }), 'success');
      };
      reader.readAsText(file);
    }

    async triggerFileOpen() {
      // 桌面版：交给面板的原生对话框。打开的文件会成为真正的标签页（带路径、能写回），
      // 而不是一份"打开完就找不到出处"的内容。
      if (this.workspace) return this.workspace.openFileDialog();

      // Prefer the File System Access API: it hands back a handle, which is what
      // lets Ctrl+S later overwrite the same file instead of re-downloading a copy.
      if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
        try {
          const [handle] = await window.showOpenFilePicker({
            types: [{
              description: T('Markdown / 文本文档'),
              accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] },
            }],
            multiple: false,
          });
          if (handle) {
            const file = await handle.getFile();
            this._fileHandle = handle;
            this.openLocalFile(file);
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;   // user cancelled
          // Otherwise fall back to the classic input below.
        }
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.txt';
      input.onchange = (e) => {
        if (e.target.files && e.target.files.length > 0) {
          // No handle from this path: Ctrl+S will offer Save As.
          this._fileHandle = null;
          this.openLocalFile(e.target.files[0]);
        }
      };
      input.click();
    }

    /**
     * Ctrl+S. Writes straight back to the file that was opened, like a desktop
     * editor; only asks where to put it when there is no such file.
     *
     * A handle only exists when the document came in through the File System Access
     * API, so `triggerFileOpen` prefers that API and falls back to <input type=file>
     * (which yields no writable handle) on browsers that lack it.
     */
    async saveMarkdownFile() {
      // With the workspace open, saving belongs to the active tab: it knows which
      // file this document came from, which the single-document path does not.
      if (this.workspace) return this.workspace.saveActive();

      const content = this.getContent();
      const fileName = this.docName.endsWith('.md') || this.docName.endsWith('.markdown')
        || this.docName.endsWith('.txt')
        ? this.docName : `${this.docName}.md`;

      // 1. Known file → overwrite it in place, no dialog.
      if (this._fileHandle) {
        try {
          const perm = this._fileHandle.queryPermission
            ? await this._fileHandle.queryPermission({ mode: 'readwrite' })
            : 'granted';
          let ok = perm === 'granted';
          if (!ok && this._fileHandle.requestPermission) {
            ok = (await this._fileHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
          }
          if (ok) {
            const writable = await this._fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
            this.markSaved();
            this.showToast(T('已保存到「{a}」', { a: this.docName }), 'success');
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return;
          // Permission lost or file moved: fall through to Save As.
        }
      }

      // 2. No file yet → native Save As, and remember the handle for next time.
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: T('Markdown 文档'), accept: { 'text/markdown': ['.md', '.markdown'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(content);
          await writable.close();
          this._fileHandle = handle;
          this.docName = handle.name || fileName;
          if (this.docNameInput) this.docNameInput.value = this.docName;
          this.markSaved();
          this.showToast(T('已保存到「{a}」', { a: this.docName }), 'success');
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;   // user cancelled
        }
      }

      // 3. Browsers without the API (Firefox / Safari): ordinary download.
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.markSaved();
      this.showToast(T('文档已成功保存到本地！'), 'success');
    }

    /** Note that the buffer matches what is on disk. */
    markSaved() {
      this._savedContent = this.getContent();
    }

    // One-click copy for Luogu
    copyLuoguMarkdown() {
      const content = this.getContent();
      navigator.clipboard.writeText(content).then(() => {
        this.showToast(T('已复制洛谷标准 Markdown 源码，可直接粘贴到洛谷发布！'), 'success');
      }).catch(err => {
        this.showToast(T('复制失败: ') + err.message, 'error');
      });
    }

    // Export Standalone HTML (Ultra Polish & High Aesthetics)
    async exportStandaloneHTML() {
      const markdown = this.getContent();
      let renderedHtml = this.parser.render(markdown);
      
      // Make all task checkboxes disabled in exported HTML
      renderedHtml = renderedHtml.replace(/<input type="checkbox" class="luogu-task-checkbox"([^>]*)>/g, '<input type="checkbox" class="luogu-task-checkbox" disabled$1>');

      // Carry the paging markers into the exported file: the reader may well print
      // it, and the running heads should survive that. Done on a detached container
      // so the live preview is untouched.
      let pageCss = '';
      {
        const holder = document.createElement('div');
        holder.innerHTML = renderedHtml;
        const secs = this._pageSections(holder);
        if (secs.length > 1 || secs[0].header || secs[0].footer) {
          pageCss = this._pageCss(secs, 'luogu-exp-p');
          holder.querySelectorAll(':scope > [data-page-break]').forEach((n) => n.remove());
          secs.forEach((sec, i) => {
            const wrap = document.createElement('section');
            wrap.className = 'luogu-page-section';
            wrap.style.page = `luogu-exp-p${i}`;
            if (i > 0) wrap.style.breakBefore = 'page';
            sec.nodes.forEach((n) => wrap.appendChild(n));
            holder.appendChild(wrap);
          });
          renderedHtml = holder.innerHTML;
        }
      }

      const title = this.docName.replace(/\.md$/i, '');
      const words = (markdown.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+/g) || []).length;
      const formulas = (markdown.match(/\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$/g) || []).length;
      const readTime = Math.max(1, Math.ceil(words / 300));
      const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
      const previewFontSize = (() => {
        const preview = this.previewEl || document.getElementById('previewContent');
        const computed = preview && typeof getComputedStyle === 'function'
          ? Number.parseFloat(getComputedStyle(preview).fontSize)
          : Number.NaN;
        return Number.isFinite(computed) && computed > 0 ? computed : this.previewFontSize || 16;
      })();

      // Inline the SAME KaTeX (0.18.4) CSS + fonts the editor uses, so the exported
      // document renders math identically to the preview and also works offline.
      // (The old CDN CSS was 0.16.11 and used different class names, e.g. .sizing
      // vs the 0.18.4 .katex-sizing — which broke \Huge sizing and the \ne glyph.)
      // Collect CSS from BOTH inline <style> blocks and linked stylesheets. The
      // standalone build inlines everything, but the hosted (multi-file) site serves
      // styles.css via <link>; scanning only <style> there produced an export with no
      // KaTeX fonts and no Prism colours at all.
      // Rule-level, not sheet-level: the hosted site keeps KaTeX/Prism rules in the
      // same styles.css as the app shell, and copying whole sheets dragged in
      // `html, body { overflow: hidden; height: 100% }` — which left the exported
      // article unscrollable.
      const allCss = collectDocumentCss();
      const katexCss = await inlineCssFonts(
        pickRules(allCss, (sel, text) => /@font-face/i.test(text)
          ? /font-family:\s*KaTeX_/i.test(text)
          : /(?:^|[\s,>+~(])\.katex/i.test(sel)),
      );

      // Harvest the inlined Prism theme the same way. Previously the export linked
      // the jsDelivr CDN stylesheet, so an "offline export" silently lost all code
      // highlighting without a network connection.
      const prismCss = pickRules(allCss, (sel) => /\.token\b/.test(sel)
        || /\.line-numbers/.test(sel)
        || /(?:^|[\s,>+~(])(?:pre|code)\[class\*=/.test(sel));

      const fullHtml = `<!DOCTYPE html>
<html lang="${global.LuoguI18n && LuoguI18n.current() === 'en' ? 'en' : 'zh-CN'}" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%233498db'/%3E%3Cstop offset='100%25' stop-color='%231d6fa5'/%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpath d='M7 11h3l3 7 3-7h3v10h-2.5v-6.5l-2.7 6.5h-1.6L9.5 14.5V21H7V11zm15 0h2v10h-2v-3.5h-2.5v-2H22V11z' fill='%23ffffff'/%3E%3C/svg%3E">
  <style>${katexCss}</style>
  <style>${prismCss}</style>
  <style>
    /* Paging markers are editing aids in the app; in the exported file they only
       matter when the reader prints it. */
    .luogu-page-break, .luogu-page-meta { display: none; }
    @media print { .luogu-page-section > *:last-child { margin-bottom: 0; } }
    ${pageCss}
  </style>
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
      /* Preserve the reader's selected preview size. KaTeX sizes itself in em, so
         a fixed body size would make exported formulas drift from the live preview. */
      font-size: ${previewFontSize}px;
      line-height: 1.8;
      color: var(--text);
      background-color: var(--bg);
      padding: 40px 16px 80px;
      transition: background-color 0.2s, color 0.2s;
    }
    /* Table of contents, pinned beside the article like Luogu's article view.
       Built at load time from the headings actually present, so it can never drift
       from the document. Hidden entirely when there is nothing worth listing. */
    .article-toc {
      position: fixed;
      top: 40px;
      left: max(16px, calc(50% - 440px - 250px));
      width: 220px;
      max-height: calc(100vh - 80px);
      overflow-y: auto;
      padding: 14px 6px 14px 0;
      font-size: 13px;
      line-height: 1.5;
      z-index: 20;
    }
    .article-toc[hidden] { display: none; }
    .toc-title {
      font-weight: 600;
      color: var(--text-muted);
      padding: 0 10px 8px;
      letter-spacing: .05em;
    }
    .toc-list { list-style: none; margin: 0; padding: 0; }
    .toc-list a {
      display: block;
      padding: 4px 10px;
      color: var(--text-muted);
      text-decoration: none;
      border-left: 2px solid transparent;
      border-radius: 0 4px 4px 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color .15s, background-color .15s, border-color .15s;
    }
    .toc-list a::before {
      content: '—';
      opacity: .45;
      margin-right: 6px;
    }
    .toc-list a:hover {
      color: var(--primary);
      background: rgba(52, 152, 219, .08);
    }
    .toc-list a.is-active {
      color: var(--primary);
      border-left-color: var(--primary);
      background: rgba(52, 152, 219, .10);
      font-weight: 600;
    }
    .toc-lv2 a { padding-left: 22px; }
    .toc-lv3 a { padding-left: 34px; }
    .toc-lv4 a { padding-left: 46px; }
    .toc-lv5 a { padding-left: 58px; }
    .toc-lv6 a { padding-left: 70px; }
    .toc-fab {
      display: none;
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 30;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: var(--card-bg);
      color: var(--text);
      font-size: 18px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,.15);
    }
    /* Not enough room for a side rail: fold the TOC into a toggled panel. */
    @media (max-width: 1400px) {
      .article-toc {
        left: 16px;
        top: auto;
        bottom: 72px;
        max-height: 60vh;
        background: var(--card-bg);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,.18);
      }
      .article-toc:not(.is-open) { display: none; }
      .toc-fab.has-toc { display: block; }
    }

    /* Media must never exceed the article column. The preview pane gets this from
       .luogu-img in styles.css, but the export only harvests KaTeX and Prism rules,
       so a high-resolution image used to render at its full intrinsic pixel width
       and push the whole page sideways. */
    .article-content img,
    .article-content video,
    .article-content canvas,
    .article-content svg:not(.katex svg) {
      max-width: 100%;
      height: auto;
    }
    .article-content .luogu-img-wrapper {
      display: inline-block;
      max-width: 100%;
    }
    /* Wide blocks scroll inside themselves instead of widening the page. */
    .article-content .luogu-table-wrapper,
    .article-content .katex-display {
      max-width: 100%;
      overflow-x: auto;
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
      font-family: "Cascadia Code", "Fira Code", "Consolas", "Courier New", monospace;
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
      font-family: "Cascadia Code", "Fira Code", "Consolas", "Courier New", monospace;
      font-size: 0.8125em;
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
    .luogu-table { width: 100%; border-collapse: collapse; font-size: 1em; border: 1px solid var(--border); }
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
    .luogu-callout-summary { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-weight: 600; font-size: 0.8125em; cursor: pointer; list-style: none; user-select: none; }
    .luogu-callout-summary::-webkit-details-marker { display: none; }
    .luogu-callout-icon { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex-shrink: 0; }
    .callout-icon-svg { width: 18px; height: 18px; display: block; }
    .luogu-callout-title { flex: 1; font-weight: 600; }
    .luogu-callout-arrow { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; transition: transform 0.2s ease; }
    .arrow-svg { width: 14px; height: 14px; display: block; }
    .luogu-callout[open] > .luogu-callout-summary .luogu-callout-arrow { transform: rotate(180deg); }
    .luogu-callout-content { padding: 14px 18px; border-top: 1px solid var(--border); font-size: 1em; }
    .luogu-callout-info { border-left: 4px solid #3498db; }
    .luogu-callout-info > .luogu-callout-summary { background: #ebf5fb; color: #1f618d; }
    .luogu-callout-success { border-left: 4px solid #2ecc71; }
    .luogu-callout-success > .luogu-callout-summary { background: #eafaf1; color: #196f3d; }
    .luogu-callout-warning { border-left: 4px solid #e67e22; }
    .luogu-callout-warning > .luogu-callout-summary { background: #fef5e7; color: #b9770e; }
    .luogu-callout-error { border-left: 4px solid #e74c3c; }
    .luogu-callout-error > .luogu-callout-summary { background: #fdedec; color: #943126; }
    /* Dark theme callouts (导出主题切换时折叠框也要随之变色) */
    [data-theme="dark"] .luogu-callout { border-color: #334155; }
    [data-theme="dark"] .luogu-callout-info { border-left-color: #3498db; }
    [data-theme="dark"] .luogu-callout-info > .luogu-callout-summary { background: #12303f; color: #9ed6f5; }
    [data-theme="dark"] .luogu-callout-success { border-left-color: #2ecc71; }
    [data-theme="dark"] .luogu-callout-success > .luogu-callout-summary { background: #12321e; color: #a6e6c0; }
    [data-theme="dark"] .luogu-callout-warning { border-left-color: #e67e22; }
    [data-theme="dark"] .luogu-callout-warning > .luogu-callout-summary { background: #39280f; color: #f6cf8d; }
    [data-theme="dark"] .luogu-callout-error { border-left-color: #e74c3c; }
    [data-theme="dark"] .luogu-callout-error > .luogu-callout-summary { background: #3a1d1d; color: #f2ada7; }
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
    .luogu-epigraph-body { font-style: italic; font-size: 1em; margin-bottom: 6px; }
    .luogu-epigraph-author { text-align: right; font-size: 0.86em; color: var(--text-muted); }
    .luogu-align-center { text-align: center; margin: 1.2em 0; }
    .luogu-align-right { text-align: right; margin: 1.2em 0; }
    /* KaTeX sizing uses the inlined 0.18.4 stylesheet (class .katex-sizing.reset-size6.sizeN);
       only keep the display/base font tweaks for the exported theme. */
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
      .article-toc, .toc-fab { display: none !important; }
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
  <button class="toc-fab" id="tocFab" onclick="toggleToc()" aria-label="${T('目录')}" title="${T('目录')}">☰</button>
  <nav class="article-toc" id="articleToc" aria-label="${T('目录')}" hidden>
    <div class="toc-title">${T('目录')}</div>
    <ul class="toc-list" id="tocList"></ul>
  </nav>
  <div class="article-container">
    <div class="article-header">
      <div class="article-meta">
        <div class="meta-badges">
          <span class="badge">${T('洛谷')} Markdown</span>
          <span>📅 ${nowStr}</span>
          <span>${T('📖 {words} 字（约 {min} 分钟）', { words, min: readTime })}</span>
          <span>${T('📐 {n} 个公式', { n: formulas })}</span>
        </div>
        <div class="action-bar">
          <button class="action-btn" onclick="toggleTheme()" title="${T('切换亮暗主题')}">🌓 ${T('主题')}</button>
          <button class="action-btn" onclick="copyFullContent()" title="${T('复制全文 Markdown')}">📋 ${T('复制')}</button>
        </div>
      </div>
    </div>

    <main class="article-content" id="articleBody">
      ${renderedHtml}
    </main>
  </div>

  <textarea id="rawMarkdownSource" style="display:none;" readonly>${escapeHtml(markdown)}</textarea>
  <div id="toastTip" class="toast-tip">${T('已复制 Markdown 源码！')}</div>

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

    function toggleToc() {
      var toc = document.getElementById('articleToc');
      if (toc) toc.classList.toggle('is-open');
    }

    // Build the table of contents from the headings that are actually in the
    // document, then keep the current one marked while the reader scrolls.
    (function buildToc() {
      var body = document.getElementById('articleBody');
      var toc = document.getElementById('articleToc');
      var list = document.getElementById('tocList');
      if (!body || !toc || !list) return;

      var heads = [].slice.call(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter(function (h) { return (h.textContent || '').trim(); });
      // One heading (or none) is not a table of contents worth showing.
      if (heads.length < 2) return;

      var used = {};
      var links = [];
      heads.forEach(function (h, i) {
        // Headings already carry ids, but guarantee uniqueness and a fallback so
        // every entry is clickable even for duplicate or empty-slug titles.
        var id = h.id;
        if (!id || used[id]) { id = 'toc-h-' + i; h.id = id; }
        used[id] = true;

        var text = (h.textContent || '').trim();
        var li = document.createElement('li');
        li.className = 'toc-lv' + h.tagName.charAt(1);
        var a = document.createElement('a');
        a.href = '#' + id;
        a.textContent = text;
        a.title = text;
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          // Honour the click even when the target sits in the unscrollable last
          // screenful, where geometry alone cannot tell these sections apart.
          pinned = id;
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.replaceState(null, '', '#' + id);
          if (window.matchMedia('(max-width: 1400px)').matches) toc.classList.remove('is-open');
          setActive(a);
        });
        li.appendChild(a);
        list.appendChild(li);
        links.push({ el: h, link: a });
      });

      toc.hidden = false;
      var fab = document.getElementById('tocFab');
      if (fab) fab.classList.add('has-toc');

      var active = null;
      var pinned = null;

      function setActive(link) {
        if (active === link) return;
        if (active) active.classList.remove('is-active');
        link.classList.add('is-active');
        active = link;
        if (toc.scrollHeight > toc.clientHeight) {
          var lr = link.getBoundingClientRect();
          var tr = toc.getBoundingClientRect();
          if (lr.top < tr.top || lr.bottom > tr.bottom) link.scrollIntoView({ block: 'nearest' });
        }
      }

      function mark() {
        // The current section is the last heading whose top is above the reading
        // line.
        var line = 120;
        var cur = links[0];
        for (var i = 0; i < links.length; i++) {
          if (links[i].el.getBoundingClientRect().top <= line) cur = links[i];
        }

        // The final screenful cannot scroll any further, so every heading inside it
        // would otherwise stay unreachable (they never cross the reading line) and
        // the last entry would swallow them all. Within that dead zone, pick by how
        // far through it we are, so those sections still light up in turn.
        var maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        if (maxScroll > 0 && window.scrollY >= maxScroll - 1) {
          var tail = links.filter(function (l) {
            return l.el.getBoundingClientRect().top > line;
          });
          if (tail.length) cur = tail[0];
        }
        if (pinned) {
          var keep = null;
          for (var j = 0; j < links.length; j++) {
            if (links[j].el.id === pinned) { keep = links[j]; break; }
          }
          // Release the pin once the reader scrolls somewhere the geometry can
          // resolve on its own.
          if (keep && keep !== cur && !settled) { setActive(keep.link); return; }
          pinned = null;
        }
        setActive(cur.link);
      }

      var ticking = false;
      var settled = false;
      var settleTimer = null;
      function onScroll() {
        // Any scroll that is still arriving right after a click is the smooth
        // scroll itself; only a later, quiet scroll counts as the reader moving on.
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(function () { settled = false; }, 400);
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { ticking = false; mark(); });
      }
      window.addEventListener('wheel', function () { settled = true; }, { passive: true });
      window.addEventListener('touchmove', function () { settled = true; }, { passive: true });
      window.addEventListener('keydown', function (ev) {
        if (/^(Arrow|Page|Home|End| )/.test(ev.key)) settled = true;
      });
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
      mark();
    })();

    window.copyCodeBlock = function(btn) {
      var wrapper = btn.closest('.luogu-code-block-wrapper');
      if (!wrapper) return;
      var codeLines = Array.from(wrapper.querySelectorAll('.code-line-text')).map(function(el) { return el.innerText; });
      var text = codeLines.length > 0 ? codeLines.join('\\n') : (wrapper.querySelector('pre code') ? wrapper.querySelector('pre code').innerText : '');
      navigator.clipboard.writeText(text).then(function() {
        var span = btn.querySelector('.copy-text') || btn;
        var oldText = span.innerText;
        span.innerText = T('✓ 已复制');
        btn.style.borderColor = '#2ecc71';
        btn.style.color = '#2ecc71';
        setTimeout(function() {
          span.innerText = oldText;
          btn.style.borderColor = '';
          btn.style.color = '';
        }, 1800);
      }).catch(function() {
        showToast(T('复制失败，请手动选择复制'));
      });
    };
    window.LuoguEditor = window.LuoguEditor || {};
    window.LuoguEditor.copyCode = window.copyCodeBlock;

    function copyFullContent() {
      var rawEl = document.getElementById('rawMarkdownSource');
      if (!rawEl) return;
      var md = rawEl.value || rawEl.textContent;
      navigator.clipboard.writeText(md).then(function() {
        showToast(T('已复制 Markdown 源码！'));
      }).catch(function() {
        showToast(T('复制失败，请手动复制'));
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
            types: [{ description: T('HTML 文档'), accept: { 'text/html': ['.html'] } }],
          });
          const writable = await handle.createWritable();
          await writable.write(fullHtml);
          await writable.close();
          this.showToast(T('已导出高颜值独立 HTML 文档！'), 'success');
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
      this.showToast(T('已导出高颜值独立 HTML 文档！'), 'success');
    }

    // ---- Pagination ----------------------------------------------------------
    //
    // `:::Pagination` splits the article into sections; `:::Header[..]` /
    // `:::Footer[..]` at the top of a section set its running head and foot.
    //
    // For paged output this is expressed with CSS named pages. Chromium does support
    // `@page <name> { @top-center { content: ... } }`, and crucially the margin boxes
    // then repeat on EVERY page a section spans — which a `position: fixed` element
    // or a repeating <thead> cannot do per-section. Verified against Chromium's
    // print-to-PDF before choosing this route.

    /** Split the rendered blocks into sections at every page-break marker. */
    _pageSections(root) {
      const kids = Array.from(root.children);
      const sections = [];
      let cur = { nodes: [], header: '', footer: '' };
      for (const el of kids) {
        if (el.hasAttribute && el.hasAttribute('data-page-break')) {
          sections.push(cur);
          cur = { nodes: [], header: '', footer: '' };
          continue;
        }
        if (el.hasAttribute && el.hasAttribute('data-page-header')) {
          cur.header = el.getAttribute('data-page-header') || '';
          cur.nodes.push(el);
          continue;
        }
        if (el.hasAttribute && el.hasAttribute('data-page-footer')) {
          cur.footer = el.getAttribute('data-page-footer') || '';
          cur.nodes.push(el);
          continue;
        }
        cur.nodes.push(el);
      }
      sections.push(cur);
      // A document with no markers at all is a single section with no running heads;
      // callers use that to skip the whole mechanism.
      return sections;
    }

    /** Escape a string for use inside a CSS `content: "..."` declaration. */
    _cssString(text) {
      return '"' + String(text)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, ' ') + '"';
    }

    /**
     * Build the `@page` rules for a set of sections.
     *
     * `counter(page)` is available inside margin boxes, so a footer may use `{page}`
     * and `{pages}` placeholders to number the output.
     */
    _pageCss(sections, prefix) {
      const out = [];
      sections.forEach((sec, i) => {
        if (!sec.header && !sec.footer) return;
        const boxes = [];
        if (sec.header) {
          boxes.push(`@top-center { content: ${this._cssString(sec.header)};`
            + ' font-size: 10pt; color: #666; }');
        }
        if (sec.footer) {
          // {page} / {pages} become live counters rather than literal text.
          const f = sec.footer;
          const parts = f.split(/(\{page\}|\{pages\})/).filter((x) => x !== '');
          const content = parts.map((x) => (x === '{page}' ? 'counter(page)'
            : x === '{pages}' ? 'counter(pages)' : this._cssString(x))).join(' ');
          boxes.push(`@bottom-center { content: ${content};`
            + ' font-size: 10pt; color: #666; }');
        }
        out.push(`@page ${prefix}${i} { ${boxes.join(' ')} }`);
      });
      return out.join('\n');
    }

    /**
     * Wrap each section in its own element bound to a named page, so the browser
     * breaks between them and applies the right running heads. Returns an undo
     * function; pass a detached container to transform a copy instead.
     */
    _applyPagination(root, prefix) {
      const sections = this._pageSections(root);
      if (sections.length <= 1 && !sections[0].header && !sections[0].footer) {
        return { count: 1, css: '', undo: () => {} };
      }

      const marker = document.createComment('pagination');
      const parent = root;
      const wrappers = [];
      // Remember the original order so the DOM can be put back exactly.
      const original = Array.from(parent.childNodes);

      sections.forEach((sec, i) => {
        const wrap = document.createElement('section');
        wrap.className = 'luogu-page-section';
        wrap.setAttribute('data-page-section', String(i));
        // `page:` binds this subtree to the matching @page rule.
        wrap.style.page = `${prefix}${i}`;
        if (i > 0) wrap.style.breakBefore = 'page';
        sec.nodes.forEach((n) => wrap.appendChild(n));
        parent.appendChild(wrap);
        wrappers.push(wrap);
      });
      // Page-break markers themselves are not content; drop them from the paged view.
      parent.querySelectorAll(':scope > [data-page-break]').forEach((n) => n.remove());

      const css = this._pageCss(sections, prefix);
      const styleEl = document.createElement('style');
      styleEl.setAttribute('data-pagination', '1');
      styleEl.textContent = css;
      if (css) document.head.appendChild(styleEl);

      return {
        count: sections.length,
        sections,
        wrappers,
        css,
        undo: () => {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          // Restore the exact original child list, including the break markers.
          wrappers.forEach((w) => { while (w.firstChild) parent.insertBefore(w.firstChild, w); });
          wrappers.forEach((w) => { if (w.parentNode) w.parentNode.removeChild(w); });
          original.forEach((n) => parent.appendChild(n));
          if (marker.parentNode) marker.parentNode.removeChild(marker);
        },
      };
    }

    /** True when the document uses any paging marker at all. */
    hasPagination() {
      if (!this.previewEl) return false;
      return !!this.previewEl.querySelector(
        '[data-page-break],[data-page-header],[data-page-footer]');
    }

    // ---- Export as a single long PNG -----------------------------------------
    //
    // Uses SnapDOM (vendored, MIT, zero-dependency) rather than html2canvas: it
    // reproduces KaTeX formulas and Prism colouring faithfully because it captures
    // the real computed styles instead of re-implementing a renderer, and it inlines
    // fonts itself so the capture works offline from a file:// page.
    //
    // A browser canvas cannot exceed 32767px on a side. Past that it does not throw
    // — it silently returns a truncated image — so the scale is reduced to fit and
    // the user is told when that happens.
    async exportImage() {
      const el = this.previewEl;
      const snap = (typeof window !== 'undefined') && window.snapdom;
      if (!el) return;
      if (!snap) {
        this.showToast(T('图片导出组件未加载，请刷新后重试'), 'error');
        return;
      }
      if (!this.getContent().trim()) {
        this.showToast(T('文档为空，没有可导出的内容'), 'info');
        return;
      }

      const undo = this._prepareForCapture(el);
      try {
        const limit = this._canvasLimit();
        const w0 = el.scrollWidth;
        const h0 = el.scrollHeight;

        // Horizontal scale is capped by the width; anything taller is handled by
        // slicing rather than by shrinking, so the text stays at full resolution.
        const scale = Math.min(2, limit / Math.max(1, w0));
        const maxPieceCss = Math.max(1, Math.floor(limit / scale));

        const pieces = this._imagePieces(el, h0, maxPieceCss);
        this.showToast(pieces.length > 1
          ? T('正在生成 {a} 张图，请稍候……', { a: pieces.length })
          : T('正在生成长图，请稍候……'), 'info');
        await new Promise((r) => setTimeout(r, 50));

        // One capture, many crops: re-capturing per piece would repeat all the
        // style/font inlining work and risk the pieces disagreeing if anything
        // reflowed in between.
        const capture = await snap(el, { backgroundColor: this._captureBg() });
        const meta = capture.meta || { contentX: 0, contentY: 0 };
        const base = (this.docName || T('洛谷题解')).replace(/\.(md|markdown|txt)$/i, '');

        for (let i = 0; i < pieces.length; i++) {
          const pc = pieces[i];
          const blob = await capture.toBlob({
            format: 'png',
            // `dpr: 1` is essential. It defaults to devicePixelRatio, so on a retina
            // screen `scale: 2` would silently render at 4x — twice the pixels this
            // code budgeted for, hitting the canvas ceiling half as far in.
            scale,
            dpr: 1,
            crop: {
              x: meta.contentX || 0,
              y: (meta.contentY || 0) + pc.top,
              width: w0,
              height: pc.height,
            },
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          // A base64 data URL for a multi-megabyte PNG is slow to build and to hand
          // to the download; an object URL is just a handle.
          a.download = pieces.length > 1 ? `${base}-${i + 1}.png` : `${base}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          if (pieces.length > 1) await new Promise((r) => setTimeout(r, 350));
        }

        if (pieces.length > 1) {
          this.showToast(
            `已导出 ${pieces.length} 张图（每张 ${scale.toFixed(2)}x 全分辨率${
              pieces.some((x) => x.forced) ? T('，其中含按长度自动切分的片段') : ''}）`,
            'success');
        } else {
          this.showToast(
            T('长图已导出（{a}×{b}，{c}x）', { a: Math.round(w0 * scale), b: Math.round(h0 * scale), c: scale.toFixed(2) }),
            'success');
        }
      } catch (err) {
        this.showToast(T('长图导出失败：{a}', { a: err && err.message ? err.message : err }), 'error');
      } finally {
        undo();
      }
    }

    /**
     * Largest canvas edge this browser will actually produce.
     *
     * Chrome and Firefox allow 32767px; Safari and iOS stop at 16384 and fail
     * silently past it, so the value is probed rather than assumed.
     */
    _canvasLimit() {
      if (this._canvasLimitCache) return this._canvasLimitCache;
      let found = 8192;
      for (const n of [32767, 16384, 8192]) {
        try {
          const c = document.createElement('canvas');
          c.width = 1; c.height = n;
          const ctx = c.getContext('2d');
          if (!ctx) continue;
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, n - 1, 1, 1);
          const d = ctx.getImageData(0, n - 1, 1, 1).data;
          if (d[3] !== 0) { found = n; break; }
        } catch (e) { /* try the next size down */ }
      }
      this._canvasLimitCache = found;
      return found;
    }

    /**
     * Where to cut the picture.
     *
     * Author-placed `:::Pagination` markers win, because those cuts are meaningful.
     * Any resulting piece still taller than one canvas is then sliced mechanically,
     * which keeps the text at full resolution instead of shrinking the whole
     * document to fit — the failure mode this replaces.
     */
    _imagePieces(el, totalCss, maxPieceCss) {
      const sections = this._pageSections(el);
      const bounds = [];

      if (sections.length > 1) {
        const top0 = el.getBoundingClientRect().top - el.scrollTop;
        sections.forEach((sec) => {
          const nodes = sec.nodes.filter((n) => n.getBoundingClientRect);
          if (!nodes.length) return;
          const first = nodes[0].getBoundingClientRect();
          const last = nodes[nodes.length - 1].getBoundingClientRect();
          bounds.push({ top: Math.max(0, first.top - top0), height: Math.max(1, last.bottom - first.top) });
        });
      }
      if (!bounds.length) bounds.push({ top: 0, height: totalCss });

      // Candidate cut lines: the bottom edge of every top-level block. Slicing on one
      // of these avoids guillotining a line of text through the middle, which a fixed
      // step would do (verified: a plain step cut "行号 0038" in half).
      const top0 = el.getBoundingClientRect().top - el.scrollTop;
      const edges = Array.from(el.children)
        .filter((c) => c.getBoundingClientRect && c.offsetParent !== null)
        .map((c) => c.getBoundingClientRect().bottom - top0)
        .filter((y) => y > 0)
        .sort((a, b2) => a - b2);

      const out = [];
      for (const b of bounds) {
        if (b.height <= maxPieceCss) { out.push({ ...b, forced: false }); continue; }
        let y = b.top;
        const end = b.top + b.height;
        while (y < end - 0.5) {
          const hardStop = Math.min(y + maxPieceCss, end);
          // Highest block edge that still fits in this piece.
          let cut = 0;
          for (const e of edges) { if (e > y + 1 && e <= hardStop) cut = e; else if (e > hardStop) break; }
          // No block boundary fits (one enormous block): fall back to a flat cut.
          if (!cut) cut = hardStop;
          out.push({ top: y, height: cut - y, forced: true });
          y = cut;
        }
      }

      // Snapping to block edges can leave a sliver at the end (a 28px strip of
      // nothing). Fold anything that small back into the piece before it.
      const MIN_PIECE = 40;
      for (let i = out.length - 1; i > 0; i--) {
        if (out[i].height < MIN_PIECE) {
          out[i - 1].height += out[i].height;
          out.splice(i, 1);
        }
      }
      return out;
    }

    /** Background colour for the capture, so dark theme does not come out transparent. */
    _captureBg() {
      try {
        const c = window.getComputedStyle(this.previewEl).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(c)) return c;
      } catch (e) { /* fall through */ }
      return (document.documentElement.getAttribute('data-theme') === 'dark')
        ? '#1e1e1e' : '#ffffff';
    }

    /**
     * Put the preview into a state worth photographing, and return a function that
     * restores it exactly.
     *
     * Three things have to change, each of which silently ruins the output:
     *   1. the pane is a scroll container, so only the visible slice would be drawn;
     *   2. its scrollbars would be baked into the picture;
     *   3. collapsed callouts would be captured shut, hiding their content.
     */
    _prepareForCapture(el) {
      const saved = {
        height: el.style.height,
        maxHeight: el.style.maxHeight,
        overflow: el.style.overflow,
        paddingBottom: el.style.paddingBottom,
        scrollTop: el.scrollTop,
      };
      el.style.height = 'auto';
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
      // syncEditorTailPadding() pads the bottom of the pane so the last line can be
      // scrolled up to meet the editor. That padding is invisible on screen but comes
      // out as a tall blank strip under the article in the picture.
      el.style.paddingBottom = '0px';

      const style = document.createElement('style');
      style.textContent =
        '#previewContent::-webkit-scrollbar{display:none!important}'
        + '#previewContent{scrollbar-width:none!important}';
      document.head.appendChild(style);

      // Remember which boxes were shut so they can be shut again afterwards.
      const reclose = [];
      el.querySelectorAll('details').forEach((d) => {
        if (!d.open) { d.open = true; reclose.push(d); }
      });

      return () => {
        reclose.forEach((d) => { d.open = false; });
        if (style.parentNode) style.parentNode.removeChild(style);
        el.style.height = saved.height;
        el.style.maxHeight = saved.maxHeight;
        el.style.overflow = saved.overflow;
        el.style.paddingBottom = saved.paddingBottom;
        el.scrollTop = saved.scrollTop;
      };
    }

    // Print / PDF Export
    printDocument(mode) {
      // Decide whether the PDF is light or dark. Default: follow the editor's current
      // theme, which is what "the PDF should match the theme I exported from" asks
      // for. Previously the print stylesheet hard-forced a light palette with no way
      // to opt out, so the output was identical in both themes.
      const theme = document.documentElement.getAttribute('data-theme') || 'light';
      const noi = mode === 'noi';
      // NOI 风格只多一个页眉页脚和 A4 版式，配色没有理由被钉死成浅色——暗色主题下
      // 导出却拿到白底，正是用户报的那一条。要浅色就显式传 'light'。
      const wantDark = mode === 'light' ? false
        : (mode === 'dark' ? true : theme === 'dark');
      const root = document.documentElement;
      root.classList.remove('print-light', 'print-dark', 'print-noi');
      root.classList.add(wantDark ? 'print-dark' : 'print-light');
      if (noi) root.classList.add('print-noi');
      this._printClassApplied = true;

      // NOI statements always carry a running head and a "第 N 页 共 M 页" foot.
      // Emitted as the generic @page so any `:::Header` / `:::Footer` the author
      // wrote still wins on its own section — those are named pages and override.
      let noiStyle = null;
      if (noi) {
        const title = (this.docName || '').replace(/\.(md|markdown|txt)$/i, '');
        noiStyle = document.createElement('style');
        noiStyle.setAttribute('data-noi-page', '1');
        noiStyle.textContent =
          '@page { size: A4 portrait; margin: 22mm 18mm 20mm 18mm;'
          + (title ? ` @top-center { content: ${this._cssString(title)};`
            + ' font-size: 9pt; font-family: serif; }' : '')
          + T(' @bottom-center { content: "第 " counter(page) " 页 共 " counter(pages) " 页";')
          + ' font-size: 9pt; font-family: serif; } }';
        document.head.appendChild(noiStyle);
      }

      // Temporarily open all details so every browser engine prints them expanded
      const allDetails = document.querySelectorAll('details.luogu-callout');
      const states = [];
      allDetails.forEach(d => {
        states.push(d.hasAttribute('open'));
        d.setAttribute('open', '');
      });

      // `:::Pagination` / `:::Header` / `:::Footer` only mean something on paper, so
      // the sectioning is applied just for the duration of the print and undone
      // immediately afterwards.
      const paging = this.previewEl
        ? this._applyPagination(this.previewEl, 'luogu-print-p')
        : { undo: () => {} };

      window.print();
      paging.undo();
      if (noiStyle && noiStyle.parentNode) noiStyle.parentNode.removeChild(noiStyle);

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
  /**
   * Every stylesheet rule text available in the document, from inline <style> blocks
   * *and* linked stylesheets.
   *
   * The standalone build inlines all CSS, so scanning <style> was enough there — but
   * on the hosted multi-file site styles.css arrives via <link>, and the export
   * silently shipped without KaTeX fonts or Prism colours. Reading cssRules also lets
   * us rewrite relative url(...) references, which would otherwise 404 once the
   * exported file is saved somewhere else.
   */
  function collectDocumentCss() {
    if (typeof document === 'undefined') return [];
    const out = [];
    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch (err) {
        // Cross-origin stylesheet: unreadable by design. Fall back to the <style>
        // element's own text when there is one.
        rules = null;
      }
      if (rules) {
        let text = Array.from(rules).map((r) => r.cssText).join('\n');
        if (sheet.href) text = absolutizeCssUrls(text, sheet.href);
        out.push(text);
      } else if (sheet.ownerNode && sheet.ownerNode.textContent) {
        out.push(sheet.ownerNode.textContent);
      }
    }
    // Inline <style> nodes that never produced a CSSOM entry (e.g. media-disabled).
    for (const node of Array.from(document.querySelectorAll('style'))) {
      const t = node.textContent || '';
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /**
   * Keep only the rules whose selector (or @font-face body) passes `want`.
   *
   * Splitting on rule boundaries rather than filtering whole stylesheets keeps the
   * export free of the editor's layout CSS while still carrying the maths fonts and
   * syntax colours it genuinely needs.
   */
  function pickRules(cssList, want) {
    const kept = [];
    for (const css of cssList) {
      if (!css) continue;
      let depth = 0;
      let start = 0;
      for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const rule = css.slice(start, i + 1).trim();
            const sel = rule.slice(0, rule.indexOf('{')).trim();
            // Preserve at-rules that wrap other rules (@media, @supports) only when
            // something inside them is wanted.
            if (/^@(?:media|supports|layer)/i.test(sel)) {
              const inner = rule.slice(rule.indexOf('{') + 1, -1);
              const sub = pickRules([inner], want);
              if (sub.trim()) kept.push(`${sel} { ${sub} }`);
            } else if (want(sel, rule)) {
              kept.push(rule);
            }
            start = i + 1;
          }
        }
      }
    }
    return kept.join('\n');
  }

  /**
   * Replace every remote url(...) in `css` with a base64 data: URI.
   *
   * On the hosted site KaTeX's @font-face rules point at .woff2 files next to
   * styles.css. Copying those rules verbatim into the export produced a file that
   * looked right on the original machine but lost all maths glyphs once moved or
   * opened offline.
   */
  async function inlineCssFonts(css) {
    if (!css || typeof fetch !== 'function') return css;
    const targets = new Set();
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(css)) !== null) {
      if (!/^(?:data:|blob:|#)/i.test(m[2])) targets.add(m[2]);
    }
    if (!targets.size) return css;

    const map = new Map();
    await Promise.all(Array.from(targets).map(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        // Chunked conversion: a single spread over a multi-hundred-KB font blows
        // the argument limit.
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i) || [, 'woff2'])[1].toLowerCase();
        const mime = ext === 'woff2' ? 'font/woff2'
          : ext === 'woff' ? 'font/woff'
            : ext === 'ttf' ? 'font/ttf' : 'application/octet-stream';
        map.set(url, `data:${mime};base64,${btoa(bin)}`);
      } catch (err) {
        // Unreachable font: keep the original URL rather than breaking the rule.
      }
    }));

    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, q, target) => {
      const hit = map.get(target);
      return hit ? `url("${hit}")` : whole;
    });
  }

  /** Resolve relative url(...) targets in a stylesheet against its own location. */
  function absolutizeCssUrls(css, base) {
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, quote, target) => {
      if (/^(?:data:|https?:|blob:|#)/i.test(target)) return m;
      try {
        return `url("${new URL(target, base).href}")`;
      } catch (err) {
        return m;
      }
    });
  }

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
