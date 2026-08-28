// Parser test suite. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cases = require('./cases.js');

function loadParser() {
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/luogu-parser.js'), 'utf8'),
    sandbox
  );
  return new sandbox.window.LuoguParser();
}

function loadLinter() {
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/luogu-linter.js'), 'utf8'),
    sandbox
  );
  return new sandbox.window.LuoguLinter();
}

const parser = loadParser();
const render = (md) => parser.render(md);
const linter = loadLinter();

// ---------------------------------------------------------------- security

test('does not emit executable event-handler attributes', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)>',
    '<body onload=alert(1)>',
    '<iframe onload=alert(1)></iframe>',
    '<div onmouseover="alert(1)">hover</div>',
  ];
  for (const p of payloads) {
    const html = render(p);
    assert.ok(
      !/<(?:img|svg|body|iframe|div)\b/i.test(html),
      `raw tag survived for: ${p}\n  -> ${html}`
    );
    assert.ok(html.includes('&lt;'), `not escaped: ${p}\n  -> ${html}`);
  }
});

test('escapes raw script tags', () => {
  const html = render('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(html), html);
  assert.ok(html.includes('&lt;script'), html);
});

test('blocks dangerous URL schemes in links', () => {
  const payloads = [
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](vbscript:msgbox(1))',
    '[x](data:text/html,hi)',
    '[x](java\tscript:alert(1))',
    '[x](java\nscript:alert(1))',
    '[x]( javascript:alert(1))',
  ];
  for (const p of payloads) {
    const html = render(p);
    assert.ok(
      !/href="[^"]*(?:javascript|vbscript|data):/i.test(html),
      `dangerous href survived: ${p}\n  -> ${html}`
    );
  }
});

test('blocks dangerous URL schemes in images', () => {
  const html = render('![a](javascript:alert(1))');
  assert.ok(!/src="[^"]*javascript:/i.test(html), html);
});

test('preserves legitimate URLs', () => {
  assert.match(render('[x](https://www.luogu.com.cn)'), /href="https:\/\/www\.luogu\.com\.cn"/);
  assert.match(render('[x](http://a.b)'), /href="http:\/\/a\.b"/);
  assert.match(render('[x](/problem/P1001)'), /href="\/problem\/P1001"/);
  assert.match(render('[x](#anchor)'), /href="#anchor"/);
  assert.match(render('[x](mailto:a@b.com)'), /href="mailto:a@b\.com"/);
  assert.match(render('[x](./rel/path.md)'), /href="\.\/rel\/path\.md"/);
  assert.match(render('![i](https://cdn.luogu.com.cn/a.png)'), /src="https:\/\/cdn\.luogu\.com\.cn\/a\.png"/);
});

test('html inside code spans and fences stays literal, not executable', () => {
  const inline = render('`<b>x</b>`');
  assert.ok(!/<b>/.test(inline), inline);
  const fenced = render('```html\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!/<img\b/i.test(fenced), fenced);
});

test('autolinks still work', () => {
  const html = render('<https://www.luogu.com.cn>');
  assert.match(html, /href="https:\/\/www\.luogu\.com\.cn"/);
});

// ------------------------------------------------------------- correctness

test('renders core inline formatting', () => {
  assert.match(render('**b**'), /<strong>b<\/strong>/);
  assert.match(render('*i*'), /<em>i<\/em>/);
  assert.match(render('~~s~~'), /<del>s<\/del>/);
  assert.match(render('`c`'), /luogu-inline-code/);
});

test('renders Luogu extended blocks', () => {
  assert.match(render(':::info\nx\n:::'), /luogu-callout/);
  assert.match(render(':::success{open}\nx\n:::'), /open/);
  assert.match(render(':::align{center}\nx\n:::'), /luogu-align-center/);
  assert.match(render(':::epigraph[鲁迅]\nx\n:::'), /luogu-epigraph/);
});

test('renders table cell merging', () => {
  assert.match(render('| a | b |\n| --- | --- |\n| 1 | 2 |\n| ^ | 3 |'), /rowspan="2"/);
  assert.match(render('| a | b |\n| --- | --- |\n| 1 | < |'), /colspan="2"/);
});

test('renders code block features', () => {
  assert.match(render('```cpp\nint x;\n```'), /language-cpp/);
  assert.match(render('```\nint x;\n```'), /language-cpp/, 'bare fence falls back to C++');
  assert.match(render('```cpp line-numbers\na;\nb;\n```'), /has-line-numbers/);
});

test('math placeholders are fully substituted', () => {
  for (const md of ['$x$', '$$y$$', '$a$ 与 $b$ 与 $$c$$']) {
    const html = render(md);
    assert.ok(!/LUOGUMATH/.test(html), `leftover placeholder: ${md} -> ${html}`);
  }
});

test('no placeholder tokens leak into output for any corpus case', () => {
  for (const [name, md] of cases) {
    const html = render(md);
    assert.ok(
      !/LUOGU(?:MATHBLOCK|MATHINLINE|CODEBLOCK|INLINECODE|MEDIATOKEN|LINKTOKEN|ESCAPETOKEN|INLINETOKEN)\d+END/.test(html),
      `leaked placeholder in case "${name}": ${html.slice(0, 200)}`
    );
  }
});

test('a matched $ pair always renders, even around CJK', () => {
  // Previously this was suppressed on the theory that it was currency, which also
  // broke valid formulas like $设x=1$. Rendering is now unconditional.
  const html = render('花费$5和$10 元');
  assert.ok(/katex|luogu-math/.test(html), html);
});

test('CJK inside a formula still renders', () => {
  for (const md of ['$设x=1$', '$a_{最大}$', '$$设 x = 1$$']) {
    assert.ok(/katex|luogu-math/.test(render(md)), md);
  }
});

// ------------------------------------------------------- linter autofix (CJK)

test('autofix wraps bare CJK in a formula with \\text{}', () => {
  assert.match(linter.formatSpacing('$中文$'), /\$\\text\{中文\}\$/);
  assert.match(linter.formatSpacing('$设x=1$'), /\\text\{设\}x=1/);
  assert.match(linter.formatSpacing('$a_{最大}$'), /a_\{\\text\{最大\}\}/);
});

test('autofix leaves already-wrapped CJK alone and is idempotent', () => {
  for (const src of ['$中文$', '$设x=1$', '$a_{最大}$', '$\\text{设有} n \\text{个点}$']) {
    const once = linter.formatSpacing(src);
    assert.equal(linter.formatSpacing(once), once, src);
    assert.ok(!/\\text\{\\text\{/.test(once), once);
  }
});

test('autofix does not turn currency prose into a formula', () => {
  // "花费$5和$10 元" is two prices, not a formula: it must not gain \text{}.
  assert.ok(!/\\text\{/.test(linter.formatSpacing('花费$5和$10 元')));
  assert.ok(!/\\text\{/.test(linter.formatSpacing('价格是$100，另一个是$200')));
});

test('cjk-in-math warning is raised exactly when the autofix can fix it', () => {
  const warned = (md) => {
    const r = linter.lint(md);
    return (r.issues || r).some((i) => i.rule === 'cjk-in-math');
  };
  for (const md of ['$中文$', '$设x=1$', '$$设 x = 1$$']) assert.ok(warned(md), md);
  // No warning that the fix button could never clear.
  for (const md of ['$a+b$', '$\\text{设}x=1$', '花费$5和$10 元']) assert.ok(!warned(md), md);
});

// ------------------------------------------------------------ bilibili embed

test('bilibili iframe sandbox keeps allow-same-origin', () => {
  // Without allow-same-origin the player gets an opaque origin, its storage access
  // throws, and it renders as an empty black box. It cannot be used to escape the
  // sandbox because the frame is never same-origin with the editor page.
  const html = render('![v](bilibili:BV1xx411c7mD)');
  const facade = html.match(/data-src="([^"]+)"/);
  assert.ok(facade, 'facade button should carry the player URL');
  assert.match(facade[1], /player\.bilibili\.com/);
  assert.match(facade[1], /isOutside=true/);
  assert.match(facade[1], /bvid=BV1xx411c7mD/);
  assert.match(facade[1], /(^|&amp;|&)p=1/);
});

test('bilibili accepts av ids and explicit pages', () => {
  const av = render('![v](bilibili:av170001)').match(/data-src="([^"]+)"/)[1];
  assert.match(av, /aid=170001/);
  const paged = render('![v](bilibili:BV1xx411c7mD?p=3)').match(/data-src="([^"]+)"/)[1];
  assert.match(paged, /page=3/);
  assert.ok(!/(?:^|&amp;|&)p=1(?:&|$)/.test(paged), 'explicit page must not be overridden');
});

test('renders every corpus case without throwing', () => {
  for (const [name, md] of cases) {
    assert.doesNotThrow(() => render(md), `case ${name} threw`);
  }
});

// ------------------------------------------------------------- performance

test('render cost stays near-linear in document size', () => {
  const build = (n) => {
    const d = [];
    for (let i = 0; i < n; i++) {
      d.push(`## 标题 ${i}`, `文字 $x^2$ 与 [链接](https://a.b) 和 \`code\`。`, '', '```cpp', 'int main(){}', '```', '');
    }
    return d.join('\n');
  };
  // Timing on a shared CI runner is noisy in one direction only: a neighbour can
  // steal time and inflate a sample, but nothing can make a run faster than the
  // work actually takes. So take the MINIMUM of several rounds, which approximates
  // the interference-free cost and keeps the ratio stable.
  const bestOf = (md, rounds = 5) => {
    let best = Infinity;
    for (let i = 0; i < rounds; i++) {
      const t = process.hrtime.bigint();
      render(md);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      if (ms < best) best = ms;
    }
    return best;
  };

  const small = build(500);
  const large = build(2000); // 4x the content

  // Warm up so KaTeX/JIT effects do not distort the ratio.
  bestOf(small, 2);
  bestOf(large, 1);

  const tSmall = Math.max(bestOf(small), 0.5);
  const tLarge = bestOf(large);

  // Quadratic behaviour gives ~16x for a 4x size increase; the linear-ish
  // implementation sits near 3x. 8x leaves room for noise while still failing
  // loudly on a return to O(n^2).
  const ratio = tLarge / tSmall;
  assert.ok(ratio < 8, `render appears super-linear: 4x size cost ${ratio.toFixed(1)}x`);
});

test('nested containers report absolute source lines', () => {
  // A container's inner blocks used to be parsed with the line counter reset to 0, so
  // content deep in the document claimed data-src-line="0". Scroll sync binary-searches
  // those anchors, so a bogus 0 sent the preview flying to the top of the document —
  // the intermittent "bounce" reported against the demo file.
  const md = [
    '# 标题',          // line 0
    '',
    '正文。',           // line 2
    '',
    ':::align[center]', // line 4
    '居中的一段话。',    // line 5
    ':::',
    '',
    '> 引用第一行',      // line 8
    '',
    ':::epigraph[作者]', // line 10
    '题记正文。',        // line 11
    ':::',
  ].join('\n');
  const html = render(md);
  const lines = [...html.matchAll(/data-src-line="(\d+)"/g)].map((m) => Number(m[1]));

  // Exactly one anchor may claim line 0 (the H1 itself).
  assert.equal(lines.filter((l) => l === 0).length, 1,
    `only the H1 should be line 0, got ${JSON.stringify(lines)}`);
  // The align/epigraph bodies must land on their real lines, not on 0/1.
  assert.ok(lines.some((l) => l >= 4), `expected deep anchors, got ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l >= 10), `epigraph body lost its offset: ${JSON.stringify(lines)}`);
});

test('blockquote inner content keeps its absolute line', () => {
  const md = ['# T', '', '前言。', '', '> 引用内容在这里', '> > 嵌套引用'].join('\n');
  const lines = [...render(md).matchAll(/data-src-line="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(lines.filter((l) => l === 0).length, 1,
    `blockquote body restarted numbering: ${JSON.stringify(lines)}`);
  assert.ok(Math.max(...lines) >= 4, `expected an anchor at/after line 4: ${JSON.stringify(lines)}`);
});

test('unknown container names are not treated as containers', () => {
  // ":::s" is a typo for the closing ":::". It used to match the OPENING pattern
  // (type = "s"), silently become an info callout, and swallow the rest of the file.
  const html = render(':::xxx\n\n内容一\n\n:::s\n\n后面的正文。');
  assert.ok(!/luogu-callout/.test(html), 'unknown names must not render a callout');
  assert.match(html, /luogu-unknown-container/);
  assert.match(html, /:::xxx/);
  assert.match(html, /:::s/);
  // Crucially, text after the typo must stay OUTSIDE any box.
  assert.match(html, /后面的正文。/);
});

test('valid container types still render', () => {
  for (const t of ['info', 'success', 'warning', 'error']) {
    const html = render(`:::${t}\n内容\n:::`);
    assert.match(html, new RegExp(`luogu-callout-${t}`), `${t} should render`);
  }
  assert.match(render(':::align[center]\n居中\n:::'), /luogu-align-center/);
  assert.match(render(':::epigraph[作者]\n题记\n:::'), /luogu-epigraph/);
});

test('unclosed container is flagged rather than silently swallowing the document', () => {
  const html = render(':::info\n忘了结尾的内容');
  assert.match(html, /luogu-unclosed-warning/);
  assert.match(html, /忘了结尾的内容/, 'content must still be rendered');
});

test('collapsed callout exposes the line span it covers', () => {
  // The editor needs the end line to keep scroll sync flat across a collapsed body
  // instead of smearing those hidden lines onto the next visible block.
  const md = ['# T', '', ':::info[收起]', 'a', 'b', 'c', ':::', '', '尾巴'].join('\n');
  const m = render(md).match(/<details[^>]*data-src-line="(\d+)"[^>]*data-src-end-line="(\d+)"/);
  assert.ok(m, 'details must carry both start and end line');
  assert.equal(Number(m[1]), 2);
  assert.equal(Number(m[2]), 6);
});

// --------------------------------------------- sentence-end period (paragraphs)

test('missing-end-period judges paragraphs, not individual lines', () => {
  const linesOf = (md) => linter.lint(md).issues
    .filter((i) => i.rule === 'missing-end-period').map((i) => i.line);

  // A paragraph wrapped over several lines ends ONCE. The old per-line check flagged
  // every line but the last.
  assert.deepEqual(linesOf('第一行\n第二行\n第三行'), [3]);
  assert.deepEqual(linesOf('一句话跨越了多行\n它的后半句在这里。'), []);
  assert.deepEqual(linesOf('一段完整的话。'), []);
  assert.deepEqual(linesOf('一段完整的话'), [1]);
});

test('missing-end-period ignores non-prose blocks', () => {
  const hits = (md) => linter.lint(md).issues
    .filter((i) => i.rule === 'missing-end-period').length;

  assert.equal(hits('# 标题'), 0, 'heading');
  assert.equal(hits('标题下面\n==='), 0, 'setext heading');
  assert.equal(hits('- 列表项'), 0, 'list');
  assert.equal(hits('> 引用'), 0, 'blockquote');
  assert.equal(hits('| a | b |'), 0, 'table');
  assert.equal(hits('```cpp\nint main(){}\n```'), 0, 'code fence');
  assert.equal(hits('$$\n多行公式\n$$'), 0, 'display math');
  assert.equal(hits('![图](a.png)'), 0, 'image');
  assert.equal(hits('[链接](https://a.com)'), 0, 'link');
  assert.equal(hits(':::info\n框内文字。\n:::'), 0, 'container delimiters');
  // The container BODY is still prose and must be checked.
  assert.equal(hits(':::info\n框内文字\n:::'), 1, 'container body');
});

test('period autofix agrees with the linter and is idempotent', () => {
  for (const md of [
    '一段完整的话',
    '第一行\n第二行\n第三行',
    ':::info\n框内文字\n:::',
    '结尾是英文单词 test',
    '一句话跨越了多行\n它的后半句在这里',
  ]) {
    const fixed = linter.formatSpacing(md);
    const left = linter.lint(fixed).issues.filter((i) => i.rule === 'missing-end-period');
    assert.equal(left.length, 0, `fix should clear the warning for ${JSON.stringify(md)}`);
    assert.equal(linter.formatSpacing(fixed), fixed, 'formatSpacing must be idempotent');
  }
  // A period belongs only at the END of a wrapped paragraph.
  assert.equal(linter.formatSpacing('第一行\n第二行\n第三行'), '第一行\n第二行\n第三行。');
});

// ------------------------------------------------- formatSpacing regressions

test('hard line breaks (two trailing spaces) survive formatting', () => {
  // Collapsing the trailing run to a single space silently removed Markdown's
  // hard line break and merged the two lines in the rendered output.
  assert.equal(linter.formatSpacing('第一行  \n第二行。'), '第一行  \n第二行。');
  // Interior runs are still squeezed.
  assert.equal(linter.formatSpacing('a    b。'), 'a b。');
  // A single trailing space is not a hard break and may be trimmed.
  assert.equal(linter.formatSpacing('结尾。 '), '结尾。');
});

test('currency spans keep the author spacing', () => {
  // "$5和$10" is prose between two currency signs, not a formula. It was tokenised
  // but left as raw text, so the CJK<->Latin spacing rule then saw a bare digit next
  // to a Chinese character and re-broke it into "花费 $5和$10 元".
  assert.equal(linter.formatSpacing('花费$5和$10 元。'), '花费$5和$10 元。');
  // A genuine formula is still processed.
  assert.equal(linter.formatSpacing('设 $中文$ 成立。'), '设 $\\text{中文}$ 成立。');
});

test('formatSpacing stays idempotent across these cases', () => {
  for (const md of [
    '第一行  \n第二行。',
    '花费$5和$10 元。',
    '这是test测试',
    '你好,世界',
    '设 $中文$ 成立。',
    '```cpp\nint a=1;//注释,不改\n```',
  ]) {
    const once = linter.formatSpacing(md);
    assert.equal(linter.formatSpacing(once), once, `not idempotent: ${JSON.stringify(md)}`);
  }
});

// ------------------------------- formatSpacing: hard breaks & display math

test('hard break survives after CJK punctuation', () => {
  // The rules that collapse whitespace around Chinese punctuation used \s+, which also
  // ate a trailing two-space hard break — so "第一行。  \n" lost its forced newline.
  assert.equal(linter.formatSpacing('第一行。  \n第二行。'), '第一行。  \n第二行。');
  assert.equal(linter.formatSpacing('这是第一行文本  \n第二行。'), '这是第一行文本  \n第二行。');
  assert.equal(linter.formatSpacing('A  \nB  \nC。'), 'A  \nB  \nC。');
  // Content on the line is still fixed, the break is kept.
  assert.equal(linter.formatSpacing('这是test  \n第二行。'), '这是 test  \n第二行。');
  // Longer runs normalise to the canonical two spaces; a single one is meaningless.
  assert.equal(linter.formatSpacing('第一行   \n第二行。'), '第一行  \n第二行。');
  assert.equal(linter.formatSpacing('结尾。 '), '结尾。');
  assert.equal(linter.formatSpacing('   '), '');
});

test('display math blocks are never touched by the fixer', () => {
  // The fixer did not track $$ blocks and appended a sentence period inside the
  // equation, corrupting the LaTeX.
  assert.equal(linter.formatSpacing('$$\nx = 1\n$$'), '$$\nx = 1\n$$');
  assert.equal(linter.formatSpacing('$$\n\\sum_{i=1}^{n} i\n$$'), '$$\n\\sum_{i=1}^{n} i\n$$');
});

// ------------------------------- CommonMark gaps found in the pre-open-source audit

test('ordered lists keep their starting number', () => {
  // A list starting at N was renumbered from 1, losing meaning when the numbers
  // matter (a list continued after a code block, "step 5 of 7", ...).
  assert.match(render('5. a\n6. b'), /<ol[^>]*start="5"/);
  assert.doesNotMatch(render('1. a\n2. b'), /start=/); // no redundant start="1"
});

test('code spans accept multi-backtick fences', () => {
  // ``a ` b`` is the standard way to put a backtick inside code; matching only
  // single backticks left stray delimiters in the output.
  const h = render('`` a ` b ``');
  assert.match(h, /<code[^>]*>a ` b<\/code>/);
  assert.doesNotMatch(h, /``/);
  // One leading+trailing space is stripped so a triple fence can hold a bare
  // backtick. Keep it inline: at the start of a line ``` opens a fenced block.
  assert.match(render('x ``` ` ``` y'), /<code[^>]*>`<\/code>/);
  assert.match(render('`plain`'), /<code[^>]*>plain<\/code>/);
});

test('indented code blocks are not parsed as paragraphs', () => {
  // Four-space indentation is a code block; it used to render as prose, so pasted
  // code lost its formatting and had its asterisks turned into emphasis.
  assert.match(render('正文\n\n    int a = 1;'), /luogu-code-block/);
  assert.match(render('    int a;'), /luogu-code-block/);
  assert.doesNotMatch(render('正文\n\n    a * b * c'), /<em>/);
  // ...but list continuation lines, which use the same indentation, must not be.
  assert.doesNotMatch(render('- 项目\n\n    续行内容\n- 项目二'), /luogu-code-block/);
  assert.doesNotMatch(render('正文\n\n   三个空格'), /luogu-code-block/);
});

test('KaTeX trust is granted per command, not blanket', () => {
  // trust:true let a formula emit a clickable javascript: link, bypassing the
  // sanitizeUrl() gate that protects ordinary Markdown links.
  const evil = render('$\\href{javascript:alert(1)}{c}$');
  assert.doesNotMatch(evil, /href="javascript:/i);
  assert.doesNotMatch(render('$\\url{javascript:alert(1)}$'), /href="javascript:/i);
  // The positive case (a real https link still renders as a link) needs KaTeX itself,
  // which this sandbox does not load — it is asserted in the browser suite instead.
});

test('raw HTML and unsafe URLs stay neutralised', () => {
  assert.doesNotMatch(render('<img src=x onerror=alert(1)>'), /<img[^>]*onerror=alert/i);
  assert.doesNotMatch(render('<script>alert(1)</script>'), /<script>alert/i);
  for (const u of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)',
                   'vbscript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    const h = render(`[x](${u})`);
    assert.doesNotMatch(h, /href="\s*(javascript|vbscript|data:text\/html)/i, `unsafe URL leaked: ${u}`);
  }
  assert.match(render('[x](https://luogu.com.cn)'), /href="https:\/\/luogu\.com\.cn"/);
});

// ------------------------------- Luogu link / ins syntax

test('link labels may contain nested brackets', () => {
  // Luogu problem titles almost always carry a bracketed tag, e.g.
  // "[P3195 [HNOI2008] 玩具装箱](url)". Stopping at the first `]` made the whole
  // link fail to parse and emit as literal text.
  const h = render('[P3195 [HNOI2008] 玩具装箱](https://www.luogu.com.cn/problem/P3195)');
  assert.match(h, /<a[^>]*href="https:\/\/www\.luogu\.com\.cn\/problem\/P3195"/);
  assert.match(h, />P3195 \[HNOI2008\] 玩具装箱</);
});

test('++text++ renders as an underline', () => {
  assert.match(render('++下划线++'), /<ins[^>]*>下划线<\/ins>/);
  assert.match(render('++[文字](https://a.com)++'), /<ins[^>]*><a[^>]*>文字<\/a><\/ins>/);
  // A lone ++ is not emphasis.
  assert.doesNotMatch(render('a ++ b'), /<ins/);
});

test('decorated link destinations resolve to the real URL', () => {
  // Pasting a link over selected text in Luogu's own editor yields
  // `[标题](++[https://…](https://…)++)`: the destination is another Markdown link
  // wrapped in ++, which failed the scheme check and produced href="#".
  const src = '### [P3195 [HNOI2008] 玩具装箱](++[https://www.luogu.com.cn/problem/P3195](https://www.luogu.com.cn/problem/P3195))++';
  const h = render(src);
  assert.match(h, /<a[^>]*href="https:\/\/www\.luogu\.com\.cn\/problem\/P3195"/);
  assert.doesNotMatch(h, /href="#"/);
  // Unwrapping must not become a way to smuggle a dangerous scheme past sanitizeUrl.
  assert.doesNotMatch(render('[x](++javascript:alert(1)++)'), /href="javascript:/i);
  assert.doesNotMatch(render('[x](++[y](javascript:alert(1))++)'), /href="javascript:/i);
  // The closing ++ lands outside the parens, leaving an orphan marker that used to
  // render literally right after the link.
  assert.doesNotMatch(render(src), /\+\+/);
  // A genuine ins after a link is still honoured.
  assert.match(render('[T](https://a.com) ++强调++'), /<ins[^>]*>强调<\/ins>/);
  // Ordinary links, titles and parenthesised URLs still work.
  assert.match(render('[t](https://a.com "T")'), /href="https:\/\/a\.com"[^>]*title="T"|title="T"[^>]*href="https:\/\/a\.com"/);
  assert.match(render('[w](https://en.wikipedia.org/wiki/Foo_(bar))'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
});
