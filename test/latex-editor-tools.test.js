const test = require('node:test');
const assert = require('node:assert/strict');
const Latex = require('../src/latex-editor-tools.js');

function matching(text, token, offset = 0) {
  const at = text.indexOf(token, offset);
  assert.notEqual(at, -1, `missing token ${token}`);
  return Latex.findMatchingDelimiter(text, at + (token.length === 1 ? 0 : 1));
}

test('LaTeX completion is limited to math source and filters command prefixes', () => {
  const source = '$\\al';
  const context = Latex.getCompletionContext(source, source.length);
  assert.deepEqual(context, { type: 'command', start: 1, end: 4, prefix: 'al' });
  assert.ok(Latex.getLatexSuggestions(context).some((item) => item.display === '\\alpha'));
  assert.equal(Latex.getCompletionContext('\\al', 3), null, 'plain Markdown prose is not treated as math');
  assert.equal(Latex.getCompletionContext('`$\\al`', 6), null, 'inline code is ignored');
  assert.equal(Latex.getCompletionContext('```tex\n$\\al\n```', 11), null, 'fenced code is ignored');
  const indented = '    $\\al';
  assert.equal(Latex.getCompletionContext(indented, indented.length), null, 'indented code is ignored');
  const complete = '$\\alpha';
  assert.deepEqual(Latex.getLatexSuggestions(Latex.getCompletionContext(complete, complete.length)), [],
    'a completed command does not keep the menu open');
});

test('environment suggestions and matching-end detection handle nesting and comments', () => {
  const partial = '$\\begin{ali';
  const context = Latex.getCompletionContext(partial, partial.length);
  assert.deepEqual(context, { type: 'environment', start: 8, end: 11, prefix: 'ali' });
  assert.deepEqual(
    Latex.getLatexSuggestions(context).slice(0, 3).map((item) => item.name),
    ['aligned', 'align', 'alignat'],
  );
  const bare = '$\\begin';
  const beginContext = Latex.getCompletionContext(bare, bare.length);
  assert.equal(beginContext.type, 'begin-command');
  assert.ok(Latex.getLatexSuggestions(beginContext).some((item) => item.name === 'cases'));

  assert.equal(Latex.hasMatchingEnvironmentEnd(
    '$\\begin{aligned}\\begin{aligned}x\\end{aligned}\\end{aligned}$', 'aligned', 16,
  ), true, 'the outer end is found after balancing a nested environment');
  assert.equal(Latex.hasMatchingEnvironmentEnd(
    '$\\begin{aligned}x% \\end{aligned}\n+y$', 'aligned', 17,
  ), false, 'an end command on a TeX comment is ignored');
  assert.equal(Latex.hasMatchingEnvironmentEnd(
    '$\\begin{aligned}x\n```tex\n\\end{aligned}\n```$', 'aligned', 17,
  ), false, 'an end command inside a Markdown fence is ignored');
  const unrelated = '$\\begin{aligned}x$ text \\end{aligned} $y$';
  assert.equal(Latex.hasMatchingEnvironmentEnd(
    unrelated, 'aligned', unrelated.indexOf('}') + 1,
  ), false, 'an end command in later prose or another formula does not suppress completion');
});

test('matching highlights nested ordinary delimiters and escaped TeX braces', () => {
  const text = '$\\frac{a + (b)}{c}$';
  const openParen = text.indexOf('(');
  const paren = Latex.findMatchingDelimiter(text, openParen);
  assert.equal(text.slice(paren.open.start, paren.open.end), '(');
  assert.equal(text.slice(paren.close.start, paren.close.end), ')');
  assert.equal(paren.kind, 'paren');

  const braces = '$\\{x + \\{y\\}\\}$';
  const open = braces.indexOf('\\{');
  const pair = Latex.findMatchingDelimiter(braces, open + 1);
  assert.equal(braces.slice(pair.open.start, pair.open.end), '\\{');
  assert.equal(braces.slice(pair.close.start, pair.close.end), '\\}');
});

test('matching highlights prose and \u005cleft...\u005cright while ignoring code', () => {
  const text = '$\\left( x + (y) \\right)$';
  const outer = Latex.findMatchingDelimiter(text, text.indexOf('('));
  assert.equal(outer.kind, 'latex-left-right');
  assert.equal(text.slice(outer.open.start, outer.open.end), '(');
  assert.equal(text.slice(outer.close.start, outer.close.end), ')');
  const inner = Latex.findMatchingDelimiter(text, text.indexOf('(y)'));
  assert.equal(inner.kind, 'paren');

  const prose = 'text (x)';
  const prosePair = Latex.findMatchingDelimiter(prose, prose.indexOf('('));
  assert.equal(prose.slice(prosePair.open.start, prosePair.open.end), '(');
  assert.equal(prose.slice(prosePair.close.start, prosePair.close.end), ')');
  assert.equal(Latex.findMatchingDelimiter('text `code (x)`', 11), null, 'inline code stays untouched');
  assert.equal(Latex.findMatchingDelimiter('```tex\n$(x)$\n```', 9), null);
});

test('begin completion only triggers at a math environment name', () => {
  const source = '$\\begin{aligned';
  assert.deepEqual(Latex.getEnvironmentAtCloseBrace(source, source.length), {
    name: 'aligned', start: 1, end: source.length,
  });
  assert.equal(Latex.getEnvironmentAtCloseBrace('\\begin{aligned', 15), null);
  assert.equal(Latex.getEnvironmentAtCloseBrace('$% \\begin{aligned', 17), null);
});
