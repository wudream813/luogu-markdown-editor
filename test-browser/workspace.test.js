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

  // ---- 要求 43: 查找 / 替换 -------------------------------------------------------
  {
    const setDoc = async (md) => {
      await p.evaluate((v) => {
        const ta = document.getElementById('editorTextarea');
        ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
        LuoguEditor.render(); LuoguEditor.setViewMode('split');
      }, md);
      await p.evaluate(() => document.getElementById('editorTextarea').focus());
      await p.waitForTimeout(300);
    };
    const cnt = () => p.evaluate(() => document.getElementById('findCount').textContent);
    const open = () => p.evaluate(() => !document.getElementById('findBar').hidden);
    const setFind = async (q, r) => {
      await p.evaluate(([a, bb]) => {
        const fi = document.getElementById('findInput');
        fi.value = a; fi.dispatchEvent(new Event('input', { bubbles: true }));
        if (bb !== null) document.getElementById('replaceInput').value = bb;
      }, [q, r === undefined ? null : r]);
      await p.waitForTimeout(220);
    };
    const setOpt = async (id, on) => {
      await p.evaluate(([i, v]) => {
        const el = document.getElementById(i);
        el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [id, on]);
      await p.waitForTimeout(220);
    };

    await setDoc('alpha beta alpha gamma ALPHA');
    await p.keyboard.press('Control+f');
    await p.waitForTimeout(300);
    ck(await open(), 'Ctrl+F 打开查找栏');
    await setFind('alpha');
    ck((await cnt()) === '1/3', '默认忽略大小写找到 3 处', await cnt());
    await setOpt('findCase', true);
    ck((await cnt()) === '1/2', '区分大小写生效', await cnt());
    await setOpt('findCase', false);

    await p.evaluate(() => LuoguEditor.findNext());
    await p.waitForTimeout(200);
    ck((await cnt()) === '2/3', '下一个');
    await p.evaluate(() => { LuoguEditor.findNext(); LuoguEditor.findNext(); });
    await p.waitForTimeout(200);
    ck((await cnt()) === '1/3', '到末尾后循环回第一个', await cnt());
    await p.evaluate(() => LuoguEditor.findPrev());
    await p.waitForTimeout(200);
    ck((await cnt()) === '3/3', '上一个可反向循环', await cnt());

    ck(await p.evaluate(() => {
      const ta = document.getElementById('editorTextarea');
      return ta.value.slice(ta.selectionStart, ta.selectionEnd).toLowerCase() === 'alpha';
    }), '当前匹配在源码中被选中');

    // 替换
    await setDoc('cat dog cat bird cat');
    await p.evaluate(() => LuoguEditor.openFind(true));
    await p.waitForTimeout(250);
    await setFind('cat', 'fox');
    await p.evaluate(() => LuoguEditor.replaceOne());
    await p.waitForTimeout(350);
    ck((await src()) === 'fox dog cat bird cat', '替换单个', JSON.stringify(await src()));
    await p.evaluate(() => LuoguEditor.replaceAll(true));   // force：跳过二次确认
    await p.waitForTimeout(400);
    ck((await src()) === 'fox dog fox bird fox', '替换全部', JSON.stringify(await src()));
    await p.evaluate(() => LuoguEditor.undo());
    await p.waitForTimeout(350);
    ck((await src()) === 'fox dog cat bird cat', '替换可被 Ctrl+Z 撤销', JSON.stringify(await src()));

    // 元字符按字面处理：搜 "$x^2$" 不能被当成正则
    await setDoc('公式 $x^2$ 与 $x^2$ 两处');
    await setFind('$x^2$', 'Y');
    ck((await cnt()) === '1/2', '含正则元字符的查询按字面匹配', await cnt());
    await p.evaluate(() => LuoguEditor.replaceAll(true));   // force：跳过二次确认
    await p.waitForTimeout(350);
    ck((await src()) === '公式 Y 与 Y 两处', '字面替换正确', JSON.stringify(await src()));

    // 正则 + 分组引用
    await setDoc('a1 b2 c3');
    await setOpt('findRegex', true);
    await setFind('([a-z])(\\d)', '$2$1');
    ck((await cnt()) === '1/3', '正则匹配 3 处', await cnt());
    await p.evaluate(() => LuoguEditor.replaceAll(true));   // force：跳过二次确认
    await p.waitForTimeout(350);
    ck((await src()) === '1a 2b 3c', '$1/$2 分组引用生效', JSON.stringify(await src()));

    // 非法正则提示、空匹配不死循环
    await setFind('([', '');
    ck((await p.evaluate(() => document.getElementById('findError').textContent)).includes('正则无效'),
      '非法正则给出提示');
    await setDoc('aaa');
    await setFind('a*', 'X');
    ck((await cnt()) !== '0/0', '可匹配空串的模式不死循环', await cnt());
    await setOpt('findRegex', false);

    // 全词匹配
    await setDoc('dp dpx xdp dp');
    await setOpt('findWord', true);
    await setFind('dp');
    ck((await cnt()) === '1/2', '全词匹配排除 dpx / xdp', await cnt());
    await setOpt('findWord', false);

    await p.evaluate(() => document.getElementById('findInput').focus());
    await p.keyboard.press('Escape');
    await p.waitForTimeout(250);
    ck(!(await open()), 'Esc 关闭查找栏');
  }

  // ---- 要求 44: 匹配高亮 + 全部替换需二次确认 --------------------------------------
  {
    const setDoc2 = async (md) => {
      await p.evaluate((v) => {
        const ta = document.getElementById('editorTextarea');
        ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
        LuoguEditor.render(); LuoguEditor.setViewMode('split');
        ta.focus(); ta.setSelectionRange(0, 0);
      }, md);
      await p.waitForTimeout(300);
    };
    const find2 = async (q, r) => {
      await p.evaluate(([a, bb]) => {
        const fi = document.getElementById('findInput');
        fi.value = a; fi.dispatchEvent(new Event('input', { bubbles: true }));
        if (bb !== null) document.getElementById('replaceInput').value = bb;
      }, [q, r === undefined ? null : r]);
      await p.waitForTimeout(260);
    };
    const marks = () => p.evaluate(() => {
      const l = document.getElementById('findHighlights');
      return {
        total: l.querySelectorAll('mark').length,
        current: l.querySelectorAll('mark.is-current').length,
        texts: [...l.querySelectorAll('mark')].map((m) => m.textContent),
      };
    });
    const allBtn = () => p.evaluate(() => {
      const el = document.getElementById('replaceAllBtn');
      return { text: el.textContent.trim(), armed: el.classList.contains('is-armed') };
    });

    // --- 高亮 ---
    await setDoc2('alpha beta alpha gamma alpha');
    await p.evaluate(() => LuoguEditor.openFind(false));
    await p.waitForTimeout(220);
    await find2('alpha');
    let mk = await marks();
    ck(mk.total === 3, '所有匹配都被高亮', JSON.stringify(mk));
    ck(mk.current === 1, '当前匹配唯一标记', JSON.stringify(mk));
    ck(mk.texts.every((t) => t === 'alpha'), '高亮的是匹配文本本身', JSON.stringify(mk.texts));

    await p.evaluate(() => LuoguEditor.findNext());
    await p.waitForTimeout(240);
    ck(await p.evaluate(() => [...document.querySelectorAll('#findHighlights mark')]
      .findIndex((x) => x.classList.contains('is-current'))) === 1,
      '跳转时当前高亮随之移动');

    // 层与文本框度量必须一致，否则高亮会错位
    ck(await p.evaluate(() => {
      const cs = (el) => { const s = getComputedStyle(el);
        return [s.fontFamily, s.fontSize, s.lineHeight, s.paddingTop, s.paddingLeft,
          s.paddingBottom, s.whiteSpace, s.tabSize].join('|'); };
      return cs(document.getElementById('findHighlights'))
        === cs(document.getElementById('editorTextarea'));
    }), '高亮层与编辑区度量一致（不错位）');
    ck(await p.evaluate(() =>
      getComputedStyle(document.getElementById('findHighlights')).pointerEvents === 'none'),
      '高亮层不拦截鼠标');

    // 滚动跟随
    await setDoc2(Array.from({ length: 200 }, (_, i) => `第 ${i} 行 target`).join('\n'));
    await p.evaluate(() => LuoguEditor.openFind(false));
    await find2('target');
    await p.evaluate(() => {
      const ta = document.getElementById('editorTextarea');
      ta.scrollTop = 800; ta.dispatchEvent(new Event('scroll'));
    });
    await p.waitForTimeout(280);
    ck(await p.evaluate(() => Math.abs(
      document.getElementById('editorTextarea').scrollTop
      - document.getElementById('findHighlights').scrollTop) <= 1),
      '滚动时高亮层同步');

    await p.evaluate(() => LuoguEditor.closeFind());
    await p.waitForTimeout(220);
    ck((await marks()).total === 0, '关闭查找后清除高亮');

    // --- 全部替换的二次确认 ---
    await setDoc2('cat dog cat bird cat');
    await p.evaluate(() => LuoguEditor.openFind(true));
    await p.waitForTimeout(200);
    await find2('cat', 'fox');
    await p.click('#replaceAllBtn');
    await p.waitForTimeout(320);
    ck((await src()) === 'cat dog cat bird cat', '第一次点「全部」不改动文档',
      JSON.stringify(await src()));
    const armed = await allBtn();
    ck(armed.armed && /3/.test(armed.text), '按钮进入确认态并显示处数', JSON.stringify(armed));
    await p.click('#replaceAllBtn');
    await p.waitForTimeout(380);
    ck((await src()) === 'fox dog fox bird fox', '第二次点击才执行替换',
      JSON.stringify(await src()));
    ck((await allBtn()).text === '全部', '执行后按钮复位');

    // 确认态必须随上下文失效，避免"确认"落到别的查询上
    await setDoc2('cat cat');
    await p.evaluate(() => LuoguEditor.openFind(true));
    await find2('cat', 'fox');
    await p.click('#replaceAllBtn');
    await p.waitForTimeout(240);
    await find2('dog', 'fox');
    ck(!(await allBtn()).armed, '更改查询会解除确认态');
    await find2('cat', 'fox');
    await p.click('#replaceAllBtn');
    await p.waitForTimeout(240);
    await p.evaluate(() => LuoguEditor.closeFind());
    await p.waitForTimeout(220);
    ck(!(await allBtn()).armed, '关闭查找栏会解除确认态');

    // 单次替换不受确认流程影响
    await setDoc2('cat cat cat');
    await p.evaluate(() => LuoguEditor.openFind(true));
    await find2('cat', 'fox');
    await p.evaluate(() => LuoguEditor.replaceOne());
    await p.waitForTimeout(350);
    ck((await src()) === 'fox cat cat', '「替换」仍是一次一处、无需确认',
      JSON.stringify(await src()));
    await p.evaluate(() => LuoguEditor.closeFind());
    await p.waitForTimeout(200);
  }



  ck(errs.length === 0, '无 JS 报错', errs.join(' | '));
  console.log(`\n工作区 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
