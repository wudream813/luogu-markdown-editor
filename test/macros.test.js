// KaTeX \gdef support and, more importantly, its isolation.
//
// \gdef is deliberately global *within one document*: a definition has to reach
// every later formula, which means the macro table is shared state that survives
// across renderToString() calls. Shared mutable state is exactly the thing that
// leaks, so most of this suite is about the boundaries — a macro must not escape
// into the next render, into another parser, into KaTeX's built-in table, or into
// the memoized markup of an identically-worded formula somewhere else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const katex = require(path.join(__dirname, '../assets/katex/katex.min.js'));

function loadParserModule() {
  const sandbox = { window: {}, document: {}, console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/luogu-parser.js'), 'utf8'),
    sandbox
  );
  return sandbox.window.LuoguParser;
}

const LuoguParser = loadParserModule();
const mk = () => new LuoguParser({ katex });

// KaTeX echoes the formula source into <annotation>; strip it before asserting on
// what was actually rendered, or "the source mentioned AAA" reads as "AAA rendered".
const visible = (html) => html.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, '');
// Text of the MathML tree. A macro body expands to individual <mi>/<mn>/<mo>
// glyphs, so the literal string only reappears once the tags are removed.
const mathText = (html) => (visible(html).match(/<math[\s\S]*?<\/math>/g) || [])
  .map((m) => m.replace(/<[^>]*>/g, '')).join('\u0001');
// KaTeX renders an unknown control sequence as red text under throwOnError:false.
const hasUndefined = (html) => /color:#cc0000/.test(visible(html));

test('\\gdef reaches later formulas in the same document', () => {
  const html = mk().render('$\\gdef\\myA{ALPHA}\\myA$\n\n后续：$\\myA$');
  assert.strictEqual(mathText(html), 'ALPHA\u0001ALPHA');
  assert.ok(!hasUndefined(html));
});

test('\\gdef works when definition and use are in separate formulas', () => {
  const html = mk().render('$\\gdef\\myB{BETA}$\n\n$\\myB$ 与 $\\myB$');
  assert.strictEqual(mathText(html), '\u0001BETA\u0001BETA');
});

test('a display formula can define a macro an inline formula then uses', () => {
  const html = mk().render('$$\\gdef\\myC{GAMMA}\\myC$$\n\n行内 $\\myC$');
  assert.ok(!hasUndefined(html));
  assert.strictEqual(mathText(html), 'GAMMA\u0001GAMMA');
});

test('macros do not survive into the next render of the same parser', () => {
  const p = mk();
  p.render('$\\gdef\\myD{DELTA}\\myD$');
  assert.ok(hasUndefined(p.render('$\\myD$')),
    '第二次 render 不应认识上一次定义的宏');
});

test('macros do not leak between parser instances', () => {
  mk().render('$\\gdef\\myE{EPS}\\myE$');
  assert.ok(hasUndefined(mk().render('$\\myE$')));
});

test("macros do not pollute KaTeX's built-in table", () => {
  mk().render('$\\gdef\\myF{ZETA}\\myF$');
  // Rendered straight through KaTeX, bypassing the parser entirely.
  const raw = katex.renderToString('\\myF', { throwOnError: false });
  assert.ok(/color:#cc0000/.test(raw), '宏泄漏到了 KaTeX 全局默认宏表');
});

test('a macro only affects formulas that come after its definition', () => {
  // \zzUndef is chosen to not collide with any built-in (\gg, \R, \Z all exist).
  const html = mk().render('先用 $\\zzUndef$\n\n再定义 $\\gdef\\zzUndef{G}$');
  const before = visible(html).slice(0, visible(html).indexOf('再定义'));
  assert.ok(/color:#cc0000/.test(before), '定义不应反向作用于前面的公式');
});

test('the same formula text renders per-document, not from another document cache', () => {
  // The memoization key must include the macro context: both documents contain the
  // literal formula "$\x$", but it means something different in each.
  const a = mk().render('$\\gdef\\x{AAA}$\n\n$\\x$');
  const b = mk().render('$\\gdef\\x{BBB}$\n\n$\\x$');
  assert.ok(/AAA/.test(mathText(a)) && !/BBB/.test(mathText(a)));
  assert.ok(/BBB/.test(mathText(b)), '文档 B 复用了文档 A 的缓存结果');
  assert.ok(!/AAA/.test(mathText(b)), '文档 B 渲染出了文档 A 的宏内容');
});

test('a macro can be redefined mid-document', () => {
  const html = mk().render('$\\gdef\\y{ONE}$\n\n$\\y$\n\n$\\gdef\\y{TWO}$\n\n$\\y$');
  assert.strictEqual(mathText(html), '\u0001ONE\u0001\u0001TWO');
});

test('ordinary formulas are unaffected and still memoized', () => {
  const html = mk().render('$x^2$\n\n$x^2$\n\n$x^2$');
  assert.strictEqual(mathText(html), 'x2\u0001x2\u0001x2');
  assert.ok(!hasUndefined(html));
});

test('macros cannot smuggle a javascript: link past the trust gate', () => {
  const html = mk().render('$\\gdef\\evil{\\href{javascript:alert(1)}{click}}\\evil$');
  assert.ok(!/<a[^>]+href/i.test(html), '宏生成了可点击链接');
  assert.ok(!/javascript:/i.test(visible(html)), '渲染结果含 javascript: 协议');
});

test('macros cannot re-enable the blocked HTML extensions', () => {
  const html = mk().render('$\\gdef\\ev{\\htmlClass{x}{y}}\\ev$');
  assert.ok(!/class="x"/.test(html));
});

test('pathological macro definitions do not throw', () => {
  for (const src of [
    '$\\gdef\\loop{\\loop}\\loop$',          // self-recursive
    '$\\gdef\\bad{$',                        // unterminated body
    '$\\gdef\\empty{}\\empty$',              // empty body
    '$\\gdef\\add#1#2{#1+#2}\\add{a}{b}$',   // parameterised
    '$\\gdef\\frac{X}$\n\n$\\frac{1}{2}$',   // shadows a built-in
    '$\\gdef$',                              // no name at all
  ]) {
    assert.doesNotThrow(() => mk().render(src), `崩溃于: ${src}`);
  }
});

test('shadowing a built-in stays contained to its document', () => {
  mk().render('$\\gdef\\frac{SHADOW}$\n\n$\\frac{1}{2}$');
  const after = mk().render('$\\frac{1}{2}$');
  assert.ok(!/SHADOW/.test(mathText(after)), '被覆盖的内置命令泄漏到了别的文档');
});
