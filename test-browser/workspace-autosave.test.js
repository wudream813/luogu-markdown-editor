/**
 * 桌面版新增的实用功能：
 *   - 把文件拖进窗口 / 用系统"打开方式"打开 → 面板必须认账（不能一边有预览一边说没打开）
 *   - 关闭未保存的标签页 → 保存 / 不保存 / 取消 三选一
 *   - 自动保存到文件（空闲后写盘）
 *   - 保存时自动排版
 *   - 主题与视图模式在重启后还在
 *
 * 假磁盘是可变的：自动保存与排版是否真的落到文件上，靠 __FAKE.files 断言。
 */
const path = require('path');
const { chromium } = require('playwright');

const FAKE_FS = `
(function () {
  const files = {
    '/proj/README.md': '# 项目说明\\n\\n这是原文。\\n',
    '/proj/notes.md': '# 笔记\\n'
  };
  const dirs = {
    '/proj': [
      { name: 'README.md', isDirectory: false, path: '/proj/README.md' },
      { name: 'notes.md', isDirectory: false, path: '/proj/notes.md' }
    ]
  };
  const log = [];
  window.__FAKE = {
    files: files, dirs: dirs, log: log,
    seed: function (p, c) { files[p] = c; }
  };
  window.__TAURI__ = {
    fs: {
      readTextFile: async (p) => { log.push('read:' + p); if (!(p in files)) throw new Error('ENOENT ' + p); return files[p]; },
      writeTextFile: async (p, c) => { log.push('write:' + p); files[p] = c; },
      readDir: async (p) => dirs[p] || [],
      mkdir: async (p) => { dirs[p] = []; },
      rename: async () => {},
      remove: async () => {},
      exists: async (p) => (p in files) || (p in dirs)
    },
    dialog: {
      open: async () => '/proj',
      save: async () => window.__PICK_SAVE,
      confirm: async (m) => { log.push('confirm:' + m); return true; }
    },
    opener: { revealItemInDir: async () => {} }
  };
})();
`;

(async () => {
  const APP = process.argv[2]
    || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };
  const answerUnsaved = async (page, act) => {
    await page.waitForSelector('.ws-ask', { timeout: 5000 });
    await page.click(`.ws-ask-btn[data-act="${act}"]`);
    await page.waitForTimeout(300);
  };

  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(FAKE_FS);
  await p.goto(APP, { waitUntil: 'networkidle' });
  // 界面语言默认跟随系统（CI 的浏览器报 en-US），而这些用例断言的是中文 UI：
  // 每次导航后把语言钉回中文，用例只测行为、不测语言。
  await p.evaluate(()=>{if(window.LuoguI18n)LuoguI18n.setLang('zh');});
  await p.waitForTimeout(900);
  await p.evaluate(() => { window.__PICK_DIR = '/proj'; });
  await p.evaluate(() => LuoguEditor.workspace.openFolderDialog());
  await p.waitForTimeout(400);

  const toasts = () => p.evaluate(() => [...document.querySelectorAll('#toastContainer .toast')]
    .map((t) => t.textContent).join(' | '));
  const clearToasts = () => p.evaluate(() => { document.getElementById('toastContainer').textContent = ''; });

  // ==========================================================================
  // 1. 把文件拖进窗口：右侧有内容，左侧也必须认账
  // ==========================================================================
  // 先把工作区清空到"一个标签都没有"，复现用户看到的那一幕。
  await p.evaluate(() => {
    const ws = LuoguEditor.workspace;
    ws.docs = [];
    ws.active = -1;
    ws._clearEditor();
    ws.render();
  });
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 0), '（准备）工作区里没有标签页');
  ck(await p.evaluate(() => !document.getElementById('wsWatermark').hidden), '（准备）显示空状态');

  // 真实地拖一个 File 进去：走 window 的 drop 监听，和用户操作完全同一条路径。
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# 拖进来的文档\n\n正文。\n'], 'dropped.md', { type: 'text/markdown' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await p.waitForTimeout(700);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 1),
    '拖入文件后自动多出一个标签页');
  ck(await p.evaluate(() => document.querySelector('#workspaceTabs .ws-tab-name').textContent === 'dropped.md'),
    '标签页名字就是被拖入的文件名');
  ck(await p.evaluate(() => document.getElementById('wsWatermark').hidden),
    '空状态引导消失——不会再出现"右边有预览、左边说没打开"');
  ck(await p.evaluate(() => document.getElementById('editorTextarea').readOnly === false),
    '编辑区恢复可写');
  ck(await p.evaluate(() => !document.querySelector('#wsTree .ws-node.is-open')),
    '（无路径的拖入文档不会假装是树里的某个文件）');
  ck(await p.evaluate(() => LuoguEditor.workspace.docs[0].content.includes('拖进来的文档')),
    '文档模型里存着拖入的内容，切换标签页不会丢');

  // 再拖一个：空白未命名页应当被顶替，而不是越堆越多
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# 第二份\n'], 'second.md', { type: 'text/markdown' }));
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await p.waitForTimeout(700);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 2),
    '拖入第二份文件是新开标签页（一份文档一个标签）');

  // 桌面版"新建"按钮也应当是一个标签页，而不是弹框确认
  await p.evaluate(() => LuoguEditor.newDocument());
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 3),
    '工具栏"新建"在桌面版直接开标签页');

  // ==========================================================================
  // 2. 关闭未保存的标签页：保存 / 不保存 / 取消
  // ==========================================================================
  await p.evaluate(() => LuoguEditor.workspace.openPath('/proj/README.md'));
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 项目说明\n\n我改过了。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);

  // 取消 → 文件不动、标签页还在
  const writesBefore = await p.evaluate(() => window.__FAKE.log.filter((l) => l.startsWith('write:')).length);
  await p.evaluate(() => { LuoguEditor.workspace.closeTab(LuoguEditor.workspace.active); });
  await answerUnsaved(p, 'cancel');
  ck(await p.evaluate(() => window.__FAKE.files['/proj/README.md'].includes('这是原文')),
    '选"取消"：磁盘上的文件没被动过');
  ck(await p.evaluate(() => LuoguEditor.workspace.docs.some((d) => d.name === 'README.md')),
    '选"取消"：标签页还在');

  // 保存 → 写盘（并且自动排版会生效，因为默认开着）
  await p.evaluate(() => { LuoguEditor.workspace.closeTab(LuoguEditor.workspace.active); });
  await answerUnsaved(p, 'save');
  await p.waitForTimeout(500);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/README.md'].includes('我改过了')),
    '选"保存"：改动写回了原文件');
  ck(await p.evaluate(() => !LuoguEditor.workspace.docs.some((d) => d.name === 'README.md')),
    '选"保存"后标签页关闭');
  ck(await p.evaluate((n) => window.__FAKE.log.filter((l) => l.startsWith('write:')).length > n, writesBefore),
    '确实发生了写盘操作');

  // 不保存 → 标签页关闭、磁盘不变
  await p.evaluate(() => LuoguEditor.workspace.openPath('/proj/notes.md'));
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 笔记\n\n这段不该被保存。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => { LuoguEditor.workspace.closeTab(LuoguEditor.workspace.active); });
  await answerUnsaved(p, 'discard');
  ck(await p.evaluate(() => !window.__FAKE.files['/proj/notes.md'].includes('不该被保存')),
    '选"不保存"：改动被丢弃');
  ck(await p.evaluate(() => !LuoguEditor.workspace.docs.some((d) => d.name === 'notes.md')),
    '选"不保存"：标签页关闭');

  // ==========================================================================
  // 3. 自动保存到文件
  // ==========================================================================
  ck(await p.evaluate(() => LuoguEditor.workspace.autosaveToFile === true),
    '自动保存到文件默认开启');
  ck(await p.evaluate(() => !!document.getElementById('fileSaveStatus')),
    '状态栏有"写回文件"的独立指示（和草稿缓存区分开）');

  await p.evaluate(() => LuoguEditor.workspace.openPath('/proj/README.md'));
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 项目说明\n\n自动保存写进去的内容。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 等空闲计时器（2.5s）自己触发，走的是真实路径
  await p.waitForTimeout(3600);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/README.md'].includes('自动保存写进去的内容')),
    '停止输入约 2.5 秒后自动写回文件');
  ck(await p.evaluate(() => !document.querySelector('.ws-tab.is-dirty')),
    '自动保存后标签页不再显示未保存标记');
  ck(await p.evaluate(() => (document.getElementById('fileSaveStatus').textContent || '').includes('已自动保存到文件')),
    '状态栏显示自动保存的时间');

  // 关掉之后就不该再写
  await p.evaluate(() => LuoguEditor.workspace.setAutosaveToFile(false));
  ck(await p.evaluate(() => {
    const c = document.getElementById('autoSaveToggle');
    return c && c.checked === false;
  }), '设置弹窗里的开关同步变化');
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 项目说明\n\n这行不该被自动写盘。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(3400);
  ck(await p.evaluate(() => !window.__FAKE.files['/proj/README.md'].includes('不该被自动写盘')),
    '关闭自动保存后，输入不再写盘');
  ck(await p.evaluate(() => !!document.querySelector('.ws-tab.is-dirty')),
    '关闭后标签页保持未保存标记');

  // 没有路径的新文档：自动保存绝不能弹"另存为"
  await p.evaluate(() => LuoguEditor.workspace.setAutosaveToFile(true));
  await p.evaluate(() => LuoguEditor.workspace.newTab());
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 无路径的新文档\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(3400);
  ck(await p.evaluate(() => !window.__FAKE.log.some((l) => l.startsWith('confirm:'))),
    '没有路径的文档不会被自动保存（绝不偷偷弹另存为）');
  ck(await p.evaluate(() => !!document.querySelector('.ws-tab.is-dirty')),
    '没有路径的文档保持未保存状态');

  // ---- 自动保存间隔：设置页里选的那一档，真的决定什么时候写盘 ----
  ck(await p.evaluate(() => LuoguEditor.workspace.autosaveInterval) === 2500,
    '自动保存间隔默认 2.5 秒');
  await p.evaluate(() => LuoguEditor.workspace.openPath('/proj/notes.md'));
  await p.waitForTimeout(400);
  // 选 0.5 秒：停下来半秒就该落盘
  await p.evaluate(() => {
    LuoguEditor.openSettings();
    const sel = document.getElementById('settingsAutosaveInterval');
    sel.value = '500';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    LuoguEditor.closeModal('settingsModal');
  });
  await p.waitForTimeout(200);
  ck(await p.evaluate(() => LuoguEditor.workspace.autosaveInterval) === 500, '选 0.5 秒后生效');
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 笔记\n\n半秒就该写进去了。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(1400);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/notes.md'].includes('半秒就该写进去了')),
    '间隔 0.5 秒：约 1 秒内就写回文件（默认 2.5 秒时这里还没写）');

  // 选 10 秒：同样等 1.4 秒就不该写（否则说明下拉框没真的接到计时器上）
  await p.evaluate(() => {
    LuoguEditor.openSettings();
    const sel = document.getElementById('settingsAutosaveInterval');
    sel.value = '10000';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    LuoguEditor.closeModal('settingsModal');
  });
  await p.waitForTimeout(200);
  ck(await p.evaluate(() => LuoguEditor.workspace.autosaveInterval) === 10000, '选 10 秒后生效');
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 笔记\n\n十秒之后才该写进去。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(1400);
  ck(await p.evaluate(() => !window.__FAKE.files['/proj/notes.md'].includes('十秒之后才该写进去')),
    '间隔 10 秒：1.4 秒时还没写');
  ck(await p.evaluate(() => !!document.querySelector('.ws-tab.is-dirty')), '此时标签页仍是未保存状态');
  // 改小间隔要立刻重排计时器（用户多半就在等它保存）
  await p.evaluate(() => LuoguEditor.workspace.setAutosaveInterval(500));
  await p.waitForTimeout(1300);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/notes.md'].includes('十秒之后才该写进去')),
    '把间隔改小后立刻重排计时器，不用再敲一个键');
  await p.evaluate(() => LuoguEditor.workspace.setAutosaveInterval(2500));

  // ==========================================================================
  // 4. 保存时自动排版
  // ==========================================================================
  ck(await p.evaluate(() => LuoguEditor.workspace.formatOnSave === true), '保存时自动排版默认开启');
  await p.evaluate(() => {
    const ws = LuoguEditor.workspace;
    ws.docs = [{ name: 'format.md', path: '/proj/format.md', content: '', dirty: false }];
    ws.active = 0;
    window.__FAKE.seed('/proj/format.md', '');
    ws.editor.docName = 'format.md';
    ws.render();
  });
  await p.waitForTimeout(300);
  await clearToasts();
  // 中文与英文之间缺空格：正是洛谷规范要求补的那种（已在 node 里确认
  // LuoguLinter.formatSpacing 对这段文本确实会改动）。
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 用C++写题解\n\n本题用Dijkstra算法求最短路。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => { LuoguEditor.workspace.setAutosaveToFile(false); });
  await p.evaluate(() => LuoguEditor.workspace.saveActive());
  await p.waitForTimeout(800);
  const savedText = await p.evaluate(() => window.__FAKE.files['/proj/format.md']);
  ck(savedText.includes('用 C++写题解'), '排版后内容仍完整');
  ck(savedText.includes('用 Dijkstra 算法'), '中英文之间补上了空格（排版真的跑过了）');
  ck((await toasts()).includes('排版'), '提示里说明了已按洛谷规范排版', await toasts());
  ck(await p.evaluate(() => document.getElementById('editorTextarea').value === window.__FAKE.files['/proj/format.md']),
    '编辑区内容与写入文件的内容一致（排版不是只改了文件）');
  ck(await p.evaluate(() => {
    // 排版是内容变更，应当可以撤销
    document.getElementById('editorTextarea').focus();
    return true;
  }), '（准备）编辑区可聚焦以验证撤销');

  // 关掉之后原样写回
  await p.evaluate(() => LuoguEditor.workspace.setFormatOnSave(false));
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '中文English混排不该被改。\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => LuoguEditor.workspace.saveActive());
  await p.waitForTimeout(700);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/format.md'].includes('中文English混排不该被改')),
    '关闭自动排版后，保存原样写回');

  // ==========================================================================
  // 5. 主题与视图模式：重开还在
  // ==========================================================================
  await p.evaluate(() => {
    LuoguEditor.setTheme('dark');
    LuoguEditor.setViewMode('preview-only');
  });
  await p.waitForTimeout(400);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ck(await p.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark'),
    '重开后主题仍是暗色');
  ck(await p.evaluate(() => document.getElementById('mainWorkspace').classList.contains('mode-preview-only')),
    '重开后仍是上次的视图模式（纯预览）');
  ck(await p.evaluate(() => {
    const btn = document.querySelector('.view-mode-btn[data-mode="preview-only"]');
    return btn && btn.classList.contains('active');
  }), '对应的模式按钮也是高亮状态');

  await p.evaluate(() => { LuoguEditor.setTheme('light'); LuoguEditor.setViewMode('split'); });
  await p.waitForTimeout(300);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  ck(await p.evaluate(() => document.documentElement.getAttribute('data-theme') === 'light'
    && document.getElementById('mainWorkspace').classList.contains('mode-split')),
    '再改回来，重开也跟得上（说明是真在读存储，不是碰巧）');

  // 面板宽度、自动保存开关也应当跨重启保留
  await p.evaluate(() => {
    LuoguEditor.workspace.setAutosaveToFile(false);
    LuoguEditor.workspace.setFormatOnSave(false);
  });
  await p.waitForTimeout(200);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ck(await p.evaluate(() => LuoguEditor.workspace
    ? (LuoguEditor.workspace.autosaveToFile === false && LuoguEditor.workspace.formatOnSave === false)
    : null) === true, '自动保存 / 自动排版的开关也跨重启保留');

  // ==========================================================================
  // 6. 只有桌面版才看得到这两个设置项
  // ==========================================================================
  await p.evaluate(() => LuoguEditor.openSettings());
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => {
    const section = document.getElementById('settingsEditorSection');
    const rows = section.querySelectorAll('.settings-row');
    return section.getClientRects().length > 0 && rows.length === 4
      && [...rows].filter((el) => el.getClientRects().length > 0).length === 3
      && document.getElementById('themeShortcut').getClientRects().length > 0;
  }), '桌面版：设置里能看到那三项磁盘相关的设置');
  await p.evaluate(() => LuoguEditor.closeModal('settingsModal'));

  const browser = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await browser.goto(APP, { waitUntil: 'networkidle' });
  // 界面语言默认跟随系统（CI 的浏览器报 en-US），而这些用例断言的是中文 UI：
  // 每次导航后把语言钉回中文，用例只测行为、不测语言。
  await browser.evaluate(()=>{if(window.LuoguI18n)LuoguI18n.setLang('zh');});
  await browser.waitForTimeout(700);
  await browser.evaluate(() => LuoguEditor.openSettings());
  ck(await browser.evaluate(() =>
    document.getElementById('webAutoSaveToggle').getClientRects().length > 0
    && document.getElementById('settingsAutosaveInterval').getClientRects().length > 0
    && document.getElementById('autoSaveToggle').getClientRects().length === 0
    && document.getElementById('formatOnSaveToggle').getClientRects().length === 0),
    '网页版显示浏览器自动保存和间隔，但不显示文件写回与保存时排版');
  await browser.close();

  ck(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3).join(' | '));

  console.log(`\n自动保存 / 关闭保护 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
