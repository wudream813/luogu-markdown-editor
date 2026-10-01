/**
 * Workspace panel: document tabs + folder tree.
 *
 * The panel is desktop-only, but it ships inside the same HTML the browser build
 * uses, so two things have to hold: it must stay completely invisible in a plain
 * browser, and it must work when a native filesystem is present.
 *
 * The native side is stubbed here rather than driven through a real Tauri build —
 * that keeps the DOM and document-model logic under test without a Rust toolchain,
 * and it is exactly why LuoguWorkspace takes its filesystem as a parameter.
 */
const path = require('path');
const { chromium } = require('playwright');

// A fake disk: a flat map of path -> contents, plus a directory listing.
const FAKE_FS = `{
  files: {
    '/proj/a.md': '# 文件 A\\n\\n内容 A。',
    '/proj/b.md': '# 文件 B\\n\\n内容 B。',
    '/proj/sub/c.md': '# 文件 C\\n\\n内容 C。'
  },
  dirs: {
    '/proj': [
      { name: 'sub', isDirectory: true, path: '/proj/sub' },
      { name: 'a.md', isDirectory: false, path: '/proj/a.md' },
      { name: 'b.md', isDirectory: false, path: '/proj/b.md' },
      { name: '.hidden', isDirectory: false, path: '/proj/.hidden' }
    ],
    '/proj/sub': [
      { name: 'c.md', isDirectory: false, path: '/proj/sub/c.md' }
    ]
  },
  log: []
}`;

(async () => {
  const APP = process.argv[2]
    || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };
  // 关一个脏标签页会弹出三选一对话框（保存 / 不保存 / 取消）。测试要像人一样点它，
  // 而不是指望某个全局开关——对话框本身就是被测对象之一。
  const answerUnsaved = async (page, act) => {
    await page.waitForSelector('.ws-ask', { timeout: 5000 });
    await page.click(`.ws-ask-btn[data-act="${act}"]`);
    await page.waitForTimeout(300);
  };
  const drainUnsaved = async (page, act) => {
    for (let i = 0; i < 25; i += 1) {
      if (!(await page.evaluate(() => !!document.querySelector('.ws-ask')))) return;
      await answerUnsaved(page, act);
    }
  };

  // ---- 1. plain browser: tabs, but no file tree ------------------------------
  {
    const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(APP, { waitUntil: 'networkidle' });
    // 界面语言默认跟随系统（CI 的浏览器报 en-US），而这些用例断言的是中文 UI：
    // 每次导航后把语言钉回中文，用例只测行为、不测语言。
    await p.evaluate(()=>{if(window.LuoguI18n)LuoguI18n.setLang('zh');});
    await p.waitForTimeout(800);
    ck(await p.evaluate(() => !document.getElementById('workspacePanel')),
      '普通浏览器下不创建文件树面板（网页版读不到本地目录）');
    ck(await p.evaluate(() => !document.documentElement.classList.contains('ws-desktop')),
      '未加 ws-desktop 类');
    ck(await p.evaluate(() => document.documentElement.classList.contains('has-workspace')),
      '但标签页是有的（多标签在网页版同样可用）');
    ck(await p.evaluate(() => typeof LuoguEditor.workspace === 'object'
      && LuoguEditor.workspace.mode === 'web'), '挂载了网页版形态的 workspace');
    ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 1),
      '网页版初始也有一个标签页');
    // 多标签：新建 + 中键关闭
    await p.evaluate(() => LuoguEditor.workspace.newTab());
    await p.waitForTimeout(300);
    ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 2),
      '网页版可以新建标签页');
    await p.click('.ws-tab:nth-child(2)', { button: 'middle' });
    await p.waitForTimeout(300);
    ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 1),
      '网页版标签页中键可以关闭');

    // 网页版没有磁盘，标签页只能自己记着：写完刷新，两份都该还在。
    await p.evaluate(() => LuoguEditor.workspace.newTab());
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const ta = document.getElementById('editorTextarea');
      ta.value = '# 第二份草稿\n\n刷新之后还应该在。\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await p.waitForTimeout(3000);   // 等默认 2.5 秒自动保存（含预览防抖）
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(900);
    ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 2),
      '网页版刷新之后标签页还在');
    ck(await p.evaluate(() => [...document.querySelectorAll('.ws-tab-name')]
      .some((el) => el.textContent === '未命名.md')), '未命名的那份也在');
    ck(await p.evaluate(() => [...document.querySelectorAll('.ws-tab-name')]
      .some((el) => el.textContent.includes('草稿')) || LuoguEditor.workspace.docs
        .some((d) => d.content.includes('刷新之后还应该在'))),
      '标签页内容一并恢复');

    // 网页版 Ctrl+S：没有磁盘，走编辑器自己的下载 / 句柄那条路，不能崩
    await p.evaluate(() => {
      const ws = LuoguEditor.workspace;
      ws.newTab();
    });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const ta = document.getElementById('editorTextarea');
      ta.value = '# 要保存的东西\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    });
    await p.keyboard.press('Control+s');
    await p.waitForTimeout(600);
    ck(await p.evaluate(() => LuoguEditor.workspace.docs[LuoguEditor.workspace.active].dirty === false),
      '网页版 Ctrl+S 走的是编辑器自己的保存（下载 / 句柄），不报错也不卡住');
    ck(errs.length === 0, '网页版无报错', errs.slice(0, 2).join(' | '));
    await p.close();
  }

  // ---- 2. with a native filesystem: the panel works --------------------------
  const p = await b.newPage({ viewport: { width: 1400, height: 860 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  // Install the stub before any script runs, so detectHost() sees it at startup.
  await p.addInitScript(`
    window.__FAKE = ${FAKE_FS};
    const F = window.__FAKE;
    window.__TAURI__ = {
      fs: {
        readTextFile: async (p) => {
          F.log.push('read:' + p);
          if (!(p in F.files)) throw new Error('ENOENT ' + p);
          return F.files[p];
        },
        writeTextFile: async (p, c) => { F.log.push('write:' + p); F.files[p] = c; },
        readDir: async (p) => { F.log.push('readdir:' + p); return F.dirs[p] || []; }
      },
      dialog: {
        open: async (o) => (o && o.directory ? window.__PICK_DIR : window.__PICK_FILE),
        save: async () => window.__PICK_SAVE,
        confirm: async () => window.__CONFIRM !== false
      }
    };
  `);
  await p.goto(APP, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);

  ck(await p.evaluate(() => !!document.getElementById('workspacePanel')),
    '检测到原生文件系统后出现面板');
  ck(await p.evaluate(() => document.documentElement.classList.contains('has-workspace')),
    '加上 has-workspace 类');
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 1),
    '初始有一个标签页（承接当前草稿）');

  // Open a folder.
  await p.evaluate(() => { window.__PICK_DIR = '/proj'; });
  await p.evaluate(() => LuoguEditor.workspace.openFolderDialog());
  await p.waitForTimeout(500);
  const tree = await p.evaluate(() =>
    [...document.querySelectorAll('#wsTree .ws-node')].map((n) => n.textContent.replace(/^[▾▸·]/, '')));
  ck(tree.length === 4 && tree.includes('sub') && tree.includes('a.md'),
    '展开文件夹列出内容', JSON.stringify(tree));
  ck(!tree.some((t) => t.includes('.hidden')), '隐藏以点开头的文件', JSON.stringify(tree));
  ck(tree[1] === 'sub', '目录排在文件之前', JSON.stringify(tree));

  // Open a file by clicking it.
  await p.evaluate(() => {
    [...document.querySelectorAll('#wsTree .ws-node')]
      .find((n) => n.getAttribute('data-path') === '/proj/a.md').click();
  });
  await p.waitForTimeout(500);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 2),
    '点击文件新开一个标签页');
  ck(await p.evaluate(() => document.getElementById('editorTextarea').value.includes('内容 A')),
    '文件内容载入编辑区');

  // Opening the same path again must focus the existing tab, not duplicate it.
  await p.evaluate(() => LuoguEditor.workspace.openPath('/proj/a.md'));
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 2),
    '重复打开同一文件不新建标签页');

  // Expand a subfolder.
  await p.evaluate(() => {
    [...document.querySelectorAll('#wsTree .ws-node')]
      .find((n) => n.getAttribute('data-path') === '/proj/sub').click();
  });
  await p.waitForTimeout(400);
  ck(await p.evaluate(() =>
    [...document.querySelectorAll('#wsTree .ws-node')].some((n) => n.getAttribute('data-path') === '/proj/sub/c.md')),
    '展开子目录');

  // Switching tabs must preserve each document's own text.
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 文件 A\n\n被我改过了。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => !!document.querySelector('.ws-tab.is-dirty')),
    '修改后标签页标记为未保存');
  await p.evaluate(() => LuoguEditor.workspace.activate(0));
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => !document.getElementById('editorTextarea').value.includes('被我改过了')),
    '切到别的标签页显示各自内容');
  await p.evaluate(() => LuoguEditor.workspace.activate(1));
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.getElementById('editorTextarea').value.includes('被我改过了')),
    '切回来仍保留未保存的修改');

  // Save writes through to the fake disk and clears the dirty flag.
  await p.evaluate(() => LuoguEditor.workspace.saveActive());
  await p.waitForTimeout(500);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/a.md'].includes('被我改过了')),
    '保存写回原文件');
  ck(await p.evaluate(() => !document.querySelector('.ws-tab.is-dirty')),
    '保存后清除未保存标记');

  // Ctrl+S must route through the workspace, not the single-document path.
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '# 文件 A\n\n第二次修改。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
  });
  await p.waitForTimeout(400);
  await p.keyboard.press('Control+s');
  await p.waitForTimeout(600);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/a.md'].includes('第二次修改')),
    'Ctrl+S 保存到当前标签页对应的文件');

  // A new tab has no path, so saving it asks where to put it.
  await p.evaluate(() => { window.__PICK_SAVE = '/proj/new.md'; LuoguEditor.workspace.newTab(); });
  await p.waitForTimeout(400);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '新建的内容。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => LuoguEditor.workspace.saveActive());
  await p.waitForTimeout(500);
  ck(await p.evaluate(() => window.__FAKE.files['/proj/new.md'] === '新建的内容。'),
    '新标签页保存时走另存为');
  ck(await p.evaluate(() =>
    [...document.querySelectorAll('.ws-tab')].some((t) => t.textContent.includes('new.md'))),
    '另存后标签页改用新文件名');

  // Recent list.
  ck(await p.evaluate(() => document.querySelectorAll('#wsRecent .ws-node').length >= 2),
    '最近打开列表有记录');
  ck(await p.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('luogu_editor_recent_files') || '[]');
    return v.includes('/proj/a.md');
  }), '最近列表持久化到 localStorage');

  // Closing a dirty tab asks first — with three answers, not two.
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = '又改了。'; ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.waitForTimeout(300);
  const before = await p.evaluate(() => document.querySelectorAll('.ws-tab').length);
  await p.evaluate(() => { LuoguEditor.workspace.closeTab(LuoguEditor.workspace.active); });
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => !!document.querySelector('.ws-ask')), '关闭未保存的标签页会询问');
  ck(await p.evaluate(() => {
    const acts = [...document.querySelectorAll('.ws-ask-btn')].map((b) => b.getAttribute('data-act'));
    return acts.includes('save') && acts.includes('discard') && acts.includes('cancel');
  }), '对话框提供 保存 / 不保存 / 取消 三个选项');

  await answerUnsaved(p, 'cancel');
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length) === before,
    '选"取消"则保留标签页');

  await p.evaluate(() => { LuoguEditor.workspace.closeTab(LuoguEditor.workspace.active); });
  await answerUnsaved(p, 'discard');
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length) === before - 1,
    '选"不保存"则直接关闭');

  // Closing the last tab is allowed. The editor goes to its empty state instead of
  // silently spawning a blank document; the textarea turns read-only because with no
  // tab there is nowhere for typed text to go.
  await p.evaluate(() => {
    const ws = LuoguEditor.workspace;
    // 不 await：脏文档会弹对话框，等着点，await 会把测试挂死。
    ws._closingAll = (async () => { while (ws.docs.length) await ws.closeTab(0); })();
  });
  await drainUnsaved(p, 'discard');
  await p.evaluate(() => LuoguEditor.workspace._closingAll);
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 0),
    '可以关掉所有标签页（不自动补空白页）');
  ck(await p.evaluate(() => !document.getElementById('wsWatermark').hidden),
    '没有标签页时显示空状态引导');
  ck(await p.evaluate(() => document.getElementById('editorTextarea').readOnly === true),
    '没有标签页时编辑区只读（打了字无处可存）');
  ck(await p.evaluate(() => document.documentElement.classList.contains('ws-no-docs')),
    '空状态类名已挂上');

  await p.evaluate(() => LuoguEditor.workspace.newTab());
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length === 1),
    '空状态下新建标签页即可恢复');
  ck(await p.evaluate(() => document.getElementById('editorTextarea').readOnly === false
    && document.getElementById('wsWatermark').hidden),
    '恢复标签页后编辑区可写、引导消失');

  // Concurrent renders must not duplicate the tree. renderTree() awaits a readDir
  // per level; two overlapping calls each cleared the host and then both appended,
  // so the whole tree appeared several times over.
  await p.evaluate(async () => {
    const ws = LuoguEditor.workspace;
    await ws.setRoot('/proj');
    ws.treeState['/proj/sub'] = true;
    // Fire several without awaiting in between — the interleaving is the point.
    ws.renderTree(); ws.renderTree(); ws.renderTree();
    await ws.renderTree();
  });
  await p.waitForTimeout(600);
  const paths = await p.evaluate(() =>
    [...document.querySelectorAll('#wsTree .ws-node')].map((n) => n.getAttribute('data-path')));
  ck(paths.length === new Set(paths).size, '并发渲染不会让文件树重复',
    JSON.stringify(paths));
  ck(paths.length === 5, '树结构正确（根 + sub + c.md + a.md + b.md）', JSON.stringify(paths));

  // ---- 折叠侧栏 --------------------------------------------------------------
  const panelWidth = () => p.evaluate(() => Math.round(
    document.getElementById('workspacePanel').getBoundingClientRect().width));
  const wideBefore = await panelWidth();
  await p.click('#wsCollapse');
  await p.waitForTimeout(400);
  const narrow = await panelWidth();
  ck(narrow < wideBefore && narrow <= 40, '收起后侧栏只剩一条窄轨道', `${wideBefore} -> ${narrow}`);
  ck(await p.evaluate(() => document.getElementById('workspacePanel').classList.contains('is-collapsed')),
    '面板带上 is-collapsed 类');
  ck(await p.evaluate(() => getComputedStyle(document.getElementById('wsTree')).display === 'none'),
    '收起后文件树不再显示');
  ck(await p.evaluate(() => getComputedStyle(document.getElementById('wsExpand').closest('.ws-rail')).display !== 'none'),
    '轨道上的展开按钮可见');
  ck(await p.evaluate(() => document.querySelector('.ws-resizer').hidden === true),
    '收起后拖宽度的把手一并隐藏');
  await p.click('#wsExpand');
  await p.waitForTimeout(400);
  ck(await panelWidth() === wideBefore, '展开后回到原来的宽度', String(await panelWidth()));
  ck(await p.evaluate(() => getComputedStyle(document.getElementById('wsTree')).display !== 'none'),
    '展开后文件树回来了');

  // 折叠状态要记住
  await p.click('#wsCollapse');
  await p.waitForTimeout(300);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  ck(await p.evaluate(() => document.getElementById('workspacePanel').classList.contains('is-collapsed')),
    '重开还是收起状态（记住上次的样子）');
  await p.click('#wsExpand');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => !document.getElementById('workspacePanel').classList.contains('is-collapsed')),
    '点展开就恢复');

  // Ctrl+B 也能收（焦点不在编辑区时）
  await p.evaluate(() => document.getElementById('wsTree').focus());
  await p.keyboard.press('Control+b');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => document.getElementById('workspacePanel').classList.contains('is-collapsed')),
    'Ctrl+B 收起侧栏');
  await p.keyboard.press('Control+b');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => !document.getElementById('workspacePanel').classList.contains('is-collapsed')),
    '再按一次 Ctrl+B 展开');

  // Ctrl+W 关标签页
  const tabsBeforeW = await p.evaluate(() => document.querySelectorAll('.ws-tab').length);
  await p.evaluate(() => LuoguEditor.workspace.newTab());
  await p.waitForTimeout(300);
  await p.evaluate(() => document.getElementById('editorTextarea').focus());
  await p.keyboard.press('Control+w');
  await p.waitForTimeout(400);
  ck(await p.evaluate(() => document.querySelectorAll('.ws-tab').length) === tabsBeforeW,
    'Ctrl+W 关闭当前标签页');

  ck(errs.length === 0, '桌面模式无 JS 报错', errs.slice(0, 3).join(' | '));
  console.log(`\n工作区面板 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
