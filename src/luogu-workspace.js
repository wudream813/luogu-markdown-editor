/**
 * Workspace: document tabs and a VS Code-style file explorer.
 *
 * This ships inside the one HTML file that both the web build and the desktop app
 * use, but it only switches itself on when a native filesystem is present (i.e.
 * under Tauri). In a browser there is no directory to show and no reliable place to
 * write back to, so the panel stays hidden rather than offering a crippled version
 * of itself.
 *
 * Everything here talks to the host through `fsAdapter`, a tiny interface with one
 * real implementation (Tauri) and one stub used by the tests. Keeping the DOM logic
 * free of Tauri calls is what makes the panel testable without a Rust toolchain.
 *
 * The tree keeps an in-memory picture of the disk (`dirCache`) rather than reading it
 * back on every render. The panel re-renders on every keystroke (the active tab's
 * dirty dot) and on every selection change; a readDir per level per keystroke would
 * make a real project folder unusable. Only mutations — create, rename, delete, move —
 * invalidate, and they invalidate exactly the directories they touched.
 */
(function (global) {
  'use strict';

  // i18n：应用里是真正的翻译函数（src/i18n.js 先于本文件加载）；
  // 单元测试（node 直接 require 本文件）里它退化成"原样返回 + 插值"。
  const T = (global.LuoguI18n && global.LuoguI18n.t) || ((s, v) => (v
    ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(v, k) ? v[k] : m))
    : s));

  const MAX_RECENT = 12;
  // 打字停下来多久之后写盘。太短会在连续输入时反复写，太长又失去"自动"的意义。
  // 2.5 秒是默认值，用户可以在设置里改（见 setAutosaveInterval）；白名单之外的值
  // 一律回落到默认，免得 localStorage 里一个手改的数字把写盘节奏变成 0ms。
  const AUTOSAVE_IDLE_DEFAULT = 2500;
  const AUTOSAVE_IDLE_CHOICES = [500, 1000, 2500, 5000, 10000];
  const AUTOSAVE_INTERVAL_KEY = 'luogu_workspace_autosave_interval';
  const AUTOSAVE_KEY = 'luogu_workspace_autosave';
  const WEB_AUTOSAVE_KEY = 'luogu_workspace_web_autosave';
  const FORMAT_ON_SAVE_KEY = 'luogu_workspace_format_on_save';
  const COLLAPSED_KEY = 'luogu_workspace_collapsed';
  // 网页版没有磁盘可写，标签页只能自己记着——不然刷新一下全丢。
  const WEB_DOCS_KEY = 'luogu_workspace_web_docs';
  const WEB_DOCS_MAX = 2 * 1024 * 1024;   // localStorage 通常 5MB，留一半余量
  const RECENT_KEY = 'luogu_editor_recent_files';
  const WIDTH_KEY = 'luogu_workspace_width';
  const WIDTH_DEFAULT = 240;
  const WIDTH_MIN = 180;
  const WIDTH_MAX = 480;
  const INDENT_PX = 14;
  const RAIL_W = 36;          // 侧栏折叠后留的那条窄轨道
  const DRAG_THRESHOLD = 4;   // 指针移动多少像素才算"在拖"，而不是手抖
  const MAX_DROP = 10;        // 一次拖进来太多文件就先只开这些
  // A filter walks the whole tree, so it needs a ceiling: past a few hundred nodes the
  // walk stops being instant and the result stops being readable anyway.
  const FILTER_MAX_NODES = 400;
  const FILTER_MAX_DEPTH = 8;

  // ---- path helpers --------------------------------------------------------
  // Paths arrive from the host already in the OS's own style, so these all have to
  // cope with both separators. Everything is compared in normalised ('/') form.

  const norm = (p) => String(p).replace(/\\/g, '/');
  const sep = (p) => (p.indexOf('\\') >= 0 && p.indexOf('/') < 0 ? '\\' : '/');
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const joinPath = (dir, name) => dir.replace(/[\\/]+$/, '') + sep(dir) + name;

  /** Parent directory, with the drive/root cases kept intact. */
  function parentOf(p) {
    const s = String(p).replace(/[\\/]+$/, '');
    if (!s) return '/';
    if (/^[A-Za-z]:$/.test(s)) return s + '\\';        // "C:" -> "C:\"
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (i < 0) return s;
    if (i === 0) return s.slice(0, 1);                  // "/proj" -> "/"
    const head = s.slice(0, i);
    if (/^[A-Za-z]:$/.test(head)) return head + '\\';   // "C:\x" -> "C:\"
    return head;
  }

  /** Is `p` inside `dir` (or the same path)? Case-sensitive, like the host paths. */
  function isInside(p, dir) {
    const a = norm(dir).replace(/\/+$/, '');
    const b = norm(p);
    return b === a || b.startsWith(a + '/');
  }

  /**
   * Rewrite a path that lived under `oldPrefix` so it now lives under `newPrefix`.
   * Returns null when the path was not inside the moved subtree.
   */
  function rewritePath(p, oldPrefix, newPrefix) {
    if (!isInside(p, oldPrefix)) return null;
    const rel = norm(p).slice(norm(oldPrefix).replace(/\/+$/, '').length).replace(/^\//, '');
    if (!rel) return newPrefix;
    return joinPath(newPrefix, rel.split('/').join(sep(newPrefix)));
  }

  /** Windows-style path? Drives are case-insensitive there, and only there. */
  function isWinPath(p) {
    return /^[A-Za-z]:/.test(String(p)) || String(p).indexOf('\\') >= 0;
  }

  /** Characters no filesystem in play will accept. */
  const BAD_NAME = /[\\/:*?"<>|]/;

  const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

  /**
   * 已知的二进制类型。命中就"先问一句再打开"——`readTextFile` 读二进制只会得到
   * 一堆替换字符，而保存是把编辑框里的内容原样写回去，等于用乱码覆盖原文件。
   * 列成白名单式的黑名单而非反过来的白名单：真正需要拦的是这一类，而 Makefile、
   * LICENSE、.gitattributes 这类"没扩展名但其实是文本"的文件不该被烦。
   */
  const BINARY_EXTS = new Set([
    // 图片
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'avif', 'heic', 'psd',
    // 音频 / 视频
    'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'mid',
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v',
    // 压缩包 / 镜像
    'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war',
    'deb', 'rpm', 'dmg', 'iso', 'img', 'apk',
    // 可执行文件 / 目标文件 / 库
    'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'a', 'lib', 'class', 'wasm',
    'msi', 'app', 'appimage', 'pyc', 'pyo', 'rlib', 'rmeta', 'pdb',
    // 文档 / 表格 / 演示（都是压缩包，不是纯文本）
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    // 字体 / 数据库
    'ttf', 'otf', 'woff', 'woff2', 'eot',
    'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'pak',
  ]);

  /**
   * 'markdown' | 'text' | 'binary'。
   * 无扩展名的按文本处理：二进制文件几乎没有不带扩展名的。
   */
  function classifyFile(name) {
    const ext = extensionOf(name);
    if (MARKDOWN_EXTS.has(ext)) return 'markdown';
    if (BINARY_EXTS.has(ext)) return 'binary';
    return 'text';
  }

  // ---- icons --------------------------------------------------------------
  // Inline SVG, deliberately: the build is checked for external references, so an
  // icon font or a sprite file is not an option. Stroke-based so one geometry reads
  // well at 16px on both themes; the colour comes from CSS per file kind.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    // <span> of two chevrons — the universal "this is code" mark.
    code: ['M6 5.2 3.6 8 6 10.8', 'M10 5.2 12.4 8 10 10.8'],
    // Sheet of paper with text lines.
    doc: ['M4 2h5l3 3v9H4z', 'M6.4 8.6h3.2M6.4 11h3.2'],
    // Picture frame with a horizon.
    image: ['M2.6 3.4h10.8v9.2H2.6z', 'M2.6 10.4l3-2.8 2.6 2.4 2-1.8 3.2 2.6'],
    // Cardboard box — archives, and PDFs (which are equally "a file you don't edit").
    archive: ['M3.2 2.6h9.6v10.8H3.2z', 'M3.2 5.6h9.6M6.4 7.8h3.2'],
    // Plain file, no distinguishing content.
    file: ['M4 2h5l3 3v9H4z'],
    // Toolbar glyphs.
    refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13.2 2.4V5.2h-2.8'],
    newFile: ['M4 2h5l3 3v9H4z', 'M10.6 10.2h3.6M12.4 8.4v3.6'],
    newDir: ['M1.8 4c0-.6.4-1 1-1h3.3c.3 0 .6.1.8.4l.9 1.1h5.4c.6 0 1 .4 1 1v7.1H1.8z', 'M10.6 10.2h3.6M12.4 8.4v3.6'],
    // 折叠 / 展开侧栏：一对反向的双箭头。
    collapse: ['M9.4 5.2 6.9 8l2.5 2.8', 'M12.4 5.2 9.9 8l2.5 2.8'],
    expand: ['M6.6 5.2 9.1 8l-2.5 2.8', 'M3.6 5.2 6.1 8l-2.5 2.8'],
  };

  // Extension -> icon family and CSS colour slot. Ordered: first match wins.
  const FILE_KINDS = [
    { ext: ['md', 'markdown', 'mdown', 'mkd'], kind: 'md', glyph: 'doc' },
    { ext: ['txt', 'text', 'log', 'rst', 'csv'], kind: 'txt', glyph: 'doc' },
    { ext: ['json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'], kind: 'js', glyph: 'code' },
    { ext: ['html', 'htm', 'vue', 'svelte'], kind: 'html', glyph: 'code' },
    { ext: ['css', 'scss', 'sass', 'less'], kind: 'css', glyph: 'code' },
    { ext: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx'], kind: 'cpp', glyph: 'code' },
    { ext: ['py', 'pyw'], kind: 'py', glyph: 'code' },
    { ext: ['java', 'kt', 'kts'], kind: 'java', glyph: 'code' },
    { ext: ['rs'], kind: 'rust', glyph: 'code' },
    { ext: ['go'], kind: 'go', glyph: 'code' },
    { ext: ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd'], kind: 'shell', glyph: 'code' },
    { ext: ['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env'], kind: 'config', glyph: 'code' },
    { ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'tif', 'tiff'], kind: 'img', glyph: 'image' },
    { ext: ['pdf'], kind: 'pdf', glyph: 'pdf' },
    { ext: ['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar'], kind: 'zip', glyph: 'archive' },
    { ext: ['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'obj', 'class'], kind: 'bin', glyph: 'archive' },
  ];

  function extensionOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  }

  function kindOf(name) {
    const ext = extensionOf(name);
    if (!ext) return { kind: 'plain', glyph: 'file' };
    const hit = FILE_KINDS.find((k) => k.ext.indexOf(ext) >= 0);
    return hit ? { kind: hit.kind, glyph: hit.glyph } : { kind: 'plain', glyph: 'file' };
  }

  /** Build one icon element. `glyph` picks the shape, `slot` lands in data-slot for CSS. */
  function makeIcon(glyph, slot, extraClass) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ws-svg' + (extraClass ? ' ' + extraClass : ''));
    if (slot) svg.setAttribute('data-slot', slot);
    (GLYPHS[glyph] || GLYPHS.file).forEach((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  /** Folders get two shapes so open/closed is legible without reading the chevron. */
  function makeFolderIcon(open) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ws-svg ws-svg-folder');
    svg.setAttribute('data-slot', 'folder');
    const shapes = open
      // Open: the lid is a separate plane, so the body gets a slant.
      ? ['M1.8 4c0-.6.4-1 1-1h3.3c.3 0 .6.1.8.4l.9 1.1h5.4c.6 0 1 .4 1 1v1.1',
         'M1.8 12.4l1.8-5.2h11.1l-1.8 5.2z']
      : ['M1.8 4c0-.6.4-1 1-1h3.3c.3 0 .6.1.8.4l.9 1.1h5.4c.6 0 1 .4 1 1v7.1H1.8z'];
    shapes.forEach((d, i) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      if (open && i === 0) path.setAttribute('class', 'ws-folder-back');
      svg.appendChild(path);
    });
    return svg;
  }

  // ---- host detection ------------------------------------------------------

  /** Detect a host that can actually read and write the user's disk. */
  function detectHost() {
    const t = global.__TAURI__;
    if (!t) return null;
    // Tauri v2 exposes plugins under __TAURI__ when withGlobalTauri is on, but the
    // bundled JS API is the supported path; accept either shape.
    const fs = t.fs || (t.plugins && t.plugins.fs);
    const dialog = t.dialog || (t.plugins && t.plugins.dialog);
    const opener = t.opener || (t.plugins && t.plugins.opener);
    if (!fs || !dialog) return null;
    return {
      readTextFile: (p) => fs.readTextFile(p),
      writeTextFile: (p, c) => fs.writeTextFile(p, c),
      readDir: (p) => fs.readDir(p),
      // Mutating calls are optional: a stub (or an older host) may not have them, and
      // the UI hides the corresponding menu entries rather than failing at click time.
      rename: fs.rename ? (a, b) => fs.rename(a, b) : null,
      mkdir: fs.mkdir ? (p) => fs.mkdir(p) : null,
      remove: fs.remove ? (p, o) => fs.remove(p, o) : null,
      exists: fs.exists ? (p) => fs.exists(p) : null,
      openFile: (opts) => dialog.open(opts),
      // `recursive` matters: the dialog puts exactly what it returns into the
      // filesystem scope, and without this flag the scope would stop at the folder
      // itself — subdirectories would be readable in the tree but not writable.
      openFolder: () => dialog.open({ directory: true, multiple: false, recursive: true }),
      saveAs: (opts) => dialog.save(opts),
      confirm: (msg, opts) => (dialog.confirm
        ? dialog.confirm(msg, opts)
        : Promise.resolve(global.confirm(msg))),
      revealInDir: opener && opener.revealItemInDir
        ? (p) => opener.revealItemInDir(p)
        : null,
    };
  }

  class LuoguWorkspace {
    constructor(editor, fsAdapter) {
      this.editor = editor;
      this.fs = fsAdapter || detectHost();
      this.docs = [];           // { path|null, name, content, dirty }
      this.active = -1;
      this.rootPath = null;
      this.treeState = {};      // path -> expanded?
      this.dirCache = new Map(); // path -> sorted entries (see the file header)
      this.selection = new Set();
      this.focusPath = null;
      this.filter = '';
      this._visible = [];       // last rendered rows, in order (keyboard nav, shift-range)
      this._menu = null;
      this._dragPaths = null;
      this._autosaveTimer = null;
      // 两个开关默认打开：都是"不用操心"的功能，随时可以在设置里关掉。
      this.autosaveToFile = this._readFlag(AUTOSAVE_KEY, true);
      this.webAutosave = this._readFlag(WEB_AUTOSAVE_KEY, true);
      this.autosaveInterval = this._readAutosaveInterval();
      this.formatOnSave = this._readFlag(FORMAT_ON_SAVE_KEY, true);
      // 'desktop' 有原生文件系统（文件树、写回、自动保存）；'web' 只有标签页。
      this.mode = this.fs ? 'desktop' : 'web';
      this.isDesktop = this.mode === 'desktop';
      this.collapsed = this._readFlag(COLLAPSED_KEY, false);
      this._widthBeforeCollapse = null;
      this.press = null;          // 指针拖动树的进行中状态（见 _pressRow）
      this._justDragged = false;  // 拖动刚结束，接下来的 click 不算点击
      this._ghost = null;
      this._webPersistTimer = null;
      this.nativeDrop = false;    // 桌面版是否已接上 OS 原生拖放（见 _bindNativeDrop）
      this.enabled = false;       // mount() 成功之后才为真
    }

    // ---- 偏好 ---------------------------------------------------------------

    _readFlag(key, fallback) {
      try {
        const raw = global.localStorage && global.localStorage.getItem(key);
        return raw === null || raw === undefined ? fallback : raw === '1';
      } catch (e) { return fallback; }
    }

    _writeFlag(key, on) {
      try { global.localStorage && global.localStorage.setItem(key, on ? '1' : '0'); } catch (e) { /* 记不住不影响使用 */ }
    }

    /** 只认下拉框里列出的那几档；其余（被手改过 / 旧版本残留）回落到默认。 */
    _readAutosaveInterval() {
      try {
        const raw = Number(global.localStorage && global.localStorage.getItem(AUTOSAVE_INTERVAL_KEY));
        return AUTOSAVE_IDLE_CHOICES.includes(raw) ? raw : AUTOSAVE_IDLE_DEFAULT;
      } catch (e) { return AUTOSAVE_IDLE_DEFAULT; }
    }

    /**
     * 设置"停下来多久之后写盘"。
     *
     * 改小之后要重新排一次计时器：用户多半是在"刚打完一段、等它保存"的时候来改这个
     * 值的，如果非要等下一次输入才生效，看起来就像没生效。
     */
    setAutosaveInterval(ms) {
      const next = AUTOSAVE_IDLE_CHOICES.includes(Number(ms)) ? Number(ms) : AUTOSAVE_IDLE_DEFAULT;
      this.autosaveInterval = next;
      try { global.localStorage && global.localStorage.setItem(AUTOSAVE_INTERVAL_KEY, String(next)); } catch (e) { /* 记不住不影响使用 */ }
      this._syncSettingsMenu();
      this._toast(T('自动保存间隔：{a} 秒', { a: (next / 1000).toFixed(next % 1000 === 0 ? 0 : 1) }), 'info');
      this._scheduleAutoSave();
      this._scheduleWebPersist();
      return next;
    }

    setWebAutosave(on) {
      this.webAutosave = !!on;
      this._writeFlag(WEB_AUTOSAVE_KEY, this.webAutosave);
      this._syncSettingsMenu();
      this._scheduleWebPersist(); // clears any pending write when disabled
      const status = document.getElementById('saveStatusIndicator');
      if (!this.webAutosave && !this.isDesktop && status) {
        status.textContent = T('已关闭浏览器自动保存');
        status.classList.remove('save-failed');
      }
      this._toast(this.webAutosave ? T('已开启浏览器自动保存') : T('已关闭浏览器自动保存'), 'info');
      return this.webAutosave;
    }

    setAutosaveToFile(on) {
      this.autosaveToFile = !!on;
      this._writeFlag(AUTOSAVE_KEY, this.autosaveToFile);
      this._syncSettingsMenu();
      this._setSaveStatus(this.autosaveToFile ? T('已开启自动保存到文件') : T('已关闭自动保存到文件'));
      this._scheduleAutoSave();
      return this.autosaveToFile;
    }

    setFormatOnSave(on) {
      this.formatOnSave = !!on;
      this._writeFlag(FORMAT_ON_SAVE_KEY, this.formatOnSave);
      this._syncSettingsMenu();
      this._toast(this.formatOnSave ? T('保存时将自动按洛谷规范排版') : T('已关闭保存时自动排版'), 'info');
      return this.formatOnSave;
    }

    /** 把工作区自己的状态画到设置弹窗里的控件上（控件在 index.html，两端按保存目标显示）。 */
    _syncSettingsMenu() {
      const w = document.getElementById('webAutoSaveToggle');
      if (w) w.checked = !!this.webAutosave;
      const a = document.getElementById('autoSaveToggle');
      if (a) a.checked = !!this.autosaveToFile;
      const i = document.getElementById('settingsAutosaveInterval');
      if (i) i.value = String(this.autosaveInterval);
      const f = document.getElementById('formatOnSaveToggle');
      if (f) f.checked = !!this.formatOnSave;
      if (!this.isDesktop && !this.webAutosave) {
        const status = document.getElementById('saveStatusIndicator');
        if (status) status.textContent = T('已关闭浏览器自动保存');
      }
    }

    /** 状态栏那一行：自动保存到底有没有发生，得看得见。 */
    _setSaveStatus(text) {
      const el = document.getElementById('fileSaveStatus');
      if (el) {
        el.textContent = text;
        el.parentElement && (el.parentElement.hidden = !this.isDesktop);
      }
    }

    // ---- lifecycle -----------------------------------------------------------

    mount() {
      this._buildDom();
      this._bindEditor();

      // 网页版：把上次没来得及关掉的标签页放回来。桌面版不需要——文件在磁盘上，
      // 想要哪份自己打开就行，把一堆正文塞进 localStorage 反而是负担。
      const restored = this.isDesktop ? null : this._restoreWebDocs();
      if (restored && restored.length) {
        this.docs = restored;
        this.active = 0;
        const first = this.docs[0];
        this.editor.docName = first.name;
        const nameInput = document.getElementById('docNameInput');
        if (nameInput) nameInput.value = first.name;
        this.editor.setContent(first.content, false);
      } else {
        // Whatever is already in the editor becomes the first tab, so the user never
        // loses the draft they had open when the panel appeared.
        this.docs.push({
          path: null,
          name: this.editor.docName || T('未命名.md'),
          content: this.editor.getContent(),
          dirty: false,
        });
        this.active = 0;
      }

      this.enabled = true;
      this._bindNativeDrop();
      this.render();
      return true;
    }

    // ---- 网页版的标签页记忆 ---------------------------------------------------

    _restoreWebDocs() {
      try {
        const raw = global.localStorage && global.localStorage.getItem(WEB_DOCS_KEY);
        const v = raw ? JSON.parse(raw) : null;
        if (!Array.isArray(v) || !v.length) return null;
        const docs = v
          .filter((d) => d && typeof d.name === 'string' && typeof d.content === 'string')
          .map((d) => ({ path: null, name: d.name, content: d.content, dirty: false }));
        return docs.length ? docs : null;
      } catch (e) { return null; }
    }

    _scheduleWebPersist() {
      clearTimeout(this._webPersistTimer);
      if (this.isDesktop || !this.webAutosave) return;
      this._webPersistTimer = setTimeout(() => this._persistWebDocs(), this.autosaveInterval);
    }

    _persistWebDocs() {
      if (this.isDesktop || !this.webAutosave) return;
      // Keep the legacy current-draft key and the full tab snapshot on the same clock.
      this.editor._saveDraftNow && this.editor._saveDraftNow();
      try {
        const payload = this.docs.map((d) => ({
          name: d.name,
          // 正在编辑的那份以编辑区为准，否则最后敲的几下会丢。
          content: d === this.docs[this.active] ? this.editor.getContent() : d.content,
        }));
        const text = JSON.stringify(payload);
        // 太大就放弃：宁可记不住，也不要在人家打字的时候抛配额异常。
        if (text.length > WEB_DOCS_MAX) return;
        global.localStorage && global.localStorage.setItem(WEB_DOCS_KEY, text);
      } catch (e) { /* 记不住不影响使用 */ }
    }

    _bindEditor() {
      // Track dirtiness from the editor's own input events.
      const ta = document.getElementById('editorTextarea');
      if (!ta) return;
      ta.addEventListener('input', () => {
        const d = this.docs[this.active];
        if (!d) return;
        const now = ta.value;
        if (now !== d.content) {
          d.content = now;
          d.dirty = true;
          this.renderTabs();
          this._markDirtyInTree();
          this._scheduleAutoSave();
          this._scheduleWebPersist();
        }
      });
    }

    /** Repaint just the dirty dots instead of re-walking the whole tree. */
    _markDirtyInTree() {
      const host = document.getElementById('wsTree');
      if (!host) return;
      const dirty = new Set(this.docs.filter((d) => d.dirty && d.path).map((d) => d.path));
      host.querySelectorAll('.ws-node[data-path]').forEach((row) => {
        row.classList.toggle('is-dirty', dirty.has(row.getAttribute('data-path')));
      });
    }

    // ---- 自动保存 -----------------------------------------------------------

    /** 每次输入后重置计时器：写盘发生在"停下来"之后，而不是每敲一个字。 */
    _scheduleAutoSave() {
      clearTimeout(this._autosaveTimer);
      if (!this.isDesktop || !this.autosaveToFile) return;
      this._autosaveTimer = setTimeout(() => this.autosaveNow(), this.autosaveInterval);
    }

    /**
     * 把有路径且已修改的文档写回磁盘。
     *
     * 刻意不在这里做格式化：内容正在被编辑，替换文本会让光标跳走。格式化只发生在
     * 显式保存（Ctrl+S / 关闭时选"保存"）——那里用户本来就预期内容会变。
     * 没有路径的新文档一律跳过：自动保存绝不弹"另存为"对话框。
     */
    async autosaveNow() {
      if (!this.isDesktop || !this.autosaveToFile) return 0;
      const targets = this.docs.filter((d) => d.dirty && d.path);
      if (!targets.length) return 0;
      let saved = 0;
      for (const d of targets) {
        try {
          await this.fs.writeTextFile(d.path, d.content);
        } catch (e) {
          this._setSaveStatus(T('⚠ 自动保存失败：{a}', { a: baseName(d.path) }));
          this._toast(T('自动保存失败（{a}）：{b}', { a: baseName(d.path), b: e && e.message ? e.message : e }), 'error');
          return saved;
        }
        d.dirty = false;
        saved += 1;
      }
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      this._setSaveStatus(T('已自动保存到文件 {a}:{b}:{c}', { a: hh, b: mm, c: ss }));
      this.renderTabs();
      this._markDirtyInTree();
      return saved;
    }

    // ---- 外部打开的文档 ------------------------------------------------------

    /**
     * 编辑器从工作区之外拿到了一份文档：把文件拖进窗口、用系统的"打开方式"拉起、
     * 或者浏览器里选了文件。
     *
     * 这些路径都不经过 openPath()，面板原本一无所知——于是会出现"右边有预览、
     * 左边写着没有打开的文件"这种自相矛盾的画面。这里把它补成一个标签页。
     * 不调用 setContent：内容已经在编辑区里了，再灌一次会把光标顶回开头。
     */
    adoptExternal({ name, content, path }) {
      if (!this.enabled) return;
      const cur = this.docs[this.active];
      // 空白未命名页直接顶替掉，否则每拖一个文件就多留一个空标签。
      if (cur && !cur.path && !cur.dirty && !cur.content) {
        cur.name = name || cur.name;
        cur.content = content || '';
        cur.path = path || null;
        cur.dirty = false;
      } else if (path) {
        const existing = this.indexOfPath(path);
        if (existing >= 0) { this.activate(existing); return; }
        this.docs.push({ name, content: content || '', path, dirty: false });
        this.active = this.docs.length - 1;
      } else {
        this.docs.push({ name, content: content || '', path: null, dirty: false });
        this.active = this.docs.length - 1;
      }
      const d = this.docs[this.active];
      this.editor.docName = d.name;
      const nameInput = document.getElementById('docNameInput');
      if (nameInput) nameInput.value = d.name;
      if (path) this._pushRecent(path);
      this.render();
    }

    // ---- document model ------------------------------------------------------

    indexOfPath(path) {
      return this.docs.findIndex((d) => d.path && path && d.path === path);
    }

    async openPath(path, opts) {
      const existing = this.indexOfPath(path);
      if (existing >= 0) { this.activate(existing); return; }

      const name = baseName(path);
      const kind = classifyFile(name);
      if (kind === 'binary' && !(opts && opts.force)) {
        const ok = await this.fs.confirm(
          T('「{a}」看起来不是文本文件。\\n\\n', { a: name })
            + T('按文本打开只会看到乱码，而且一旦保存，这些乱码会覆盖原文件。\n\n仍要打开吗？'),
          { kind: 'warning', title: T('不是文本文件'), okLabel: T('仍要打开'), cancelLabel: T('取消') },
        );
        if (!ok) return;
        this._toast(T('已按文本打开「{a}」，请不要保存：写回会损坏原文件', { a: name }), 'error');
      } else if (kind === 'text') {
        this._hintNotMarkdown(name);
      }

      let content = '';
      try {
        content = await this.fs.readTextFile(path);
      } catch (e) {
        this._toast(T('打不开 {a}：{b}', { a: baseName(path), b: e && e.message ? e.message : e }), 'error');
        return;
      }
      this.docs.push({ path, name: baseName(path), content, dirty: false });
      this.activate(this.docs.length - 1);
      this._pushRecent(path);
    }

    /**
     * 提醒"这不是 Markdown 文档"。每种扩展名只提示一次——每开一个 .cpp 都弹同一句话，
     * 提示就从帮助变成了噪音。
     */
    _hintNotMarkdown(name) {
      this._hintedExts = this._hintedExts || new Set();
      const ext = extensionOf(name) || T('(无扩展名)');
      if (this._hintedExts.has(ext)) return;
      this._hintedExts.add(ext);
      this._toast(T('「{a}」不是 Markdown 文档：预览会按 Markdown 规则渲染，保存时原样写回', { a: name }), 'info');
    }

    activate(i) {
      if (i < 0 || i >= this.docs.length) return;
      // Stash the live text before switching away, or edits made since the last
      // keystroke event would be lost.
      const cur = this.docs[this.active];
      if (cur) cur.content = this.editor.getContent();

      this.active = i;
      const d = this.docs[i];
      this.editor.docName = d.name;
      const nameInput = document.getElementById('docNameInput');
      if (nameInput) nameInput.value = d.name;
      // setContent pushes history; loading a different document should not be
      // undoable into the previous one.
      this.editor.resetCalloutToggles && this.editor.resetCalloutToggles();
      this.editor.setContent(d.content, false);
      // Bring the file into view — opening it from the recent list while its folder
      // is collapsed otherwise leaves the tree looking like nothing happened.
      if (d.path) this._revealTarget = d.path;
      this.render();
    }

    /**
     * "还有未保存的改动"三选一：保存 / 不保存 / 取消。
     *
     * 宿主自带的 confirm 只有两个按钮，于是用户被迫在"丢掉改动"和"关不掉"之间选，
     * 偏偏少了最常用的那个——先存再关。所以这个对话框自己画。
     */
    _askUnsaved(name) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active ws-ask';
        overlay.innerHTML = `
          <div class="modal-dialog ws-ask-dialog" role="dialog" aria-modal="true" aria-labelledby="wsAskTitle">
            <h3 class="ws-ask-title" id="wsAskTitle"></h3>
            <p class="ws-ask-body"></p>
            <div class="ws-ask-buttons">
              <button type="button" class="ws-ask-btn is-primary" data-act="save" data-i18n="保存">保存</button>
              <button type="button" class="ws-ask-btn is-danger" data-act="discard" data-i18n="不保存">不保存</button>
              <button type="button" class="ws-ask-btn" data-act="cancel" data-i18n="取消">取消</button>
            </div>
          </div>`;
        // 这个对话框是临时拼出来的，语言切换的 applyDom 扫不到它 —— 只有它开着的
        // 那一刻才在 DOM 里。所以插进来之后立刻自己翻译一次；同时标上 data-i18n，
        // 万一切换语言时它正开着，applyDom 也能改到。
        if (global.LuoguI18n) global.LuoguI18n.applyDom(overlay);
        // 文件名来自磁盘，用 textContent 写入，不做字符串拼接。
        overlay.querySelector('.ws-ask-title').textContent = T('是否保存更改？');
        overlay.querySelector('.ws-ask-body').textContent =
          T('「{a}」有未保存的改动。不保存的话，这些改动会丢失。', { a: name });

        let settled = false;
        const done = (choice) => {
          if (settled) return;
          settled = true;
          document.removeEventListener('keydown', onKey, true);
          overlay.remove();
          resolve(choice);
        };
        const onKey = (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done('save'); }
        };
        overlay.querySelectorAll('.ws-ask-btn').forEach((btn) => {
          btn.onclick = () => done(btn.getAttribute('data-act'));
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        const primary = overlay.querySelector('.ws-ask-btn.is-primary');
        if (primary) primary.focus();
      });
    }

    async closeTab(i) {
      const d = this.docs[i];
      if (!d) return;
      if (d.dirty) {
        const choice = await this._askUnsaved(d.name);
        if (choice === 'cancel') return;
        if (choice === 'save') {
          const ok = await this.saveIndex(i);
          // 保存失败、或用户在"另存为"里点了取消：那就别关，别把改动带走。
          if (!ok) return;
          if (this.docs.indexOf(d) !== i) i = this.docs.indexOf(d);
        }
      }
      this.docs.splice(i, 1);
      if (!this.docs.length) {
        // 允许一个标签都不留。以前这里会补一个空白页，于是"关掉所有文件"这件事
        // 做不到，人也没法真的收拾干净。
        this.active = -1;
        this._clearEditor();
        this.render();
        return;
      }
      if (this.active >= this.docs.length) {
        this.active = this.docs.length - 1;
      } else if (i < this.active) {
        this.active -= 1;
      }
      this.activate(this.active);
    }

    newTab() {
      this.docs.push({ path: null, name: T('未命名.md'), content: '', dirty: false });
      this.activate(this.docs.length - 1);
    }

    /** 没有标签页时把编辑区清空。 */
    _clearEditor() {
      this.editor.docName = T('未命名.md');
      const nameInput = document.getElementById('docNameInput');
      if (nameInput) nameInput.value = '';
      this.editor.resetCalloutToggles && this.editor.resetCalloutToggles();
      this.editor.setContent('', false);
    }

    /**
     * 编辑区的空状态：一个标签页都没有时显示引导，并把输入区置为只读。
     *
     * 只读是刻意的：没有标签页时敲进去的字没有任何地方可存（保存是无处可写的），
     * 与其让它静默消失，不如先请人新建一个文档。
     */
    _applyEmptyState() {
      if (!this.enabled) return;
      const empty = this.docs.length === 0;
      document.documentElement.classList.toggle('ws-no-docs', empty);
      const ta = document.getElementById('editorTextarea');
      if (ta) ta.readOnly = empty;
      const nameInput = document.getElementById('docNameInput');
      if (nameInput) nameInput.readOnly = empty;
      const mark = document.getElementById('wsWatermark');
      if (mark) mark.hidden = !empty;
    }

    saveActive() {
      return this.saveIndex(this.active);
    }

    /**
     * 网页版的"保存"。编辑器自己知道这份文档是怎么打开的（File System Access 句柄
     * 还是内存里的文件），所以这里把引用临时摘掉，让它走单文档那套逻辑——否则
     * editor.saveMarkdownFile() 又会回头调用工作区，转成死循环。
     */
    async _saveThroughEditor(i, d) {
      if (i !== this.active) { this._toast(T('请先切换到该标签页再保存'), 'info'); return false; }
      const editor = this.editor;
      const own = editor.workspace;
      editor.workspace = null;
      try {
        await editor.saveMarkdownFile();
      } finally {
        editor.workspace = own;
      }
      d.content = editor.getContent();
      d.dirty = false;
      this.renderTabs();
      return true;
    }

    /** 按索引保存，不只是当前标签页——关闭一个后台的脏标签页时也要能存。 */
    async saveIndex(i) {
      const d = this.docs[i];
      if (!d) { this._toast(T('当前没有打开的文件'), 'info'); return false; }
      // 只有正在编辑的文档才以编辑区为准；后台标签页的内容就是它自己存的。
      if (i === this.active) d.content = this.editor.getContent();

      let path = d.path;
      if (!path) {
        // 网页版没有可写的磁盘：交给编辑器自己处理——有 File System Access 句柄
        // 就写回原文件，没有就是下载一份副本。两条路都是它本来就有的行为。
        if (!this.isDesktop) return this._saveThroughEditor(i, d);
        path = await this.fs.saveAs({
          defaultPath: d.name,
          filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
        });
        if (!path) return false;   // 用户在另存为里取消了：当作没保存
      }

      let content = d.content;
      let formatted = false;
      if (this.formatOnSave && this.editor.linter && this.editor.linter.formatSpacing) {
        const fixed = this.editor.linter.formatSpacing(content);
        if (fixed !== content) { content = fixed; formatted = true; }
      }

      try {
        await this.fs.writeTextFile(path, content);
      } catch (e) {
        this._toast(T('保存失败：{a}', { a: e && e.message ? e.message : e }), 'error');
        return false;
      }

      const isNew = d.path !== path;
      d.path = path;
      d.name = baseName(path);
      d.content = content;
      d.dirty = false;
      // 排版改动了内容，编辑区得跟着变，否则界面显示的和文件里存的不是一回事。
      // pushHistory = true：格式化是内容变更，用户应当能撤销它。
      if (i === this.active && formatted) this.editor.setContent(content, true);
      this.editor.docName = this.docs[this.active] ? this.docs[this.active].name : d.name;
      this._pushRecent(path);
      // A brand-new file has to appear in the tree it was saved into.
      if (isNew && this.rootPath && isInside(path, this.rootPath)) {
        this._invalidate(parentOf(path));
        this.treeState[parentOf(path)] = true;
        this.selection = new Set([path]);
        this._revealTarget = path;
      }
      this.render();
      this._toast(formatted ? T('已按洛谷规范排版后保存「{a}」', { a: d.name }) : T('已保存到「{a}」', { a: d.name }), 'success');
      this._setSaveStatus(T('已保存到文件 {a}', { a: d.name }));
      return true;
    }

    // ---- folder tree: reading ------------------------------------------------

    async openFolderDialog() {
      if (!this.isDesktop) {
        this._toast(T('网页版读不到本地文件夹，请下载桌面版，或用"打开文件"逐个打开'), 'info');
        return;
      }
      const dir = await this.fs.openFolder();
      if (!dir) return;
      await this.setRoot(typeof dir === 'string' ? dir : dir.path || String(dir));
    }

    async openFileDialog() {
      // 网页版没有原生对话框，让编辑器用自己的选择器（单选、带 File System Access
      // 句柄），选完再补一个标签页——因为刚才把 workspace 摘掉了，它没机会自己补。
      if (!this.isDesktop) {
        const editor = this.editor;
        const own = editor.workspace;
        editor.workspace = null;
        try {
          await editor.triggerFileOpen();
        } finally {
          editor.workspace = own;
        }
        const ta = document.getElementById('editorTextarea');
        if (ta && ta.value) this.adoptExternal({ name: editor.docName, content: ta.value, path: null });
        return;
      }

      const picked = await this.fs.openFile({
        multiple: true,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!picked) return;
      const list = Array.isArray(picked) ? picked : [picked];
      for (const p of list) await this.openPath(typeof p === 'string' ? p : p.path);
    }

    async setRoot(path) {
      this.rootPath = path;
      this.treeState = { [path]: true };
      this.dirCache.clear();
      this.selection = new Set();
      this.focusPath = null;
      this.filter = '';
      const box = document.getElementById('wsFilter');
      if (box) box.value = '';
      await this.render();
    }

    /** Drop one directory (or all of them) from the cache after a mutation. */
    _invalidate(dir) {
      if (dir) this.dirCache.delete(dir);
      else this.dirCache.clear();
    }

    async _readDirSorted(path, opts) {
      const useCache = !(opts && opts.fresh);
      if (useCache && this.dirCache.has(path)) return this.dirCache.get(path);
      let items = [];
      try {
        items = await this.fs.readDir(path);
      } catch (e) {
        // Unreadable directory (permissions, or a file raced us to the name): show it
        // empty rather than breaking the whole tree render.
        items = [];
      }
      const out = items
        .map((e) => ({
          name: e.name,
          isDir: !!(e.isDirectory || e.children),
          path: e.path || joinPath(path, e.name),
        }))
        // Hide dotfiles: a project folder is usually full of .git noise.
        .filter((e) => !e.name.startsWith('.'))
        // Folders first, then names — the ordering every file manager uses.
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1)
          : a.name.localeCompare(b.name, 'zh-Hans-CN')));
      this.dirCache.set(path, out);
      return out;
    }

    // ---- folder tree: building the row list ----------------------------------

    /**
     * Flatten the tree into the rows that should be on screen, in order.
     *
     * Keyboard navigation and shift-range selection both need "the row above/below
     * me" as cheap operations, and a flattened list is the only shape that makes
     * that true. With a filter active the walk ignores expansion state and instead
     * finds every match plus the folders leading to it.
     */
    async _visibleNodes() {
      const rows = [];
      if (!this.rootPath) return rows;
      const root = { name: baseName(this.rootPath), path: this.rootPath, isDir: true, depth: 0, isRoot: true };
      rows.push(root);

      if (this.filter) {
        const needle = this.filter.toLowerCase();
        const budget = { nodes: FILTER_MAX_NODES };
        await this._collectMatches(rows, this.rootPath, 1, needle, budget, {});
        return rows;
      }

      if (this.treeState[this.rootPath]) {
        await this._collectChildren(rows, this.rootPath, 1);
      }
      return rows;
    }

    async _collectChildren(rows, dir, depth) {
      const items = await this._readDirSorted(dir);
      for (const it of items) {
        rows.push({ name: it.name, path: it.path, isDir: it.isDir, depth });
        if (it.isDir && this.treeState[it.path]) {
          await this._collectChildren(rows, it.path, depth + 1);
        }
      }
    }

    /**
     * Depth-first hunt for filename matches. A folder is kept when it matches (then
     * all of its children are listed) or when something below it matches.
     */
    async _collectMatches(rows, dir, depth, needle, budget, seen) {
      if (depth > FILTER_MAX_DEPTH || budget.nodes <= 0) return false;
      if (seen[dir]) return false; // symlink loop guard
      seen[dir] = true;

      const items = await this._readDirSorted(dir);
      let kept = false;
      for (const it of items) {
        if (budget.nodes <= 0) break;
        const hit = it.name.toLowerCase().indexOf(needle) >= 0;
        if (it.isDir) {
          if (hit) {
            // Matched folder: show it with everything inside, one level deep, so the
            // result is usable without further clicking.
            rows.push({ name: it.name, path: it.path, isDir: true, depth });
            budget.nodes -= 1;
            const sub = await this._readDirSorted(it.path);
            for (const c of sub) {
              if (budget.nodes <= 0) break;
              rows.push({ name: c.name, path: c.path, isDir: c.isDir, depth: depth + 1 });
              budget.nodes -= 1;
            }
            kept = true;
          } else {
            const mark = rows.length;
            rows.push({ name: it.name, path: it.path, isDir: true, depth });
            const inner = await this._collectMatches(rows, it.path, depth + 1, needle, budget, seen);
            if (inner) {
              budget.nodes -= 1;
              kept = true;
            } else {
              rows.length = mark; // nothing below matched: drop the folder again
            }
          }
        } else if (hit) {
          rows.push({ name: it.name, path: it.path, isDir: false, depth });
          budget.nodes -= 1;
          kept = true;
        }
      }
      return kept;
    }

    // ---- folder tree: rendering ----------------------------------------------

    async renderTree() {
      const host = document.getElementById('wsTree');
      if (!host) return;
      // Rendering the tree is async (each level is a readDir await), so two calls
      // that overlap would both clear the host and then both append — the tree came
      // out duplicated several times over. Stamp each run and let only the newest
      // one touch the DOM.
      const token = (this._treeToken = (this._treeToken || 0) + 1);
      const nodes = await this._visibleNodes();
      if (token !== this._treeToken) return;

      this._visible = nodes;
      host.textContent = '';
      if (!nodes.length) {
        host.appendChild(this._emptyState());
        return;
      }
      nodes.forEach((n) => host.appendChild(this._row(n)));
      this._scrollRevealIntoView();
    }

    _emptyState() {
      const box = document.createElement('div');
      box.className = 'ws-empty ws-empty-open';
      const hint = document.createElement('div');
      hint.className = 'ws-empty-hint';
      hint.textContent = T('未打开文件夹');
      const open = document.createElement('button');
      open.className = 'ws-empty-btn';
      open.textContent = T('打开文件夹');
      open.onclick = () => this.openFolderDialog();
      const openFile = document.createElement('button');
      openFile.className = 'ws-empty-btn ws-empty-btn-quiet';
      openFile.textContent = T('打开文件');
      openFile.onclick = () => this.openFileDialog();
      box.appendChild(hint);
      box.appendChild(open);
      box.appendChild(openFile);
      return box;
    }

    _row(node) {
      const { name, path, isDir, depth } = node;
      const openDoc = this.docs[this.active];
      const row = document.createElement('div');
      row.className = 'ws-node'
        + (isDir ? ' is-dir' : '')
        + (depth === 0 ? ' is-root' : '')
        + (this.treeState[path] ? ' is-expanded' : '')
        + (openDoc && openDoc.path === path ? ' is-open' : '')
        + (this.selection.has(path) ? ' is-selected' : '')
        + (this.focusPath === path ? ' is-focused' : '');
      const d = this.docs.find((x) => x.path === path);
      if (d && d.dirty) row.classList.add('is-dirty');

      row.style.setProperty('--ws-depth', String(depth));
      row.style.paddingLeft = `${6 + depth * INDENT_PX}px`;
      row.setAttribute('data-path', path);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      if (isDir) row.setAttribute('aria-expanded', this.treeState[path] ? 'true' : 'false');
      row.title = path;
      // 不用 HTML5 的 draggable：桌面版把拖放交给了 Tauri 的原生处理器，WebView 里
      // 的 HTML5 拖放在 Windows 上会被顶掉。树的拖动见 _pressRow（指针事件）。

      // Indent guides. A fixed-size, repeating gradient as the row's background keeps
      // this out of the DOM: one background box per level, no guide elements to manage.
      if (depth > 0) row.classList.add('has-guides');

      const chev = document.createElement('span');
      chev.className = 'ws-chev';
      if (isDir) {
        const tri = document.createElementNS(SVG_NS, 'svg');
        tri.setAttribute('viewBox', '0 0 16 16');
        tri.setAttribute('width', '16');
        tri.setAttribute('height', '16');
        tri.setAttribute('aria-hidden', 'true');
        tri.setAttribute('class', 'ws-svg ws-svg-chev');
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
        tri.appendChild(p);
        chev.appendChild(tri);
      }
      row.appendChild(chev);

      const icon = document.createElement('span');
      icon.className = 'ws-icon';
      if (isDir) {
        icon.appendChild(makeFolderIcon(!!this.treeState[path]));
      } else {
        const k = kindOf(name);
        icon.appendChild(makeIcon(k.glyph, k.kind, 'ws-svg-file'));
      }
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'ws-node-name';
      // textContent, never innerHTML: file names come from the disk and are attacker
      // controlled in exactly the case that matters (a repo you just cloned).
      label.textContent = name;
      row.appendChild(label);

      this._bindRow(row, node);
      return row;
    }

    _bindRow(row, node) {
      const { path, isDir } = node;
      row.onclick = (e) => {
        // 拖完松手时浏览器还会补一个 click，那不是"点开文件"的意思。
        if (this._justDragged) { this._justDragged = false; return; }
        if (e.ctrlKey || e.metaKey) {
          this._toggleSelect(path);
        } else if (e.shiftKey) {
          this._selectRange(path);
        } else {
          this.selection = new Set([path]);
          this.focusPath = path;
          if (isDir) this.toggleDir(path); else this.openPath(path);
          return; // toggleDir/openPath re-render and repaint selection
        }
        this._paintSelection();
      };
      row.oncontextmenu = (e) => {
        e.preventDefault();
        // Right-clicking inside a multi-selection keeps it — that is how you delete
        // or move several files at once.
        if (!this.selection.has(path)) {
          this.selection = new Set([path]);
          this.focusPath = path;
          this._paintSelection();
        }
        this._showMenu(e.clientX, e.clientY, this._menuItemsFor(node));
      };
      row.ondblclick = () => {
        if (!isDir) this.openPath(path);
      };

      // --- 拖动（指针事件，见 _pressRow）---
      row.addEventListener('pointerdown', (e) => this._pressRow(e, node));
    }

    toggleDir(path) {
      this.treeState[path] = !this.treeState[path];
      this.renderTree();
    }

    // ---- selection -----------------------------------------------------------

    _paintSelection() {
      const host = document.getElementById('wsTree');
      if (!host) return;
      host.querySelectorAll('.ws-node[data-path]').forEach((el) => {
        const p = el.getAttribute('data-path');
        el.classList.toggle('is-selected', this.selection.has(p));
        el.classList.toggle('is-focused', this.focusPath === p);
      });
    }

    _toggleSelect(path) {
      if (this.selection.has(path)) this.selection.delete(path);
      else this.selection.add(path);
      this.focusPath = path;
    }

    _selectRange(path) {
      const order = this._visible.map((n) => n.path);
      const to = order.indexOf(path);
      const from = order.indexOf(this.focusPath);
      if (to < 0) return;
      if (from < 0) { this.selection = new Set([path]); this.focusPath = path; return; }
      const [a, b] = from <= to ? [from, to] : [to, from];
      const next = new Set(this.selection);
      for (let i = a; i <= b; i += 1) next.add(order[i]);
      this.selection = next;
    }

    _selectAllVisible() {
      this.selection = new Set(this._visible.filter((n) => !n.isRoot).map((n) => n.path));
      this._paintSelection();
    }

    _clearSelection() {
      this.selection = new Set();
      this._paintSelection();
    }

    /** Selected paths, minus the workspace root (nothing may delete or move that). */
    _targets() {
      const list = [...this.selection].filter((p) => p !== this.rootPath);
      if (list.length) return list;
      return this.focusPath && this.focusPath !== this.rootPath ? [this.focusPath] : [];
    }

    /** Expand every ancestor of a path so its row can be shown. */
    _expandAncestors(path) {
      let dir = parentOf(path);
      while (dir && isInside(dir, this.rootPath)) {
        this.treeState[dir] = true;
        if (norm(dir) === norm(this.rootPath)) break;
        dir = parentOf(dir);
      }
      this.treeState[this.rootPath] = true;
    }

    _scrollRevealIntoView() {
      const target = this._revealTarget;
      if (!target) return;
      this._revealTarget = null;
      const host = document.getElementById('wsTree');
      const row = host && host.querySelector(`.ws-node[data-path="${CSS.escape(target)}"]`);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }

    // ---- keyboard navigation -------------------------------------------------

    /** Move the cursor by one row, selecting what it lands on (as VS Code does). */
    _step(offset) {
      if (!this._visible.length) return;
      const order = this._visible.map((n) => n.path);
      const at = order.indexOf(this.focusPath);
      const next = at < 0 ? (offset > 0 ? 0 : order.length - 1)
        : Math.min(order.length - 1, Math.max(0, at + offset));
      const path = order[next];
      this.focusPath = path;
      this.selection = new Set([path]);
      this._paintSelection();
      const host = document.getElementById('wsTree');
      const row = host && host.querySelector(`.ws-node[data-path="${CSS.escape(path)}"]`);
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }

    _nodeFor(path) {
      return this._visible.find((n) => n.path === path) || null;
    }

    _firstChildOf(path) {
      const i = this._visible.findIndex((n) => n.path === path);
      if (i < 0) return null;
      const next = this._visible[i + 1];
      return next && next.depth > this._visible[i].depth ? next : null;
    }

    _parentNodeOf(path) {
      const parent = parentOf(path);
      return this._nodeFor(parent);
    }

    _onTreeKeyDown(e) {
      if (this._inline) return; // the inline input owns the keyboard while it is open
      const node = this._nodeFor(this.focusPath);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); this._step(1); break;
        case 'ArrowUp': e.preventDefault(); this._step(-1); break;
        case 'ArrowRight':
          e.preventDefault();
          if (node && node.isDir && !this.treeState[node.path]) {
            this.toggleDir(node.path);
          } else if (node) {
            const child = this._firstChildOf(node.path);
            if (child) { this.focusPath = child.path; this.selection = new Set([child.path]); this._paintSelection(); }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (node && node.isDir && this.treeState[node.path]) {
            this.toggleDir(node.path);
          } else if (node) {
            const parent = this._parentNodeOf(node.path);
            if (parent) {
              this.focusPath = parent.path;
              this.selection = new Set([parent.path]);
              this._paintSelection();
            }
          }
          break;
        case 'Enter':
          e.preventDefault();
          if (node && node.isDir) this.toggleDir(node.path);
          else if (node) this.openPath(node.path);
          break;
        case 'F2': e.preventDefault(); this._beginRename(); break;
        case 'Delete': case 'Backspace':
          e.preventDefault();
          this._deleteSelection();
          break;
        case 'a': case 'A':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._selectAllVisible(); }
          break;
        case 'Home': e.preventDefault(); this._step(-this._visible.length); break;
        case 'End': e.preventDefault(); this._step(this._visible.length); break;
        case 'Escape': this._clearSelection(); break;
        default: break;
      }
    }

    // ---- inline input (new file / new folder / rename) -----------------------

    /**
     * Put a text box in the tree, where the name will actually appear.
     *
     * A dialog would be simpler, but naming happens in the tree and a modal makes the
     * user lose the context of which folder they are in; VS Code puts the input in
     * the row itself and so does this.
     */
    _openInlineInput(anchorPath, { depth, value, onCommit, selectStem }) {
      this._cancelInlineInput();
      const host = document.getElementById('wsTree');
      if (!host) return;

      const row = document.createElement('div');
      row.className = 'ws-node ws-input-row';
      row.style.paddingLeft = `${6 + depth * INDENT_PX}px`;
      row.appendChild(Object.assign(document.createElement('span'), { className: 'ws-chev' }));
      const icon = document.createElement('span');
      icon.className = 'ws-icon';
      icon.appendChild(makeIcon('file', 'plain', 'ws-svg-file'));
      row.appendChild(icon);

      const input = document.createElement('input');
      input.className = 'ws-inline-input';
      input.type = 'text';
      input.value = value || '';
      input.spellcheck = false;
      input.autocomplete = 'off';
      row.appendChild(input);

      const anchorRow = anchorPath
        ? host.querySelector(`.ws-node[data-path="${CSS.escape(anchorPath)}"]`)
        : null;
      if (anchorRow && anchorRow.parentNode === host) anchorRow.insertAdjacentElement('afterend', row);
      else host.insertBefore(row, host.firstChild);

      const finish = async (commit) => {
        if (this._inline !== token) return;
        this._inline = null;
        const name = input.value.trim();
        row.remove();
        if (commit && name) await onCommit(name);
      };

      const token = {
        input,
        finish,
        cancel: () => { if (this._inline === token) { this._inline = null; row.remove(); } },
      };
      this._inline = token;

      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // Delete/F2 in the box are text editing, not tree commands
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(false));

      input.focus();
      if (selectStem) {
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      } else {
        input.select();
      }
    }

    _cancelInlineInput() {
      if (this._inline) {
        const t = this._inline;
        this._inline = null;
        t.input.parentNode && t.input.parentNode.remove();
      }
    }

    // ---- file operations -----------------------------------------------------

    /** Reject names no filesystem will take, before asking the host and getting an error. */
    _checkName(name) {
      if (!name) return T('名字不能为空');
      if (BAD_NAME.test(name)) return T('名字里不能包含 \\ / : * ? " < > |');
      if (/^\.+$/.test(name)) return T('这个名字不可用');
      if (name.endsWith(' ') || name.endsWith('.')) return T('名字不能以空格或点结尾');
      return null;
    }

    async _pathExists(path) {
      if (this.fs.exists) {
        try { return await this.fs.exists(path); } catch (e) { /* fall back to the listing */ }
      }
      const parent = parentOf(path);
      const items = await this._readDirSorted(parent, { fresh: true });
      const want = baseName(path);
      return items.some((it) => (isWinPath(path)
        ? it.name.toLowerCase() === want.toLowerCase()
        : it.name === want));
    }

    _beginCreate(anchorPath, isDir) {
      if (!this.rootPath) return;
      const node = anchorPath ? this._nodeFor(anchorPath) : null;
      // Creating from a file means "in that file's folder"; from a folder, inside it.
      const dir = node ? (node.isDir ? node.path : parentOf(node.path)) : this.rootPath;
      const depth = node ? (node.isDir ? node.depth + 1 : node.depth) : 1;
      if (node && node.isDir && !this.treeState[node.path]) this.treeState[node.path] = true;

      const name = isDir ? '' : T('未命名.md');
      this._openInlineInput(node ? node.path : null, {
        depth,
        value: name,
        selectStem: !isDir,
        onCommit: async (input) => {
          const bad = this._checkName(input);
          if (bad) { this._toast(bad, 'error'); return; }
          const path = joinPath(dir, input);
          if (await this._pathExists(path)) { this._toast(T('「{a}」已存在', { a: input }), 'error'); return; }
          try {
            if (isDir) {
              if (!this.fs.mkdir) throw new Error(T('该主机不支持新建文件夹'));
              await this.fs.mkdir(path);
            } else {
              await this.fs.writeTextFile(path, '');
            }
          } catch (e) {
            this._toast(T('创建失败：{a}', { a: e && e.message ? e.message : e }), 'error');
            return;
          }
          this._invalidate(dir);
          this.treeState[dir] = true;
          this.selection = new Set([path]);
          this.focusPath = path;
          if (!isDir) { this._revealTarget = path; await this.openPath(path); }
          else await this.renderTree();
        },
      });
    }

    _beginRename() {
      const targets = this._targets();
      if (targets.length !== 1) {
        if (targets.length) this._toast(T('一次只能重命名一个文件'), 'error');
        return;
      }
      const path = targets[0];
      const node = this._nodeFor(path);
      if (!node) return;
      const dir = parentOf(path);
      this._openInlineInput(path, {
        depth: node.depth,
        value: baseName(path),
        selectStem: !node.isDir,
        onCommit: async (input) => {
          if (input === baseName(path)) return; // no-op rename
          const bad = this._checkName(input);
          if (bad) { this._toast(bad, 'error'); return; }
          const next = joinPath(dir, input);
          if (await this._pathExists(next)) { this._toast(T('「{a}」已存在', { a: input }), 'error'); return; }
          if (!this.fs.rename) { this._toast(T('该主机不支持重命名'), 'error'); return; }
          try {
            await this.fs.rename(path, next);
          } catch (e) {
            this._toast(T('重命名失败：{a}', { a: e && e.message ? e.message : e }), 'error');
            return;
          }
          this._afterMove(path, next);
          this._invalidate(dir);
          this.selection = new Set([next]);
          this.focusPath = next;
          this._revealTarget = next;
          await this.render();
          this._toast(T('已重命名为「{a}」', { a: input }), 'success');
        },
      });
    }

    async _deleteSelection() {
      const targets = this._targets();
      if (!targets.length) return;
      if (!this.fs.remove) { this._toast(T('该主机不支持删除'), 'error'); return; }

      const names = targets.map((p) => baseName(p));
      const openDirty = this.docs.filter((d) => d.dirty && d.path && targets.some((t) => isInside(d.path, t)));
      const what = targets.length === 1
        ? `「${names[0]}」`
        : T('{a} 个项目（{b}{c}）', { a: targets.length, b: names.slice(0, 3).join('、'), c: names.length > 3 ? '…' : '' });
      const extra = openDirty.length
        ? T('\n\n其中 {a} 有未保存的修改，一并丢弃。',
          { a: openDirty.map((d) => T('「{a}」', { a: d.name })).join(T('、')) })
        : '';
      const ok = await this.fs.confirm(T('确定要删除 {a} 吗？此操作不可撤销。{b}', { a: what, b: extra }));
      if (!ok) return;

      const failed = [];
      for (const path of targets) {
        try {
          await this.fs.remove(path, { recursive: true });
        } catch (e) {
          failed.push(`${baseName(path)}：${e && e.message ? e.message : e}`);
          continue;
        }
        this._forgetPath(path);
        this._invalidate(parentOf(path));
      }
      this.selection = new Set();
      this.focusPath = null;
      await this.render();
      if (failed.length) this._toast(T('部分删除失败：{a}', { a: failed.join('；') }), 'error');
      else this._toast(targets.length === 1
        ? T('已删除「{a}」', { a: names[0] })
        : T('已删除 {n} 个项目', { n: targets.length }), 'success');
    }

    /** Move the current drag payload into `destDir`. */
    // ---- 树里的拖动（指针事件） ------------------------------------------------

    /**
     * 按下某一行。真正开始拖要等指针移动超过阈值——否则每次单击都会被当成一次
     * 移动尝试，那不是人想要的行为。
     */
    _pressRow(e, node) {
      if (e.button !== 0) return;                 // 中键、右键不参与拖动
      this.press = { path: node.path, isDir: node.isDir, x: e.clientX, y: e.clientY };
      const onMove = (ev) => this._dragMove(ev);
      const onUp = (ev) => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        this._dragUp(ev);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    }

    _dragMove(e) {
      const st = this.press;
      if (!st) return;
      if (!this._dragPaths) {
        if (Math.abs(e.clientX - st.x) < DRAG_THRESHOLD
          && Math.abs(e.clientY - st.y) < DRAG_THRESHOLD) return;
        // 拖的是选中集合里的一个，就把整批都带走——和资源管理器一致。
        this._dragPaths = this.selection.has(st.path) ? [...this.selection] : [st.path];
        this._markDragging(this._dragPaths);
        document.body.classList.add('ws-dragging');
        this._showGhost(this._dragPaths.length > 1
          ? T('{a} 个项目', { a: this._dragPaths.length })
          : baseName(st.path));
      }
      this._moveGhost(e);
      this._highlightDropTarget(e);
    }

    async _dragUp(e) {
      const st = this.press;
      this.press = null;
      const paths = this._dragPaths;
      this._dragPaths = null;
      this._clearDragVisuals();
      if (!st || !paths) return;                  // 没越过阈值：这是一次普通单击
      this._justDragged = true;
      const target = this._dropTargetAt(e);
      if (!target) return;                        // 松手在树外面：当作放弃
      this._dragPaths = paths;
      await this._moveInto(target);
    }

    _markDragging(paths) {
      const set = new Set(paths);
      document.querySelectorAll('.ws-node[data-path]').forEach((el) => {
        el.classList.toggle('is-dragging', set.has(el.getAttribute('data-path')));
      });
    }

    _clearDragVisuals() {
      this._hideGhost();
      document.body.classList.remove('ws-dragging');
      document.querySelectorAll('.ws-node.is-dragging, .ws-node.is-drop-target')
        .forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
    }

    _showGhost(label) {
      let ghost = this._ghost;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'ws-drag-ghost';
        document.body.appendChild(ghost);
        this._ghost = ghost;
      }
      ghost.textContent = label;
      ghost.hidden = false;
    }

    _moveGhost(e) {
      if (!this._ghost || this._ghost.hidden) return;
      this._ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;
    }

    _hideGhost() {
      if (this._ghost) this._ghost.hidden = true;
    }

    /** 落点：文件夹行 → 放进它；文件行 → 放进它所在目录；树的空白 → 根目录。 */
    _dropTargetAt(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return null;
      const row = el.closest ? el.closest('.ws-node[data-path]') : null;
      if (row) {
        const path = row.getAttribute('data-path');
        const node = (this._visible || []).find((n) => n.path === path);
        const isDir = node ? node.isDir : row.classList.contains('is-dir');
        return isDir ? path : parentOf(path);
      }
      const tree = document.getElementById('wsTree');
      return tree && tree.contains(el) ? this.rootPath : null;
    }

    _highlightDropTarget(e) {
      const target = this._dropTargetAt(e);
      const tree = document.getElementById('wsTree');
      if (!tree) return;
      const rows = [...tree.querySelectorAll('.ws-node[data-path]')];
      rows.forEach((el) => {
        if (el.getAttribute('data-path') !== target) el.classList.remove('is-drop-target');
      });
      // 空白处（根目录）不画高亮：整棵树都算落点，没有哪一行可以标。
      const hit = rows.find((el) => el.getAttribute('data-path') === target
        && el.classList.contains('is-dir'));
      if (hit) hit.classList.add('is-drop-target');
    }

    async _moveInto(destDir) {
      const paths = (this._dragPaths || []).slice();
      this._dragPaths = null;
      document.querySelectorAll('.ws-node.is-dragging, .ws-node.is-drop-target')
        .forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
      if (!paths.length || !this.fs.rename) return;
      if (!destDir || !isInside(destDir, this.rootPath)) return;

      let moved = 0;
      const skipped = [];
      for (const path of paths) {
        if (norm(parentOf(path)) === norm(destDir)) continue;      // already there
        if (isInside(destDir, path)) { skipped.push(T('{a}（不能移动到自身内部）', { a: baseName(path) })); continue; }
        const next = joinPath(destDir, baseName(path));
        if (await this._pathExists(next)) { skipped.push(T('{a}（同名已存在）', { a: baseName(path) })); continue; }
        try {
          await this.fs.rename(path, next);
        } catch (e) {
          skipped.push(`${baseName(path)}（${e && e.message ? e.message : e}）`);
          continue;
        }
        this._afterMove(path, next);
        this._invalidate(parentOf(path));
        moved += 1;
      }
      this._invalidate(destDir);
      this.treeState[destDir] = true;
      await this.render();
      if (moved) {
        this._toast(T('已移动 {n} 个项目', { n: moved }), 'success');
      }
      if (skipped.length) this._toast(T('跳过：{a}', { a: skipped.join('；') }), 'error');
    }

    /**
     * Everything that has to follow a file to its new name: open tabs, expansion
     * state, selection, the recent list. Miss one and the panel starts pointing at
     * paths that no longer exist.
     */
    _afterMove(oldPath, newPath) {
      this.docs.forEach((d) => {
        if (!d.path) return;
        const moved = rewritePath(d.path, oldPath, newPath);
        if (moved) { d.path = moved; d.name = baseName(moved); }
      });
      const active = this.docs[this.active];
      if (active) {
        this.editor.docName = active.name;
        const nameInput = document.getElementById('docNameInput');
        if (nameInput) nameInput.value = active.name;
      }
      const nextState = {};
      Object.keys(this.treeState).forEach((k) => {
        nextState[rewritePath(k, oldPath, newPath) || k] = this.treeState[k];
      });
      this.treeState = nextState;
      this.selection = new Set([...this.selection].map((p) => rewritePath(p, oldPath, newPath) || p));
      if (this.focusPath) this.focusPath = rewritePath(this.focusPath, oldPath, newPath) || this.focusPath;
      this._repairRecent(oldPath, newPath);
    }

    /** Drop a deleted path from the tab list, the tree state and the recent list. */
    _forgetPath(path) {
      const doomed = this.docs
        .map((d, i) => (d.path && isInside(d.path, path) ? i : -1))
        .filter((i) => i >= 0)
        .reverse();
      if (doomed.length) {
        doomed.forEach((i) => this.docs.splice(i, 1));
        if (!this.docs.length) {
          this.active = -1;
          this._clearEditor();
        } else {
          this.active = Math.max(0, Math.min(this.active, this.docs.length - 1));
          const d = this.docs[this.active];
          this.editor.docName = d.name;
          const nameInput = document.getElementById('docNameInput');
          if (nameInput) nameInput.value = d.name;
          this.editor.resetCalloutToggles && this.editor.resetCalloutToggles();
          this.editor.setContent(d.content, false);
        }
      }
      Object.keys(this.treeState).forEach((k) => { if (isInside(k, path)) delete this.treeState[k]; });
      [...this.selection].forEach((p) => { if (isInside(p, path)) this.selection.delete(p); });
      const list = this._recent().filter((p) => !isInside(p, path));
      try {
        global.localStorage && global.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      } catch (e) { /* convenience only */ }
    }

    // ---- context menu --------------------------------------------------------

    _menuItemsFor(node) {
      const items = [];
      const isRoot = node && node.isRoot;
      if (isRoot) {
        items.push({ label: T('新建文件'), action: () => this._beginCreate(null, false) });
        items.push({ label: T('新建文件夹'), action: () => this._beginCreate(null, true) });
        items.push({ sep: true });
        items.push({ label: T('刷新'), action: () => this.refresh() });
        items.push({ label: T('全部折叠'), action: () => this.collapseAll() });
        items.push({ sep: true });
        items.push({ label: T('在文件管理器中显示'), action: () => this._revealInSystem(node.path) });
        items.push({ label: T('复制路径'), action: () => this._copyPath(node.path) });
        return items;
      }
      if (!node) {
        items.push({ label: T('新建文件'), action: () => this._beginCreate(null, false) });
        items.push({ label: T('新建文件夹'), action: () => this._beginCreate(null, true) });
        items.push({ sep: true });
        items.push({ label: T('刷新'), action: () => this.refresh() });
        items.push({ label: T('全部折叠'), action: () => this.collapseAll() });
        return items;
      }

      const many = this.selection.size > 1 && this.selection.has(node.path);
      if (node.isDir) {
        items.push({ label: T('新建文件'), action: () => this._beginCreate(node.path, false) });
        items.push({ label: T('新建文件夹'), action: () => this._beginCreate(node.path, true) });
        items.push({ sep: true });
        items.push({ label: T('展开'), action: () => { this.treeState[node.path] = true; this.renderTree(); } });
        items.push({ label: T('折叠'), action: () => { this.treeState[node.path] = false; this.renderTree(); } });
      } else {
        items.push({ label: T('打开'), action: () => this.openPath(node.path) });
      }
      items.push({ sep: true });
      if (!many) items.push({ label: T('重命名'), hint: 'F2', action: () => this._beginRename() });
      items.push({ label: many ? T('删除 {a} 个项目', { a: this.selection.size }) : T('删除'), hint: 'Del', danger: true, action: () => this._deleteSelection() });
      items.push({ sep: true });
      if (this.fs.revealInDir) {
        items.push({ label: T('在文件管理器中显示'), action: () => this._revealInSystem(node.path) });
      }
      items.push({ label: T('复制路径'), action: () => this._copyPath(node.path) });
      return items;
    }

    _showMenu(x, y, items) {
      this._closeMenu();
      const menu = document.createElement('div');
      menu.className = 'ws-menu';
      menu.setAttribute('role', 'menu');
      items.filter(Boolean).forEach((it) => {
        if (it.sep) {
          const sep = document.createElement('div');
          sep.className = 'ws-menu-sep';
          menu.appendChild(sep);
          return;
        }
        const el = document.createElement('div');
        el.className = 'ws-menu-item' + (it.danger ? ' is-danger' : '');
        el.setAttribute('role', 'menuitem');
        el.tabIndex = -1;
        const label = document.createElement('span');
        label.textContent = it.label;
        el.appendChild(label);
        if (it.hint) {
          const hint = document.createElement('span');
          hint.className = 'ws-menu-hint';
          hint.textContent = it.hint;
          el.appendChild(hint);
        }
        el.onclick = () => { this._closeMenu(); it.action(); };
        menu.appendChild(el);
      });
      document.body.appendChild(menu);
      // Keep it on screen: menus opened near the bottom/right edge would otherwise
      // hang off the window, which the webview does not scroll back into view.
      const rect = menu.getBoundingClientRect();
      const left = Math.min(x, global.innerWidth - rect.width - 4);
      const top = Math.min(y, global.innerHeight - rect.height - 4);
      menu.style.left = `${Math.max(4, left)}px`;
      menu.style.top = `${Math.max(4, top)}px`;
      this._menu = menu;

      const focusables = [...menu.querySelectorAll('.ws-menu-item')];
      if (focusables[0]) focusables[0].focus();
      menu.onkeydown = (e) => {
        const at = focusables.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); (focusables[at + 1] || focusables[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (focusables[at - 1] || focusables[focusables.length - 1]).focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); this._closeMenu(); }
        else if (e.key === 'Enter' && at >= 0) { e.preventDefault(); focusables[at].click(); }
        e.stopPropagation();
      };

      // Any click elsewhere, or a scroll inside the tree, invalidates the anchor point.
      const away = (ev) => { if (!menu.contains(ev.target)) this._closeMenu(); };
      this._menuAway = away;
      setTimeout(() => {
        document.addEventListener('mousedown', away, true);
        document.addEventListener('wheel', away, { capture: true, passive: true });
        global.addEventListener('blur', away);
      }, 0);
    }

    _closeMenu() {
      if (!this._menu) return;
      this._menu.remove();
      this._menu = null;
      if (this._menuAway) {
        document.removeEventListener('mousedown', this._menuAway, true);
        document.removeEventListener('wheel', this._menuAway, { capture: true });
        global.removeEventListener('blur', this._menuAway);
        this._menuAway = null;
      }
    }

    // ---- misc operations -----------------------------------------------------

    async refresh() {
      const dir = this.rootPath;
      if (!dir) return;
      this._invalidate();
      await this.render();
    }

    collapseAll() {
      this.treeState = this.rootPath ? { [this.rootPath]: true } : {};
      this.renderTree();
    }

    async _revealInSystem(path) {
      if (!this.fs.revealInDir) return;
      try {
        await this.fs.revealInDir(path);
      } catch (e) {
        this._toast(T('无法在文件管理器中显示：{a}', { a: e && e.message ? e.message : e }), 'error');
      }
    }

    async _copyPath(path) {
      try {
        if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
          await global.navigator.clipboard.writeText(path);
        } else {
          throw new Error('no clipboard api');
        }
      } catch (e) {
        // The webview can refuse clipboard access; a temporary textarea still works and
        // is the difference between "copied" and "nothing happened".
        try {
          const ta = document.createElement('textarea');
          ta.value = path;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch (err) {
          this._toast(T('复制失败'), 'error');
          return;
        }
      }
      this._toast(T('已复制路径'), 'success');
    }

    _repairRecent(oldPrefix, newPrefix) {
      const list = this._recent();
      const next = list.map((p) => rewritePath(p, oldPrefix, newPrefix) || p);
      try {
        global.localStorage && global.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch (e) { /* convenience only */ }
      this.renderRecent();
    }

    // ---- DOM -----------------------------------------------------------------

    /**
     * 两种形态共用一套标签页逻辑，差别只在左边有没有文件树：
     *   desktop —— 有原生文件系统，标签页 + 文件树 + 写回；
     *   web     —— 只有标签页。浏览器里没有可写回的目录，硬塞一棵树只是摆设。
     */
    _buildDom() {
      if (document.getElementById('workspaceTabs')) return;
      const pane = document.getElementById('editorPane');
      if (!pane) return;

      const tabs = document.createElement('div');
      tabs.id = 'workspaceTabs';
      tabs.className = 'ws-tabs';
      pane.insertBefore(tabs, pane.firstChild);

      if (this.isDesktop) {
        this._buildExplorer(pane);
        this._buildDropHint(pane);
      }

      this._buildWatermark(pane);

      // Ctrl+W 关标签页、Ctrl+B 收侧栏、中键关标签页都在各自的绑定里。
      window.addEventListener('keydown', (e) => this._onGlobalKey(e));

      document.documentElement.classList.add('has-workspace');
      if (this.isDesktop) {
        document.documentElement.classList.add('ws-desktop');
        this._applyCollapsed();
      }
    }

    /** 左侧文件树 + 最近打开 + 宽度调节。只有能读写磁盘时才有意义。 */
    _buildExplorer(pane) {
      const panel = document.createElement('aside');
      panel.id = 'workspacePanel';
      panel.className = 'workspace-panel';
      panel.innerHTML = `
        <div class="ws-head">
          <span class="ws-title">${T('资源管理器')}</span>
          <button class="ws-btn" id="wsNewFile" title="${T('新建文件')}"></button>
          <button class="ws-btn" id="wsNewDir" title="${T('新建文件夹')}"></button>
          <button class="ws-btn" id="wsRefresh" title="${T('刷新')}"></button>
          <button class="ws-btn" id="wsMore" title="${T('更多操作')}">⋯</button>
          <button class="ws-btn" id="wsCollapse" title="${T('收起侧栏（Ctrl+B）')}"></button>
        </div>
        <div class="ws-filter-row">
          <input type="text" id="wsFilter" class="ws-filter" placeholder="${T('按文件名过滤')}" spellcheck="false" autocomplete="off">
        </div>
        <div class="ws-tree" id="wsTree" tabindex="0" role="tree" aria-label="${T('文件树')}"></div>
        <div class="ws-sec">${T('最近打开')}</div>
        <div class="ws-recent" id="wsRecent"></div>
        <div class="ws-rail">
          <button class="ws-btn" id="wsExpand" title="${T('展开侧栏（Ctrl+B）')}"></button>
        </div>`;
      pane.parentNode.insertBefore(panel, pane);

      // The drag handle is a flex item between the panel and the editor, not a child
      // of the panel: the panel clips its overflow (`overflow: hidden` is what keeps
      // the tree from spilling out), which would also clip a handle hanging off its
      // edge — and a handle inside it would sit on top of the tree's scrollbar.
      const resizer = document.createElement('div');
      resizer.className = 'ws-resizer';
      resizer.title = T('拖动调整宽度，双击复位');
      pane.parentNode.insertBefore(resizer, pane);


      // Toolbar icons: same SVG factory as the tree, so the panel has one visual voice.
      document.getElementById('wsNewFile').appendChild(makeIcon('newFile', null, 'ws-svg-btn'));
      document.getElementById('wsNewDir').appendChild(makeIcon('newDir', null, 'ws-svg-btn'));
      document.getElementById('wsRefresh').appendChild(makeIcon('refresh', null, 'ws-svg-btn'));

      document.getElementById('wsNewFile').onclick = () => this._beginCreate(this.focusPath, false);
      document.getElementById('wsNewDir').onclick = () => this._beginCreate(this.focusPath, true);
      document.getElementById('wsRefresh').onclick = () => this.refresh();
      document.getElementById('wsMore').onclick = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        this._showMenu(r.left - 130, r.bottom + 2, [
          { label: T('打开文件夹…'), action: () => this.openFolderDialog() },
          { label: T('打开文件…'), action: () => this.openFileDialog() },
          { sep: true },
          { label: T('新建标签页'), action: () => this.newTab() },
          { label: T('刷新'), action: () => this.refresh() },
          { label: T('全部折叠'), action: () => this.collapseAll() },
          { sep: true },
          { label: T('收起侧栏'), action: () => this.toggleCollapsed(true) },
        ]);
      };

      const collapseBtn = document.getElementById('wsCollapse');
      collapseBtn.appendChild(makeIcon('collapse', null, 'ws-svg-btn'));
      collapseBtn.onclick = () => this.toggleCollapsed(true);
      const expandBtn = document.getElementById('wsExpand');
      expandBtn.appendChild(makeIcon('expand', null, 'ws-svg-btn'));
      expandBtn.onclick = () => this.toggleCollapsed(false);

      const filter = document.getElementById('wsFilter');
      let debounce = null;
      filter.oninput = () => {
        // Light debounce: the tree walk reads directories, and typing is faster than
        // the disk on a cold cache.
        clearTimeout(debounce);
        debounce = setTimeout(() => { this.filter = filter.value.trim(); this.renderTree(); }, 120);
      };
      filter.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { filter.value = ''; this.filter = ''; this.renderTree(); filter.blur(); }
        if (e.key === 'ArrowDown') { this._step(1); const t = document.getElementById('wsTree'); t && t.focus(); }
      };

      const tree = document.getElementById('wsTree');
      tree.addEventListener('keydown', (e) => this._onTreeKeyDown(e));
      // Clicking the blank area below the rows clears the selection, like VS Code.
      tree.addEventListener('mousedown', (e) => {
        if (e.target === tree) { this._clearSelection(); this.focusPath = null; }
      });
      tree.oncontextmenu = (e) => {
        if (e.target !== tree) return;
        e.preventDefault();
        this._showMenu(e.clientX, e.clientY, this._menuItemsFor(null));
      };
      // 空白处的落点由指针逻辑处理（_dropTargetAt 把树里的空白当根目录）。

      this._bindResizer(panel, resizer);
      const stored = Number(global.localStorage && global.localStorage.getItem(WIDTH_KEY));
      if (stored) panel.style.flexBasis = `${Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, stored))}px`;
    }

    /**
     * 空状态浮层。挂在 .editor-wrapper 上（它是 position: relative），这样只盖住
     * 编辑区正文，不挡上面的文件名与查找栏。内容是写死的字面量，没有插值。
     *
     * 两种形态的按钮不一样：网页版没有文件夹可开，保存也只是下载一份副本，所以
     * 提示文案得说实话，不能照抄桌面版。
     */
    _buildWatermark(pane) {
      const wrapper = pane.querySelector('.editor-wrapper');
      if (!wrapper) return;
      const mark = document.createElement('div');
      mark.id = 'wsWatermark';
      mark.className = 'ws-watermark';
      mark.hidden = true;
      mark.innerHTML = `
        <div class="ws-watermark-icon"></div>
        <div class="ws-watermark-title">${T('没有打开的文件')}</div>
        <div class="ws-watermark-actions">
          <button type="button" class="ws-watermark-btn" id="wsWmNew">${T('新建文件')}</button>
          <button type="button" class="ws-watermark-btn" id="wsWmOpenFile">${T('打开文件…')}</button>
          ${this.isDesktop ? T('<button type="button" class="ws-watermark-btn" id="wsWmOpenDir">打开文件夹…</button>') : ''}
        </div>
        <div class="ws-watermark-hint">${this.isDesktop
          ? T('在左侧文件树里单击文件即可打开，<kbd>Ctrl</kbd>+<kbd>S</kbd> 写回原文件')
          : T('拖入或打开本地文件即可开始；网页版的保存是下载一份副本')}</div>`;
      mark.querySelector('.ws-watermark-icon').appendChild(makeIcon('doc', null, 'ws-svg-watermark'));
      mark.querySelector('#wsWmNew').onclick = () => this.newTab();
      mark.querySelector('#wsWmOpenFile').onclick = () => this.openFileDialog();
      const dirBtn = mark.querySelector('#wsWmOpenDir');
      if (dirBtn) dirBtn.onclick = () => this.openFolderDialog();
      wrapper.appendChild(mark);
    }

    // ---- 收起 / 展开侧栏 ------------------------------------------------------

    /**
     * 折叠左侧文件树。编辑的时候横向空间经常不够用，而文件树多数时候只是"偶尔
     * 瞟一眼"——收起来留一条窄轨道，比每次去拖宽度方便。
     */
    toggleCollapsed(next) {
      if (!this.isDesktop) return false;
      this.collapsed = typeof next === 'boolean' ? next : !this.collapsed;
      this._writeFlag(COLLAPSED_KEY, this.collapsed);
      this._applyCollapsed();
      return this.collapsed;
    }

    _applyCollapsed() {
      const panel = document.getElementById('workspacePanel');
      if (!panel) return;
      const collapsed = this.collapsed;
      panel.classList.toggle('is-collapsed', collapsed);
      const resizer = document.querySelector('.ws-resizer');
      if (resizer) resizer.hidden = collapsed;
      if (collapsed) {
        // 记住折叠前的宽度，展开时回到原样，而不是回到默认值。
        const w = parseInt(panel.style.flexBasis, 10)
          || Math.round(panel.getBoundingClientRect().width);
        if (w > WIDTH_MIN) this._widthBeforeCollapse = w;
        panel.style.flexBasis = `${RAIL_W}px`;
      } else if (this._widthBeforeCollapse) {
        panel.style.flexBasis = `${this._widthBeforeCollapse}px`;
      }
    }

    // ---- 全局快捷键 ----------------------------------------------------------

    _onGlobalKey(e) {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.altKey) return;
      const key = (e.key || '').toLowerCase();
      if (key === 'w') {
        // 桌面版由这里接管；网页版里 Ctrl+W 归浏览器管（页面收不到），中键仍然可用。
        e.preventDefault();
        this.closeTab(this.active);
        return;
      }
      // Ctrl+B 在编辑区里是加粗（洛谷的快捷键），所以只有焦点不在编辑区时才当
      // "收起侧栏"用，免得不小心把用户的加粗习惯改掉。
      if (key === 'b' && this.isDesktop) {
        if (document.activeElement === document.getElementById('editorTextarea')) return;
        e.preventDefault();
        this.toggleCollapsed();
      }
    }

    // ---- 拖进来的文件（桌面版） ------------------------------------------------

    /** 拖到窗口上时的提示层：OS 的拖放没有 HTML5 的 dragover，得自己报个数。 */
    _buildDropHint(pane) {
      const hint = document.createElement('div');
      hint.id = 'wsDropHint';
      hint.className = 'ws-drop-hint';
      hint.hidden = true;
      hint.innerHTML = T('<div class="ws-drop-hint-box">松开即可打开</div>');
      pane.appendChild(hint);
    }

    _showDropHint(on) {
      const hint = document.getElementById('wsDropHint');
      if (hint) hint.hidden = !on;
    }

    /**
     * 桌面版接管 OS 的文件拖放。
     *
     * 为什么不用 HTML5 的 drop：WebView 只给内容（File 对象），不给路径——`.path` 是
     * Electron 才有的东西。于是拖进来的文件在面板里是一份"没有出处"的文档，Ctrl+S
     * 只能另存为，这正是用户报的那个问题。Tauri 的原生事件直接给绝对路径，拖进来的
     * 文件就和从文件树打开的一样：能写回、进最近打开、标题带路径。
     *
     * 代价写在 tauri.conf.json 的 dragDropEnabled 旁边：Windows 上 WebView 里的 HTML5
     * 拖放会被原生处理器顶掉，所以文件树内部的拖动改用指针事件（见 _pressRow）。
     */
    async _bindNativeDrop() {
      if (!this.isDesktop) return;
      const t = global.__TAURI__;
      if (!t) return;
      const onEvent = (ev) => {
        const payload = ev && ev.payload ? ev.payload : ev;
        if (!payload) return;
        const type = payload.type || 'drop';
        if (type === 'enter' || type === 'over') { this._showDropHint(true); return; }
        if (type === 'leave') { this._showDropHint(false); return; }
        if (type !== 'drop') return;
        this._showDropHint(false);
        const paths = (payload.paths || []).filter((x) => typeof x === 'string' && x);
        if (paths.length) this._openDroppedPaths(paths);
      };
      const routes = [
        () => t.webviewWindow && t.webviewWindow.getCurrentWebviewWindow
          && t.webviewWindow.getCurrentWebviewWindow().onDragDropEvent(onEvent),
        () => t.webview && t.webview.getCurrentWebview
          && t.webview.getCurrentWebview().onDragDropEvent(onEvent),
        () => t.event && t.event.listen && t.event.listen('tauri://drag-drop', (e) => onEvent({
          payload: { type: 'drop', paths: (e && e.payload && e.payload.paths) || [] },
        })),
      ];
      for (const route of routes) {
        try {
          const un = await route();
          if (typeof un === 'function') {
            this.nativeDrop = true;
            this._dropUnlisten = un;
            return;
          }
        } catch (e) { /* 换下一条路 */ }
      }
    }

    /** 拖进来的东西：文件开成标签页，文件夹问一句要不要当工作目录。 */
    async _openDroppedPaths(paths) {
      const list = paths.slice(0, MAX_DROP);
      if (paths.length > list.length) {
        this._toast(T('一次最多打开 {a} 个，其余的已忽略', { a: MAX_DROP }), 'info');
      }
      let opened = 0;
      for (const path of list) {
        const name = baseName(path);
        const kind = classifyFile(name);
        // 先看扩展名，再探目录。反过来（拿 readDir 当第一判据）会让"readDir 不报错"
        // 的宿主把每个文件都当成文件夹——探针只能证真，不能证伪。
        const isDir = kind === 'text' ? await this._isDirPath(path) : false;
        if (isDir) {
          const ok = !this.rootPath || await this.fs.confirm(
            T('把左侧的工作目录换成「{a}」吗？', { a: name }),
            { title: T('打开文件夹'), okLabel: T('打开'), cancelLabel: T('取消') },
          );
          if (ok) { await this.setRoot(path); opened += 1; }
          continue;
        }
        if (kind === 'binary') {
          this._toast(T('无法打开「{a}」：不是文本文件', { a: name }), 'error');
          continue;
        }
        await this.openPath(path);
        opened += 1;
      }
      if (!opened) return;
      this._toast(T('已打开 {n} 个项目', { n: opened }), 'success');
    }

    /** 拿 readDir 当"这是不是文件夹"的探针：成功就是文件夹。 */
    async _isDirPath(path) {
      if (!this.fs || !this.fs.readDir) return false;
      try { await this.fs.readDir(path); return true; } catch (e) { return false; }
    }

    _bindResizer(panel, handle) {
      let startX = 0;
      let startW = 0;
      const onMove = (e) => {
        const w = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, startW + (e.clientX - startX)));
        panel.style.flexBasis = `${w}px`;
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.classList.remove('ws-resizing');
        const w = parseInt(panel.style.flexBasis, 10);
        try { global.localStorage && global.localStorage.setItem(WIDTH_KEY, String(w)); } catch (e) { /* ignore */ }
      };
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        startX = e.clientX;
        startW = panel.getBoundingClientRect().width;
        document.body.classList.add('ws-resizing');
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
      handle.addEventListener('dblclick', () => {
        panel.style.flexBasis = `${WIDTH_DEFAULT}px`;
        try { global.localStorage && global.localStorage.setItem(WIDTH_KEY, String(WIDTH_DEFAULT)); } catch (e) { /* ignore */ }
      });
    }

    renderTabs() {
      const bar = document.getElementById('workspaceTabs');
      if (!bar) return;
      bar.textContent = '';
      this.docs.forEach((d, i) => {
        const el = document.createElement('div');
        el.className = 'ws-tab' + (i === this.active ? ' is-active' : '')
          + (d.dirty ? ' is-dirty' : '');
        el.setAttribute('data-tab-index', String(i));
        el.title = d.path || d.name;
        const label = document.createElement('span');
        label.className = 'ws-tab-name';
        label.textContent = d.name;
        el.appendChild(label);
        // The dot doubles as the close button, the way most editors do it.
        const close = document.createElement('button');
        close.className = 'ws-tab-close';
        close.setAttribute('aria-label', T('关闭'));
        close.textContent = d.dirty ? '●' : '×';
        close.onclick = (e) => { e.stopPropagation(); this.closeTab(i); };
        el.appendChild(close);
        el.onclick = () => this.activate(i);
        // 中键关闭：浏览器和 VS Code 的老规矩。mousedown 那一下的 preventDefault
        // 是为了挡掉 Linux 上中键默认的"自动滚动"。
        el.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); });
        el.addEventListener('auxclick', (ev) => { if (ev.button === 1) this.closeTab(i); });
        bar.appendChild(el);
      });
      this._scheduleWebPersist();
    }

    renderRecent() {
      const host = document.getElementById('wsRecent');
      if (!host) return;
      host.textContent = '';
      const list = this._recent();
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty';
        empty.textContent = T('暂无记录');
        host.appendChild(empty);
        return;
      }
      list.forEach((p) => {
        const row = document.createElement('div');
        row.className = 'ws-node';
        row.setAttribute('data-recent', p);
        row.title = p;
        const icon = document.createElement('span');
        icon.className = 'ws-icon';
        const k = kindOf(p);
        icon.appendChild(makeIcon(k.glyph, k.kind, 'ws-svg-file'));
        row.appendChild(icon);
        const name = document.createElement('span');
        name.className = 'ws-node-name';
        name.textContent = baseName(p);
        row.appendChild(name);
        row.onclick = () => this.openPath(p);
        host.appendChild(row);
      });
    }

    async render() {
      this.renderTabs();
      this.renderRecent();
      // 同步做、不等 renderTree：关掉最后一个标签页时，编辑区应当立刻反应。
      this._applyEmptyState();
      await this.renderTree();
    }

    // ---- recent list ---------------------------------------------------------

    _recent() {
      try {
        const raw = global.localStorage && global.localStorage.getItem(RECENT_KEY);
        const v = raw ? JSON.parse(raw) : [];
        return Array.isArray(v) ? v : [];
      } catch (e) { return []; }
    }

    _pushRecent(path) {
      if (!path) return;
      const list = this._recent().filter((p) => p !== path);
      list.unshift(path);
      try {
        global.localStorage
          && global.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
      } catch (e) { /* storage full or blocked; the list is a convenience only */ }
      this.renderRecent();
    }

    _toast(msg, kind) {
      if (this.editor && this.editor.showToast) this.editor.showToast(msg, kind);
    }
  }

  global.LuoguWorkspace = LuoguWorkspace;
  global.LuoguWorkspace.detectHost = detectHost;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LuoguWorkspace, detectHost };
  }
})(typeof window !== 'undefined' ? window : globalThis);
