/**
 * Heading suite: toolbar menu, all six levels, and level promote/demote.
 *
 * The toolbar's H dropdown used to stop at H4 even though `insertHeading(level)` and
 * the parser both handled 1..6, so H5/H6 could only be produced by typing the hashes
 * by hand. These checks pin every level end-to-end (menu entry -> inserted source ->
 * rendered tag) and cover the Mod+Shift+Up/Down level shortcuts from Luogu's editor
 * handbook, including the clamping rules at both ends of the range.
 *
 * Usage: node test-browser/heading.test.js [file-url-or-http-url]
 */
const { chromium } = require('playwright');
const path = require('path');

const target =
  process.argv[2] ||
  'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(target);
  await page.waitForTimeout(800);

  const setText = async (t) => {
    await page.evaluate((v) => {
      const e = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(e, v);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.focus();
      e.selectionStart = e.selectionEnd = v.length;
    }, t);
    await page.waitForTimeout(200);
  };
  const value = () => page.evaluate(() => document.querySelector('textarea').value);
  const modShift = async (arrow) => {
    await page.keyboard.down('Control');
    await page.keyboard.down('Shift');
    await page.keyboard.press(arrow);
    await page.keyboard.up('Shift');
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);
  };

  // ---- Toolbar dropdown offers all six levels ----
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('.dropdown-item')]
      .filter((b) => /insertHeading/.test(b.getAttribute('onclick') || ''))
      .map((b) => b.getAttribute('onclick'))
  );
  check('H 下拉共 6 项', items.length === 6, `实际 ${items.length}`);
  for (let lv = 1; lv <= 6; lv++) {
    check(`下拉含 H${lv}`, items.some((s) => s.includes(`insertHeading(${lv})`)));
  }

  // ---- The menu must stay inside the viewport after growing to six rows ----
  const geo = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.tool-dropdown')].find((x) =>
      /insertHeading/.test(x.innerHTML)
    );
    d.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const m = [...document.querySelectorAll('.dropdown-menu')].find((x) =>
      /insertHeading/.test(x.innerHTML)
    );
    const r = m.getBoundingClientRect();
    return { bottom: r.bottom, right: r.right, vh: innerHeight, vw: innerWidth };
  });
  check('下拉菜单未溢出视口', geo.bottom <= geo.vh && geo.right <= geo.vw,
    `bottom=${Math.round(geo.bottom)}/${geo.vh}`);

  // ---- Each level inserts the right source and renders the right tag ----
  for (let lv = 1; lv <= 6; lv++) {
    await setText('');
    await page.evaluate((l) => window.LuoguEditor.insertHeading(l), lv);
    await page.waitForTimeout(500);
    const src = (await value()).trim();
    const tag = await page.evaluate(() => {
      const h = document.querySelector(
        '.preview-content h1,.preview-content h2,.preview-content h3,' +
        '.preview-content h4,.preview-content h5,.preview-content h6'
      );
      return h ? h.tagName : null;
    });
    check(`insertHeading(${lv}) 源码为 ${lv} 个 #`, src.startsWith('#'.repeat(lv) + ' '), src);
    check(`insertHeading(${lv}) 渲染为 H${lv}`, tag === `H${lv}`, String(tag));
  }

  // ---- All six render simultaneously with distinct, non-increasing sizes ----
  await setText('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六');
  await page.waitForTimeout(700);
  const sizes = await page.evaluate(() => {
    const out = [];
    for (let i = 1; i <= 6; i++) {
      const h = document.querySelector('.preview-content h' + i);
      out.push(h ? parseFloat(getComputedStyle(h).fontSize) : null);
    }
    return out;
  });
  check('六级标题全部渲染', sizes.every((s) => s !== null), JSON.stringify(sizes));
  check('字号自 H1 起不递增', sizes.every((s, i) => i === 0 || s <= sizes[i - 1]),
    JSON.stringify(sizes));

  // ---- Mod+Shift+Up / Down level shifting ----
  const shiftCase = async (name, start, arrow, want) => {
    await setText(start);
    await modShift(arrow);
    const got = (await value()).trim();
    check(name, got === want, `得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);
  };
  await shiftCase('段落 Mod+Shift+↑ 变 H1', '普通文字', 'ArrowUp', '# 普通文字');
  await shiftCase('H1 Mod+Shift+↓ 变 H2', '# 标题', 'ArrowDown', '## 标题');
  await shiftCase('H4 降到 H5', '#### 标题', 'ArrowDown', '##### 标题');
  await shiftCase('H5 降到 H6', '##### 标题', 'ArrowDown', '###### 标题');
  await shiftCase('H6 不再降级（钳位）', '###### 标题', 'ArrowDown', '###### 标题');
  await shiftCase('H6 升到 H5', '###### 标题', 'ArrowUp', '##### 标题');
  await shiftCase('H1 升级还原为段落', '# 标题', 'ArrowUp', '标题');
  // A blank line has no text to promote and must be left alone.
  await shiftCase('空行不受影响', '', 'ArrowUp', '');

  // Level shifting must be undoable like any other edit.
  await setText('##### 标题');
  await modShift('ArrowDown');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(350);
  check('升降级可撤销', (await value()).trim() === '##### 标题', await value());

  console.log(`\n标题 ${pass + fail} 项，失败 ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
