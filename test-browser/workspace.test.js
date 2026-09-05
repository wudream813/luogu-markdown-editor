/**
 * Workspace behaviour: toolbar list inserts, the scroll-sync toggle, and what
 * Ctrl+S does.
 *
 * These came from three real complaints: the toolbar could only insert a *task*
 * list (the plain bullet/numbered buttons were never added even though the
 * functions and shortcuts existed), scrolling could not be un-synced, and saving
 * always re-downloaded a copy instead of writing back to the file that was opened.
 */
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };

  const p = await b.newPage({ viewport: { width: 1100, height: 780 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.waitForTimeout(400);

  const src = () => p.evaluate(() => document.getElementById('editorTextarea').value);

  // ---- toolbar list buttons ---------------------------------------------------
  ck(await p.evaluate(() => !!document.querySelector('[onclick*="insertUnorderedList"]')),
    '工具栏有无序列表按钮');
  ck(await p.evaluate(() => !!document.querySelector('[onclick*="insertOrderedList"]')),
    '工具栏有有序列表按钮');
  ck(await p.evaluate(() => !!document.querySelector('[onclick*="insertTaskList"]')),
    '工具栏有任务列表按钮');

  for (const [fn, re, label] of [
    ['insertUnorderedList', /^\s*[-*+]\s/m, '无序列表'],
    ['insertOrderedList', /^\s*\d+[.)]\s/m, '有序列表'],
    ['insertTaskList', /^\s*[-*+]\s\[[ xX]\]/m, '任务列表'],
  ]) {
    await p.evaluate((f) => {
      const ta = document.getElementById('editorTextarea');
      ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus(); LuoguEditor[f]();
    }, fn);
    await p.waitForTimeout(250);
    ck(re.test(await src()), `点击按钮插入${label}`, JSON.stringify(await src()));
  }

  // ---- scroll sync toggle -----------------------------------------------------
  const LONG = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行内容，用来撑出滚动条。`).join('\n\n');
  await p.evaluate((v) => {
    const ta = document.getElementById('editorTextarea');
    ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
    LuoguEditor.render(); LuoguEditor.setViewMode('split');
  }, LONG);
  await p.waitForTimeout(500);

  const scrollEditorAndRead = async () => {
    await p.evaluate(() => {
      document.getElementById('editorTextarea').scrollTop = 0;
      document.getElementById('previewContent').scrollTop = 0;
    });
    await p.waitForTimeout(300);
    await p.evaluate(() => {
      const ta = document.getElementById('editorTextarea');
      ta.scrollTop = 900; ta.dispatchEvent(new Event('scroll'));
    });
    await p.waitForTimeout(500);
    return p.evaluate(() => document.getElementById('previewContent').scrollTop);
  };

  ck(await p.evaluate(() => !!document.getElementById('scrollSyncBtn')), '存在滚动同步开关');
  ck(await p.evaluate(() => LuoguEditor.scrollSyncEnabled === true), '滚动同步默认开启');
  ck((await scrollEditorAndRead()) > 50, '开启时预览跟随编辑区滚动');

  await p.evaluate(() => LuoguEditor.toggleScrollSync());
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => LuoguEditor.scrollSyncEnabled === false), '可关闭滚动同步');
  ck(await p.evaluate(() => {
    const btn = document.getElementById('scrollSyncBtn');
    return !btn.classList.contains('active') && btn.getAttribute('aria-pressed') === 'false';
  }), '关闭态在按钮上可见');
  ck((await scrollEditorAndRead()) < 5, '关闭后预览不再跟随');

  await p.evaluate(() => LuoguEditor.toggleScrollSync());
  await p.waitForTimeout(250);
  ck((await scrollEditorAndRead()) > 50, '可重新开启');
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_scroll_sync') === '1'),
    '开关状态写入偏好');

  // 重新开启时必须立刻把预览拉到当前位置。此前只是恢复监听，两栏会一直错位到
  // 下一次滚动为止。
  await p.evaluate(() => LuoguEditor.toggleScrollSync(false));
  await p.waitForTimeout(250);
  await p.evaluate(() => {
    document.getElementById('editorTextarea').scrollTop = 0;
    document.getElementById('previewContent').scrollTop = 0;
  });
  await p.waitForTimeout(250);
  await p.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.scrollTop = 1200; ta.dispatchEvent(new Event('scroll'));
  });
  await p.waitForTimeout(400);
  ck((await p.evaluate(() => document.getElementById('previewContent').scrollTop)) < 5,
    '关闭期间预览保持不动');
  await p.evaluate(() => LuoguEditor.toggleScrollSync(true));
  await p.waitForTimeout(600);
  const caughtUp = await p.evaluate(() => Math.round(document.getElementById('previewContent').scrollTop));
  ck(caughtUp > 200, '重新开启后预览立即追上', `previewScrollTop=${caughtUp}`);
  ck(Math.abs((await p.evaluate(() => document.getElementById('editorTextarea').scrollTop)) - 1200) < 60,
    '编辑区位置未被反向拉动');

  // ---- save: write back vs Save As -------------------------------------------
  const save = await p.evaluate(async () => {
    const log = { picker: 0, wrote: [], download: 0 };
    window.showSaveFilePicker = async () => {
      log.picker++;
      return {
        name: 'my.md',
        queryPermission: async () => 'granted',
        createWritable: async () => ({
          write: async (c) => { log.wrote.push(c); }, close: async () => {},
        }),
      };
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { log.download++; };

    LuoguEditor._fileHandle = null;
    LuoguEditor.setContent('# 内容一', false);
    await LuoguEditor.saveMarkdownFile();
    const first = { picker: log.picker, wrote: log.wrote[0], name: LuoguEditor.docName };

    LuoguEditor.setContent('# 内容二', false);
    await LuoguEditor.saveMarkdownFile();
    const second = { picker: log.picker, wrote: log.wrote[1], download: log.download };

    // 新建文档后应重新变成"另存为"
    LuoguEditor._fileHandle = null;
    LuoguEditor.setContent('# 内容三', false);
    await LuoguEditor.saveMarkdownFile();
    const third = { picker: log.picker, wrote: log.wrote[2] };

    HTMLAnchorElement.prototype.click = origClick;
    return { first, second, third };
  });

  ck(save.first.picker === 1, '无关联文件时弹出另存为');
  ck(save.first.wrote === '# 内容一', '另存为写入当前内容', String(save.first.wrote));
  ck(save.first.name === 'my.md', '文档名同步为所选文件名', save.first.name);
  ck(save.second.picker === 1, '已有文件时直接写回，不再弹框', `picker=${save.second.picker}`);
  ck(save.second.wrote === '# 内容二', '写回的是最新内容', String(save.second.wrote));
  ck(save.second.download === 0, '不退化为浏览器下载');
  ck(save.third.picker === 2, '解除关联后重新弹出另存为', `picker=${save.third.picker}`);

  ck(errs.length === 0, '无 JS 报错', errs.join(' | '));
  console.log(`\n工作区 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
