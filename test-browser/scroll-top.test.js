const { chromium } = require('playwright');
const path = require('path');
const FILE = process.argv[2] || 'file://' + path.resolve(__dirname, '../LuoguMarkdownEditor.html');

// Scrolling back to the very top must land BOTH panes at 0.
//
// Anchor tops are measured from the top of the preview's content, and the first
// block starts below the pane's own padding plus its own margin. Mapping source
// line 0 to that offset drove the preview to ~63px whenever the editor was at 0,
// so the leading whitespace scrolled out of view and the preview looked stuck
// slightly below the top. Most visible with a tall code block, where there is a
// lot of scroll range to come back from.
const CASES = [
  ['纯文本', Array.from({ length: 200 }, (_, i) => `第 ${i} 段文字。`).join('\n\n')],
  ['长代码块', ['# 标题', '', '正文。', '', '```cpp',
    ...Array.from({ length: 150 }, (_, i) => `int a${i}=${i};`), '```', '', '尾。'].join('\n')],
  ['代码块在最前', ['```cpp',
    ...Array.from({ length: 150 }, (_, i) => `int a${i}=${i};`), '```', '', '尾。'].join('\n')],
  ['带行号的代码块', ['# 标题', '', '```cpp line-numbers',
    ...Array.from({ length: 120 }, (_, i) => `int a${i}=${i};`), '```'].join('\n')],
  ['公式开头', ['$$', 'x^2+y^2=z^2', '$$', '', ...Array.from({ length: 100 }, (_, i) => `第 ${i} 段。`)].join('\n\n')],
];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(FILE);
  await p.waitForTimeout(2600);
  let bad = 0;

  for (const [name, md] of CASES) {
    await p.evaluate((v) => {
      const t = document.querySelector('textarea');
      t.value = v;
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }, md);
    await p.waitForTimeout(1400);

    const ta = await p.$('textarea');
    const box = await ta.boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) { await p.mouse.wheel(0, 600); await p.waitForTimeout(60); }
    await p.waitForTimeout(600);
    for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, -600); await p.waitForTimeout(60); }
    await p.waitForTimeout(800);

    const r = await p.evaluate(() => ({
      eTop: Math.round(document.querySelector('textarea').scrollTop),
      pTop: Math.round(document.querySelector('#previewContent').scrollTop),
    }));
    const ok = r.eTop === 0 && r.pTop <= 2;
    if (!ok) { bad++; console.log(`❌ ${name}: 编辑器 ${r.eTop} 预览 ${r.pTop}`); }
  }

  console.log(`\n回顶对齐 ${CASES.length} 项，失败 ${bad}`);
  if (bad) process.exitCode = 1;
  await b.close();
})();
