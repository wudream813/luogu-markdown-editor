// Inserting from the no-document state must create a real, editable draft.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (ok, name) => { console.log(ok ? '✅' : '❌', name); ok ? pass++ : fail++; };
  const APP = process.argv[2] || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  for (const desktop of [false, true]) {
    const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    if (desktop) await p.addInitScript(() => {
      window.__files = {};
      window.__TAURI__ = {
        fs: { readTextFile: async p => window.__files[p] || '', writeTextFile: async (p,c) => { window.__files[p] = c; },
          readDir: async () => [], exists: async () => false, mkdir: async () => {}, rename: async () => {}, remove: async () => {} },
        dialog: { open: async () => null, save: async () => '/draft.md', confirm: async () => true }
      };
    });
    await p.goto(APP, { waitUntil: 'networkidle' });
    await p.evaluate(() => { LuoguI18n.setLang('zh'); LuoguEditor.workspace.setAutosaveInterval(500); });
    const empty = async () => {
      await p.evaluate(async () => {
        const ws = LuoguEditor.workspace;
        ws._askUnsaved = async () => 'discard';
        while (ws.docs.length) await ws.closeTab(0);
      });
      ck(await p.evaluate(() => !LuoguEditor.workspace.docs.length && !document.getElementById('wsWatermark').hidden), '关闭全部标签后保留空状态');
    };
    const valid = async selector => {
      ck(await p.evaluate(() => {
        const ws = LuoguEditor.workspace, d = ws.docs[ws.active];
        return ws.docs.length === 1 && d.path === null && d.dirty && d.content === LuoguEditor.getContent()
          && !document.getElementById('editorTextarea').readOnly && document.getElementById('wsWatermark').hidden;
      }), '插入自动创建且同步唯一未命名草稿，解除只读与遮罩');
      ck(await p.locator('#previewContent ' + selector).first().isVisible(), '立即显示真实渲染预览：' + selector);
    };
    await empty();
    await p.click('[onclick="LuoguEditor.insertBold()"]');
    await valid('strong');
    await p.evaluate(() => LuoguEditor.undo());
    ck(await p.evaluate(() => LuoguEditor.getContent() === '' && LuoguEditor.workspace.docs.length === 1), '一次撤销回到空草稿，不恢复已关闭文档');
    await p.evaluate(() => LuoguEditor.redo());
    await valid('strong');
    await p.click('[onclick="LuoguEditor.insertMathBlock()"]');
    await valid('.katex');
    await p.evaluate(() => { LuoguEditor.workspace.newTab(); LuoguEditor.workspace.activate(0); });
    ck(await p.locator('#previewContent .katex').count() > 0, '切走再切回不丢插入内容');
    if (desktop) {
      await p.evaluate(() => LuoguEditor.workspace.saveActive());
      ck(await p.evaluate(() => window.__files['/draft.md'] && window.__files['/draft.md'].includes('sum')), '新草稿可另存为真实文件');
    } else {
      await p.waitForTimeout(1000);
      await p.reload({ waitUntil: 'networkidle' });
      ck(await p.locator('#previewContent .katex').count() > 0, '网页版自动保存后刷新能恢复插入内容');
      await p.evaluate(() => LuoguI18n.setLang('zh'));
    }
    await empty();
    await p.click('[onclick="LuoguEditor.openModal(\'codeModal\')"]');
    ck(await p.evaluate(() => LuoguEditor.workspace.docs.length === 0), '打开插入面板不提前创建草稿');
    await p.click('#codeModal .modal-footer .btn:not(.btn-primary)');
    ck(await p.evaluate(() => LuoguEditor.workspace.docs.length === 0), '取消插入不创建草稿');
    await p.click('[onclick="LuoguEditor.openModal(\'codeModal\')"]');
    await p.click('#codeModal .modal-footer .btn-primary');
    await valid('pre code');
    for (const [method, selector] of [['insertUnorderedList', 'ul'], ['insertHR', 'hr'], ['insertMathInline', '.katex']]) {
      await empty();
      await p.click(`[onclick="LuoguEditor.${method}()"]`);
      await valid(selector);
    }
    for (const lang of ['zh', 'en']) {
      await empty();
      await p.evaluate(lang => { LuoguI18n.setLang(lang); LuoguEditor.insertCallout('info', 'Title', true); }, lang);
      await valid('details');
      ck(await p.evaluate(() => !LuoguEditor.getContent().includes('\\n') && LuoguEditor.getContent().startsWith('\n\n::::info')),
        lang + ' 折叠框插入真实换行，而非字面量反斜杠 n');
      await empty();
      await p.evaluate(() => LuoguEditor.insertEpigraph('Author', 'First line\nSecond line'));
      await valid('.luogu-epigraph');
      ck(await p.evaluate(() => !LuoguEditor.getContent().includes('\\n') && LuoguEditor.getContent().includes('First line\nSecond line')),
        lang + ' 引言保留真实多行并正确渲染');
    }
    await p.evaluate(() => LuoguI18n.setLang('zh'));
    await empty();
    await p.evaluate(() => { LuoguEditor.setViewMode('typora'); LuoguEditor.insertHeading(2); });
    await valid('h2');
    await empty();
    p.once('dialog', d => d.dismiss());
    await p.evaluate(() => LuoguEditor.insertTemplate('article'));
    ck(await p.evaluate(() => LuoguEditor.workspace.docs.length === 0), '取消模板确认也不创建草稿');
    p.once('dialog', d => d.accept());
    await p.evaluate(() => LuoguEditor.insertTemplate('article'));
    await valid('h1');
    ck(errors.length === 0, (desktop ? '桌面' : '网页') + '全程无 JS 报错：' + errors.join(';'));
    await p.close();
  }
  console.log(`空状态插入 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
