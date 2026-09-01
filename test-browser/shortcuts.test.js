// Keyboard shortcuts, matched against Luogu's own editor
// (handbook: https://www.luogu.com.cn/article/70w8j2pj).
//
// Every binding below is exercised through a real key event on the textarea, so a
// missing preventDefault or a handler that never fires shows up as a failure.
const { chromium } = require('playwright');
const path = require('path');

const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'LuoguMarkdownEditor.html');

// [name, key spec, expectation]
// A spec is {key, code?, shift?}; Ctrl is always held.
const CASES = [
  ['Ctrl+B 加粗',            { key: 'b' },                        { text: /\*\*/ }],
  ['Ctrl+I 斜体',            { key: 'i' },                        { text: /\*/ }],
  ['Ctrl+D 删除线',          { key: 'd' },                        { text: /~~/ }],
  ['Ctrl+M 行内公式',        { key: 'm' },                        { text: /\$/ }],
  ['Ctrl+Shift+M 行间公式',  { key: 'M', shift: true },           { text: /\$\$/ }],
  ['Ctrl+Shift+H 水平线',    { key: 'H', shift: true },           { text: /^---$/m }],
  ['Ctrl+Shift+Q 引用块',    { key: 'Q', shift: true },           { text: /^>\s/m }],
  ['Ctrl+Shift+7 无序列表',  { key: '&', code: 'Digit7', shift: true }, { text: /^-\s/m }],
  ['Ctrl+Shift+8 有序列表',  { key: '*', code: 'Digit8', shift: true }, { text: /^1\.\s/m }],
  ['Ctrl+Shift+9 任务列表',  { key: '(', code: 'Digit9', shift: true }, { text: /^-\s\[[ x]\]/m }],
  ['Ctrl+Shift+L 链接弹窗',  { key: 'L', shift: true },           { modal: 'linkModal' }],
  ['Ctrl+Shift+I 图片弹窗',  { key: 'I', shift: true },           { modal: 'imageModal' }],
  ['Ctrl+Shift+1 代码弹窗',  { key: '!', code: 'Digit1', shift: true }, { modal: 'codeModal' }],
  ['Ctrl+Shift+2 表格弹窗',  { key: '@', code: 'Digit2', shift: true }, { modal: 'tableModal' }],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'networkidle' });

  let pass = 0, fail = 0;

  for (const [name, spec, expect] of CASES) {
    // Reset: empty document, all modals closed, focus in the textarea.
    await page.evaluate(() => {
      document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.remove('active'));
      const ta = document.getElementById('editorTextarea');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    });

    const prevented = await page.evaluate((s) => {
      const ta = document.getElementById('editorTextarea');
      const ev = new KeyboardEvent('keydown', {
        key: s.key, code: s.code || null,
        ctrlKey: true, shiftKey: !!s.shift,
        bubbles: true, cancelable: true,
      });
      ta.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, spec);

    await page.waitForTimeout(120);

    let ok = false, detail = '';
    if (expect.modal) {
      ok = await page.evaluate((id) => {
        const m = document.getElementById(id);
        return !!m && m.classList.contains('active');
      }, expect.modal);
      detail = ok ? '' : `弹窗 ${expect.modal} 未打开`;
    } else {
      const text = await page.evaluate(() => document.getElementById('editorTextarea').value);
      ok = expect.text.test(text);
      detail = ok ? '' : `编辑区内容 ${JSON.stringify(text.slice(0, 60))} 不匹配 ${expect.text}`;
    }

    // Browsers own Ctrl+D/Ctrl+S/Ctrl+1..9; without preventDefault the shortcut
    // would fire the browser action instead of ours.
    if (ok && !prevented) { ok = false; detail = '未调用 preventDefault，浏览器默认行为会抢走该键'; }

    if (ok) { pass++; console.log('  ✅', name); }
    else { fail++; console.log('  ❌', name, '—', detail); }
  }

  // Regression: plain typing of these letters must still work.
  await page.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    ta.value = ''; ta.focus();
  });
  await page.keyboard.type('dmq789');
  const typed = await page.evaluate(() => document.getElementById('editorTextarea').value);
  if (typed === 'dmq789') { pass++; console.log('  ✅ 无修饰键时字母数字正常输入'); }
  else { fail++; console.log('  ❌ 无修饰键输入被拦截:', JSON.stringify(typed)); }

  if (errors.length) { fail++; console.log('  ❌ 页面报错:', errors.slice(0, 3)); }

  console.log(`\n快捷键 ${pass + fail} 项，失败 ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
