const { chromium } = require('playwright');
const path = require('path');
const FILE = process.argv[2] || 'file://' + path.resolve(__dirname, '../LuoguMarkdownEditor.html');

// A long code line must not give its own row a horizontal scrollbar.
//
// Each .code-line used to be its own scroll container so the sticky gutter number
// would stay put. The side effect was a scrollbar wedged between the overflowing
// line and the next one: it ate into that row's height and covered the line below.
// The block as a whole scrolls now, so there is exactly one scrollbar and it sits
// at the bottom of the code block.
const LONG = 'x'.repeat(120);
const CASES = [
  ['带行号 + 高亮 + 长行', ['```cpp line-numbers lines=2-3',
    'int a = 1;', 'int b = 2;', 'int c = 3;', `// ${LONG}`, 'return 0;'].join('\n')],
  ['带行号 + 长行', ['```cpp line-numbers', 'int a = 1;', `// ${LONG}`, 'int b = 2;'].join('\n')],
  ['无行号 + 长行', ['```cpp', 'int a = 1;', `// ${LONG}`, 'int b = 2;'].join('\n')],
  ['全部短行', ['```cpp line-numbers', 'int a = 1;', 'int b = 2;'].join('\n')],
];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(FILE);
  await p.waitForTimeout(2600);
  let bad = 0;

  for (const [name, body] of CASES) {
    await p.evaluate((v) => {
      const t = document.querySelector('textarea');
      t.value = v;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }, body + '\n```');
    await p.waitForTimeout(900);

    const r = await p.evaluate(() => {
      const pre = document.querySelector('#previewContent .luogu-code-pre');
      const lines = [...document.querySelectorAll('#previewContent .code-line')];
      const hl = [...document.querySelectorAll('#previewContent .code-line-highlighted')];
      return {
        // No individual row may be a scroll container.
        rowScrollers: lines.filter((l) => {
          const c = getComputedStyle(l);
          return (c.overflowX === 'auto' || c.overflowX === 'scroll')
            && l.scrollWidth > l.clientWidth + 1;
        }).length,
        // Every row keeps its full height; a scrollbar would steal some.
        heights: [...new Set(lines.map((l) => l.offsetHeight))],
        preScrolls: pre.scrollWidth > pre.clientWidth + 1,
        preOverflowX: getComputedStyle(pre).overflowX,
        // Highlight backgrounds must span the whole scrollable width.
        hlFullWidth: hl.every((h) => h.getBoundingClientRect().width >= pre.scrollWidth - 2),
        hlCount: hl.length,
      };
    });

    const problems = [];
    if (r.rowScrollers) problems.push(`${r.rowScrollers} 行自带滚动条`);
    if (r.heights.length > 1) problems.push(`行高不一致 ${JSON.stringify(r.heights)}`);
    if (r.preOverflowX !== 'auto') problems.push(`pre overflow-x=${r.preOverflowX}`);
    if (r.hlCount && !r.hlFullWidth) problems.push('高亮背景未铺满');
    if (problems.length) { bad++; console.log(`❌ ${name}: ${problems.join('; ')}`); }
  }

  // The gutter must stay pinned when the block is scrolled right.
  await p.evaluate((v) => {
    const t = document.querySelector('textarea');
    t.value = v;
    t.dispatchEvent(new Event('input', { bubbles: true }));
  }, ['```cpp line-numbers', 'int a = 1;', `// ${LONG}`, '```'].join('\n'));
  await p.waitForTimeout(900);
  const pinned = await p.evaluate(() => {
    const pre = document.querySelector('#previewContent .luogu-code-pre');
    pre.scrollLeft = 200;
    const pr = pre.getBoundingClientRect();
    return [...document.querySelectorAll('#previewContent .code-line-number')]
      .every((n) => Math.abs(n.getBoundingClientRect().left - pr.left) < 2);
  });
  if (!pinned) { bad++; console.log('❌ 横向滚动后行号未固定'); }

  console.log(`\n代码块横向滚动 ${CASES.length + 1} 项，失败 ${bad}`);
  if (bad) process.exitCode = 1;
  await b.close();
})();
