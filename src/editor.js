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
  setItem(key, val) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        localStorage.setItem(key, val);
      }
    } catch (e) {}
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
      let debounceTimer = null;
      this.textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.pushHistory();
          this.render();
          this.updateLineNumbers();
          this.autoSave();
        }, 120);
      });

      // Synchronized scrolling
      this.textarea.addEventListener('scroll', () => {
        this.syncScroll('editor');
        if (this.gutterEl) {
          this.gutterEl.scrollTop = this.textarea.scrollTop;
        }
      });

      this.previewEl.addEventListener('scroll', () => {
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
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          this.openLocalFile(file);
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

      let isDragging = false;

      resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const rect = workspace.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const totalWidth = rect.width;
        const minW = 200;
        if (offsetX > minW && (totalWidth - offsetX) > minW) {
          const leftPct = (offsetX / totalWidth) * 100;
          editorPane.style.flex = `0 0 ${leftPct}%`;
          previewPane.style.flex = `0 0 ${100 - leftPct}%`;
        }
      });

      window.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          resizer.classList.remove('resizing');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });
    }

    // Synchronize scrolling between editor and preview
    syncScroll(source) {
      if (this.isSyncScrolling) return;
      this.isSyncScrolling = true;

      if (source === 'editor') {
        const textScroll = this.textarea.scrollTop;
        const textMax = this.textarea.scrollHeight - this.textarea.clientHeight;
        if (textMax > 0) {
          const ratio = textScroll / textMax;
          const previewMax = this.previewEl.scrollHeight - this.previewEl.clientHeight;
          this.previewEl.scrollTop = ratio * previewMax;
        }
      } else if (source === 'preview') {
        const prevScroll = this.previewEl.scrollTop;
        const prevMax = this.previewEl.scrollHeight - this.previewEl.clientHeight;
        if (prevMax > 0) {
          const ratio = prevScroll / prevMax;
          const textMax = this.textarea.scrollHeight - this.textarea.clientHeight;
          this.textarea.scrollTop = ratio * textMax;
          if (this.gutterEl) {
            this.gutterEl.scrollTop = this.textarea.scrollTop;
          }
        }
      }

      setTimeout(() => {
        this.isSyncScrolling = false;
      }, 50);
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
        this.render();
        this.updateLineNumbers();
      }
    }

    // Push state to Undo stack
    pushHistory() {
      const val = this.textarea.value;
      if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== val) {
        this.undoStack.push(val);
        if (this.undoStack.length > this.maxHistory) {
          this.undoStack.shift();
        }
        this.redoStack = [];
      }
    }

    undo() {
      if (this.undoStack.length > 1) {
        const cur = this.undoStack.pop();
        this.redoStack.push(cur);
        const prev = this.undoStack[this.undoStack.length - 1];
        this.textarea.value = prev;
        this.render();
        this.updateLineNumbers();
      }
    }

    redo() {
      if (this.redoStack.length > 0) {
        const next = this.redoStack.pop();
        this.undoStack.push(next);
        this.textarea.value = next;
        this.render();
        this.updateLineNumbers();
      }
    }

    // Render markdown content to preview with preserved callout open states
    render() {
      if (!this.textarea || !this.previewEl) return;

      // 1. Record all currently open callout titles in preview to preserve open state
      const openCalloutKeys = new Set();
      if (this.previewEl) {
        const existingDetails = this.previewEl.querySelectorAll('details.luogu-callout');
        existingDetails.forEach((d, idx) => {
          if (d.hasAttribute('open')) {
            const titleEl = d.querySelector('.luogu-callout-title');
            const title = titleEl ? titleEl.textContent.trim() : `callout-${idx}`;
            openCalloutKeys.add(title);
          }
        });
      }

      // 2. Render new HTML
      const markdown = this.textarea.value;
      const html = this.parser ? this.parser.render(markdown) : '';
      this.previewEl.innerHTML = html;

      // 3. Restore user-opened states to callouts
      if (openCalloutKeys.size > 0) {
        const newDetails = this.previewEl.querySelectorAll('details.luogu-callout');
        newDetails.forEach((d, idx) => {
          const titleEl = d.querySelector('.luogu-callout-title');
          const title = titleEl ? titleEl.textContent.trim() : `callout-${idx}`;
          if (openCalloutKeys.has(title)) {
            d.setAttribute('open', '');
          }
        });
      }

      this.updateStats(markdown);
    }

    // Update Line Numbers Gutter - High performance single-pass
    updateLineNumbers() {
      if (!this.gutterEl || !this.textarea) return;
      const lines = this.textarea.value.split('\n');
      const count = Math.max(lines.length, 1);
      
      let str = '';
      for (let i = 1; i <= count; i++) {
        str += i + '\n';
      }
      this.gutterEl.textContent = str;
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
      const content = this.textarea.value;
      safeStorage.setItem('luogu_editor_draft', content);
      const saveStatus = document.getElementById('saveStatusIndicator');
      if (saveStatus) {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        saveStatus.innerText = `已自动保存 (${timeStr})`;
      }
    }

    // Get & Set content
    getContent() {
      return this.textarea.value;
    }

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
      this.updateStats(this.textarea.value);
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
    initMathCheatsheet() {
      const container = document.getElementById('mathCheatsheetContainer');
      const tabsContainer = document.getElementById('mathTabsContainer');
      if (!container || !tabsContainer || typeof LuoguMathLibrary === 'undefined') return;

      this.mathTabCache = {};

      // Render tabs
      tabsContainer.innerHTML = '';
      LuoguMathLibrary.forEach((category, idx) => {
        const btn = document.createElement('button');
        btn.className = `math-tab-btn ${idx === 0 ? 'active' : ''}`;
        btn.innerText = category.category;
        btn.onclick = () => this.switchMathTab(idx);
        tabsContainer.appendChild(btn);
      });

      this.switchMathTab(0);
    }

    switchMathTab(tabIdx) {
      const container = document.getElementById('mathCheatsheetContainer');
      const tabs = document.querySelectorAll('.math-tab-btn');
      tabs.forEach((t, i) => t.classList.toggle('active', i === tabIdx));

      if (!container || typeof LuoguMathLibrary === 'undefined') return;

      // Use cached tab HTML if available for ultra-fast rendering
      if (this.mathTabCache && this.mathTabCache[tabIdx]) {
        container.innerHTML = this.mathTabCache[tabIdx];
        return;
      }

      const category = LuoguMathLibrary[tabIdx];
      if (!category) return;

      const isMatrixOrComplex = tabIdx === 4 || category.items.some(it => it.isWide);
      let html = `<div class="math-grid ${isMatrixOrComplex ? 'math-grid-wide' : ''}">`;

      category.items.forEach(item => {
        let previewRender = escapeHtml(item.label);
        const katexLib = typeof katex !== 'undefined' ? katex : (window.katex || null);
        if (katexLib) {
          try {
            // Render pure HTML without heavy MathML trees for maximum speed
            const cleanCode = item.code.replace(/^\$\$\n?|\n?\$\$$|^\$|\$$/g, '');
            const isDisplay = cleanCode.includes('\\begin') || cleanCode.includes('\\sum') || cleanCode.includes('\\int') || cleanCode.includes('\\frac') || cleanCode.includes('\\displaystyle');
            const rendered = katexLib.renderToString(cleanCode, {
              throwOnError: false,
              displayMode: isDisplay,
              output: 'html'
            });
            previewRender = rendered;
          } catch (e) {
            previewRender = escapeHtml(item.label);
          }
        }

        const wideClass = item.isWide ? ' card-wide' : '';

        html += `
          <div class="math-item-card${wideClass}" onclick="LuoguEditor.insertMathSymbol('${escapeJsString(item.code)}')">
            <div class="math-item-preview">${previewRender}</div>
            <div class="math-item-label">${escapeHtml(item.label)}</div>
          </div>
        `;
      });
      html += '</div>';

      if (!this.mathTabCache) this.mathTabCache = {};
      this.mathTabCache[tabIdx] = html;
      container.innerHTML = html;
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
      const modal = document.getElementById(modalId);
      if (modal) modal.classList.add('active');
    }

    updateLinterReport() {
      const container = document.getElementById('linterReportBody');
      if (!container) return;

      const markdown = this.textarea.value;
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
      const content = this.textarea.value;
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
      const content = this.textarea.value;
      navigator.clipboard.writeText(content).then(() => {
        this.showToast('已复制洛谷标准 Markdown 源码，可直接粘贴到洛谷发布！', 'success');
      }).catch(err => {
        this.showToast('复制失败: ' + err.message, 'error');
      });
    }

    // Export Standalone HTML (Ultra Polish & High Aesthetics)
    exportStandaloneHTML() {
      const markdown = this.textarea.value;
      let renderedHtml = this.parser.render(markdown);
      
      // Make all task checkboxes disabled in exported HTML
      renderedHtml = renderedHtml.replace(/<input type="checkbox" class="luogu-task-checkbox"([^>]*)>/g, '<input type="checkbox" class="luogu-task-checkbox" disabled$1>');

      const title = this.docName.replace(/\.md$/i, '');
      const words = (markdown.match(/[\u4e00-\u9fa5]|[a-zA-Z0-9_]+/g) || []).length;
      const formulas = (markdown.match(/\$\$[\s\S]*?\$\$|\$[^\$\n]+?\$/g) || []).length;
      const readTime = Math.max(1, Math.ceil(words / 300));
      const nowStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });

      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%233498db'/%3E%3Cstop offset='100%25' stop-color='%231d6fa5'/%3E%3C/defs%3E%3Crect width='32' height='32' rx='8' fill='url(%23g)'/%3E%3Cpath d='M7 11h3l3 7 3-7h3v10h-2.5v-6.5l-2.7 6.5h-1.6L9.5 14.5V21H7V11zm15 0h2v10h-2v-3.5h-2.5v-2H22V11z' fill='%23ffffff'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism-tomorrow.min.css">
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
    /* Tables */
    .luogu-table-wrapper { width: 100%; overflow-x: auto; margin: 1.4em 0; }
    .luogu-table { width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid var(--border); }
    .luogu-table th, .luogu-table td { padding: 9px 14px; border: 1px solid var(--border); }
    .luogu-table th { background: rgba(0, 0, 0, 0.03); font-weight: 600; }
    .luogu-tuack-table { border: 2px solid #3498db; border-radius: 6px; }
    .luogu-tuack-table th { background: #3498db; color: #ffffff; text-align: center; }
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
    /* Bilibili Video */
    .luogu-bilibili-container { margin: 1.5em 0; border-radius: 8px; border: 1px solid var(--border); overflow: hidden; background: #111827; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .luogu-bilibili-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #1f2937; color: #f9fafb; font-size: 12px; }
    .luogu-bilibili-badge { background: #fb7299; color: #ffffff; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
    .luogu-bilibili-link { display: inline-flex; align-items: center; gap: 4px; color: #38bdf8; text-decoration: none; font-size: 12px; }
    .luogu-bilibili-link:hover { text-decoration: underline; }
    .ext-icon { width: 14px; height: 14px; display: inline-block; vertical-align: middle; }
    .luogu-bilibili-player-wrapper { position: relative; width: 100%; padding-top: 56.25%; }
    .luogu-bilibili-player-wrapper iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; }
    /* Epigraph */
    .luogu-epigraph { position: relative; margin: 1.5em 0; padding: 16px 20px 16px 48px; background: rgba(0,0,0,0.02); border-left: 4px solid var(--primary); border-radius: 6px; }
    .luogu-epigraph-quote-mark { position: absolute; top: 6px; left: 14px; font-size: 38px; line-height: 1; font-family: Georgia, serif; color: var(--primary); opacity: 0.5; }
    .luogu-epigraph-body { font-style: italic; font-size: 14px; margin-bottom: 6px; }
    .luogu-epigraph-author { text-align: right; font-size: 12px; color: var(--text-muted); }
    .luogu-align-center { text-align: center; margin: 1.2em 0; }
    .luogu-align-right { text-align: right; margin: 1.2em 0; }
    /* KaTeX Font Sizing & Display Rules for offline export */
    .katex .sizing.size1, .katex .fontsize-ensurer.size1 { font-size: 0.5em !important; }
    .katex .sizing.size2, .katex .fontsize-ensurer.size2 { font-size: 0.6em !important; }
    .katex .sizing.size3, .katex .fontsize-ensurer.size3 { font-size: 0.7em !important; }
    .katex .sizing.size4, .katex .fontsize-ensurer.size4 { font-size: 0.8em !important; }
    .katex .sizing.size5, .katex .fontsize-ensurer.size5 { font-size: 0.9em !important; }
    .katex .sizing.size6, .katex .fontsize-ensurer.size6 { font-size: 1.0em !important; }
    .katex .sizing.size7, .katex .fontsize-ensurer.size7 { font-size: 1.2em !important; }
    .katex .sizing.size8, .katex .fontsize-ensurer.size8 { font-size: 1.44em !important; }
    .katex .sizing.size9, .katex .fontsize-ensurer.size9 { font-size: 1.728em !important; }
    .katex .sizing.size10, .katex .fontsize-ensurer.size10 { font-size: 2.074em !important; }
    .katex .sizing.size11, .katex .fontsize-ensurer.size11 { font-size: 2.488em !important; }
    .katex { font: normal 1.15em KaTeX_Main, Times New Roman, serif; line-height: 1.2; }
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

      const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title}.html`;
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
  // Global helper for task checkbox toggle
  global.toggleTaskCheckbox = function (cb) {
    if (typeof LuoguEditor !== 'undefined' && LuoguEditor.toggleTask) {
      LuoguEditor.toggleTask(cb);
    }
  };

  if (typeof window !== 'undefined') {
    window.copyCodeBlock = global.copyCodeBlock;
    window.toggleTaskCheckbox = global.toggleTaskCheckbox;
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
