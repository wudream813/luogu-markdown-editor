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
  const time = (md) => {
    const t = Date.now();
    render(md);
    return Date.now() - t;
  };

  const small = build(500);
  const large = build(2000); // 4x the content

  // Warm up so KaTeX/JIT effects do not distort the ratio.
  time(small);

  const tSmall = Math.max(time(small), 1);
  const tLarge = time(large);

  // Quadratic behaviour would give ~16x for a 4x size increase. Allow generous
  // headroom for noise on shared CI runners but still fail on a return to O(n^2).
  const ratio = tLarge / tSmall;
  assert.ok(ratio < 10, `render appears super-linear: 4x size cost ${ratio.toFixed(1)}x`);
});
