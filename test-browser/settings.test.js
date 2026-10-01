/**
 * 设置子页面（齿轮打开的大弹窗）。
 *
 * 用户把设置从"顶栏一个悬停下拉框"改成了"点齿轮弹出一个带分节的子页面"，四项要求：
 *   1. 齿轮弹出子页面而不是下拉框；
 *   2. 语言用下拉框，不用勾选项；
 *   3. 主题也进这个页面；
 *   4. 能设置自动补全（自动保存）间隔。
 *
 * 这里钉住的是：入口真的换成弹窗且下拉框长度归零、四个控件都在、改控件真的改到状态
 * （并且落盘）、弹窗打开时状态是"当前值"而不是初始值、以及网页版不显示磁盘相关的行。
 * 这里也覆盖浏览器草稿及多标签的真实保存时机；桌面写盘由 workspace-autosave.test.js 覆盖。
 */
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const APP = process.argv[2]
    || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };

  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(APP, { waitUntil: 'networkidle' });
  // 界面语言默认跟随系统（CI 的浏览器报 en-US），这些断言针对中文 UI。
  await p.evaluate(() => { if (window.LuoguI18n) LuoguI18n.setLang('zh'); });
  await p.waitForTimeout(600);

  // ---- 1. 入口：齿轮不再是下拉框 ----
  ck(await p.evaluate(() => {
    const btn = document.getElementById('settingsBtn');
    return !!btn && btn.className.includes('btn-icon-only');
  }), '顶栏有个齿轮按钮');
  ck(await p.evaluate(() => {
    const gear = document.getElementById('settingsBtn');
    const dd = gear.closest('.tool-dropdown');
    return !dd;                       // 齿轮不在 .tool-dropdown 里 = 不会悬停出下拉
  }), '齿轮不再是悬停下拉（外面没有 .tool-dropdown）');
  ck(await p.evaluate(() => !document.getElementById('lintToggleItem')), '旧设置下拉的项已移除');
  ck(await p.evaluate(() => document.querySelectorAll('.dropdown-menu .dropdown-item').length)
    > 0, '其它下拉（导出 / 标题 / 模板）不受影响');

  await p.click('#settingsBtn');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => document.getElementById('settingsModal').classList.contains('active')),
    '点齿轮弹出设置弹窗');
  ck(await p.evaluate(() => [...document.querySelectorAll('#settingsModal .settings-section-title')]
    .map((e) => e.textContent.trim()).join()) === '外观,语言,编辑器',
    '弹窗里分了 外观 / 语言 / 编辑器 三节');

  // ---- 2. 语言是下拉框 ----
  ck(await p.evaluate(() => document.getElementById('settingsLangSelect').tagName) === 'SELECT',
    '语言是 <select> 下拉框');
  ck(await p.evaluate(() => [...document.getElementById('settingsLangSelect').options].map((o) => o.value).join())
    === 'system,zh,en', '三个选项：跟随系统 / 简体中文 / English');
  ck(await p.evaluate(() => document.getElementById('settingsLangSelect').value) === 'zh',
    '下拉框停在当前语言');

  await p.selectOption('#settingsLangSelect', 'en');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => LuoguI18n.current()) === 'en', '选 English 后界面真的变英文');
  ck(await p.evaluate(() => JSON.parse(JSON.stringify(localStorage.getItem('luogu_editor_lang')))) === 'en',
    '选择写入 localStorage');
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_lang') === 'en'
    && document.getElementById('settingsModal').textContent.includes('Autosave to browser')),
    '浏览器自动保存设置也完整翻成英文');
  await p.selectOption('#settingsLangSelect', 'zh');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => LuoguEditor.getContent !== undefined && document.documentElement.lang) === 'zh-CN',
    '切回中文后 html[lang] 也回来');

  // ---- 3. 主题也在这个弹窗里 ----
  ck(await p.evaluate(() => document.getElementById('settingsThemeSelect').tagName) === 'SELECT',
    '主题是 <select> 下拉框');
  await p.selectOption('#settingsThemeSelect', 'dark');
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark',
    '选暗色后主题真的切换');
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_theme')) === 'dark', '主题写入 localStorage');
  await p.selectOption('#settingsThemeSelect', 'light');
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'light', '切回亮色');

  // 从别处改主题，弹窗里的下拉也要跟上（控件是"显示状态"的一方）
  await p.evaluate(() => LuoguEditor.setTheme('dark'));
  ck(await p.evaluate(() => document.getElementById('settingsThemeSelect').value) === 'dark',
    '在别处改主题，弹窗里同步');
  await p.evaluate(() => LuoguEditor.setTheme('light'));

  // ---- 4. 自动保存间隔 ----
  ck(await p.evaluate(() => document.getElementById('settingsAutosaveInterval').tagName) === 'SELECT',
    '自动保存间隔是 <select> 下拉框');
  ck(await p.evaluate(() => [...document.getElementById('settingsAutosaveInterval').options]
    .map((o) => Number(o.value)).join()) === '500,1000,2500,5000,10000',
    '五档：0.5 / 1 / 2.5 / 5 / 10 秒');
  ck(await p.evaluate(() => document.getElementById('settingsAutosaveInterval').value) === '2500',
    '默认停在 2.5 秒');

  // 网页版直接操作真实控件，不再绕过隐藏行。
  await p.selectOption('#settingsAutosaveInterval', '10000');
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => LuoguEditor.workspace.autosaveInterval) === 10000,
    '选 10 秒后工作区用的是 10 秒');
  ck(await p.evaluate(() => localStorage.getItem('luogu_workspace_autosave_interval')) === '10000',
    '间隔写入 localStorage');
  ck(await p.evaluate(() => LuoguEditor.workspace._readAutosaveInterval()) === 10000,
    '重新读取也拿得到');
  // 被手改过的值不能生效，否则写盘节奏可能变成 0
  ck(await p.evaluate(() => {
    localStorage.setItem('luogu_workspace_autosave_interval', '7');
    return LuoguEditor.workspace._readAutosaveInterval();
  }) === 2500, '非法值回落到默认（7ms 不应该被接受）');
  ck(await p.evaluate(() => {
    localStorage.setItem('luogu_workspace_autosave_interval', '10000');
    return LuoguEditor.workspace._readAutosaveInterval();
  }) === 10000, '合法值恢复');

  // ---- 弹窗打开时的状态刷新 ----
  await p.evaluate(() => LuoguEditor.closeModal('settingsModal'));
  await p.evaluate(() => { LuoguEditor.toggleLintDisplay(false); LuoguEditor.workspace.autosaveToFile = false; });
  await p.click('#settingsBtn');
  await p.waitForTimeout(300);
  ck(await p.evaluate(() => document.getElementById('lintDisplayToggle').checked === false),
    '再打开时"显示排版问题"反映最新状态');
  ck(await p.evaluate(() => document.getElementById('autoSaveToggle').checked === false),
    '再打开时桌面自动保存控件也反映最新状态');
  ck(await p.evaluate(() => document.getElementById('settingsAutosaveInterval').value) === '10000',
    '再打开时"自动保存间隔"停在用户选的那一档');
  await p.evaluate(() => { LuoguEditor.toggleLintDisplay(true); LuoguEditor.workspace.autosaveToFile = true; });

  // ---- 网页版也能修改自动保存，只有原文件写回/保存时排版隐藏 ----
  ck(await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#settingsModal .settings-row')];
    return rows.length === 7 && rows.filter((el) => el.getClientRects().length).length === 5;
  }), '网页版显示 5 个设置项，包括浏览器自动保存及间隔');
  ck(await p.evaluate(() => document.getElementById('settingsEditorSection').getClientRects().length > 0),
    '网页版编辑器分节可见');
  ck(await p.evaluate(() => document.getElementById('themeShortcut').getClientRects().length === 0),
    '网页版顶栏不再显示太阳主题入口');
  ck(await p.evaluate(() => [...document.querySelectorAll('header [data-i18n-title="切换主题"]')]
    .every(el => el.getClientRects().length === 0)), '顶栏不能悬停打开隐藏的主题菜单');

  const editText = async (text) => {
    await p.evaluate(text => {
      const ta = document.getElementById('editorTextarea');
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
  };
  const stored = () => p.evaluate(() => ({
    draft: localStorage.getItem('luogu_editor_draft'),
    tabs: localStorage.getItem('luogu_workspace_web_docs'),
  }));
  await p.selectOption('#settingsAutosaveInterval', '500');
  await editText('# web saved baseline');
  await p.waitForTimeout(1000);
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_draft') === '# web saved baseline'
    && JSON.parse(localStorage.getItem('luogu_workspace_web_docs'))[0].content === '# web saved baseline'),
    '0.5 秒后草稿与标签内容一起保存到浏览器');

  await p.uncheck('#webAutoSaveToggle');
  ck(await p.evaluate(() => !LuoguEditor.workspace.webAutosave
    && localStorage.getItem('luogu_workspace_web_autosave') === '0'), '关闭开关立即生效并记住');
  const baseline = await stored();
  await editText('# web disabled input');
  await p.evaluate(() => LuoguEditor.workspace.newTab());
  await p.evaluate(() => LuoguEditor.setContent('# disabled programmatic content'));
  await p.waitForTimeout(1000);
  ck(JSON.stringify(await stored()) === JSON.stringify(baseline),
    '关闭后输入、新建标签和程序修改都不偷偷保存草稿/标签');
  ck(await p.evaluate(() => document.getElementById('saveStatusIndicator').textContent.includes('已关闭')),
    '关闭后状态栏不会声称已自动保存');
  await p.reload({ waitUntil: 'networkidle' });
  await p.evaluate(() => { LuoguI18n.setLang('zh'); LuoguEditor.openSettings(); });
  ck(await p.evaluate(() => !document.getElementById('webAutoSaveToggle').checked
    && LuoguEditor.workspace.autosaveInterval === 500), '开关及间隔跨刷新保留');
  ck(await p.evaluate(() => LuoguEditor.getContent() === '# web saved baseline'),
    '刷新恢复上次保存内容，不是关闭后未保存内容');
  await p.waitForTimeout(900);
  ck(JSON.stringify(await stored()) === JSON.stringify(baseline), '关闭状态启动也不覆盖旧快照');

  await p.check('#webAutoSaveToggle');
  await p.selectOption('#settingsAutosaveInterval', '10000');
  await editText('# web long delay');
  const beforeLong = await stored();
  await p.waitForTimeout(1400);
  ck(JSON.stringify(await stored()) === JSON.stringify(beforeLong),
    '10 秒间隔不会被旧草稿实时保存或标签 800ms 计时器绕过');
  await p.selectOption('#settingsAutosaveInterval', '500');
  await p.waitForTimeout(900);
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_draft') === '# web long delay'
    && JSON.parse(localStorage.getItem('luogu_workspace_web_docs'))[0].content === '# web long delay'),
    '调小间隔立即重排，草稿和标签都保存最新内容');

  await editText('# pending save cancelled');
  await p.uncheck('#webAutoSaveToggle');
  const beforeCancel = await stored();
  await p.waitForTimeout(900);
  ck(JSON.stringify(await stored()) === JSON.stringify(beforeCancel), '关闭开关取消已经排队的保存');
  await p.check('#webAutoSaveToggle');
  await p.waitForTimeout(900);
  ck(await p.evaluate(() => localStorage.getItem('luogu_editor_draft') === '# pending save cancelled'),
    '重新开启后无需再次输入也会保存最新草稿');

  // 两份标签的内容及恢复（不仅仅当前草稿键）。
  await p.evaluate(() => { LuoguEditor.workspace.newTab(); LuoguEditor.setContent('# web second tab'); });
  await p.waitForTimeout(900);
  await p.reload({ waitUntil: 'networkidle' });
  await p.evaluate(() => { LuoguI18n.setLang('zh'); LuoguEditor.openSettings(); });
  ck(await p.evaluate(() => LuoguEditor.workspace.docs.length === 2
    && LuoguEditor.workspace.docs[0].content === '# pending save cancelled'
    && LuoguEditor.workspace.docs[1].content === '# web second tab'), '自动保存后刷新恢复全部标签内容');

  // ---- 关闭 ----
  await p.click('#settingsModal .modal-footer .btn-primary');
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => !document.getElementById('settingsModal').classList.contains('active')),
    '「完成」能关闭弹窗');
  await p.evaluate(() => LuoguEditor.openSettings());
  await p.waitForTimeout(200);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  ck(await p.evaluate(() => !document.getElementById('settingsModal').classList.contains('active')),
    'Esc 也能关闭设置页');

  ck(errs.length === 0, '全程无 JS 报错', errs.slice(0, 3).join(' | '));

  console.log(`\n设置子页面 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
