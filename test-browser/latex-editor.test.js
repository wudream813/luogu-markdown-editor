const { chromium } = require('playwright');
const path = require('path');
const FILE = process.argv[2] || 'file://' + path.resolve(__dirname, '../LuoguMarkdownEditor.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(FILE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(450);
  await page.evaluate(() => LuoguI18n.setLang('zh'));

  const setSource = async (text, start = text.length, end = start) => {
    await page.evaluate(({ text, start, end }) => {
      const textarea = document.getElementById('editorTextarea');
      textarea.value = text;
      textarea.focus();
      textarea.setSelectionRange(start, end);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }, { text, start, end });
    await page.waitForTimeout(40);
  };
  const source = () => page.evaluate(() => document.getElementById('editorTextarea').value);
  const checks = [];
  const check = (condition, label) => {
    checks.push([!!condition, label]);
    console.log(condition ? `  ✅ ${label}` : `  ❌ ${label}`);
  };

  // Ordinary delimiters pair only inside a formula, and the existing closer is skipped.
  await setSource('$');
  await page.keyboard.type('(');
  check(await source() === '$()', 'typing ( in math inserts a matching ) and leaves the caret inside');
  check(await page.evaluate(() => [...document.querySelectorAll('#findHighlights mark.latex-match-pair')]
    .map((mark) => mark.textContent).join('')) === '()', 'the two matching parentheses highlight at the caret');
  await page.keyboard.type(')');
  check(await source() === '$()', 'typing over an existing closing delimiter moves past it');
  await setSource('$');
  await page.waitForTimeout(150);
  await page.keyboard.type('(');
  await page.waitForTimeout(160);
  await page.keyboard.press('Control+z');
  check(await source() === '$', 'Ctrl+Z undoes an automatically paired delimiter as one edit');

  // The scalable TeX delimiters pair as commands, including escaped curly braces.
  await setSource('$\\left');
  await page.keyboard.type('(');
  check(await source() === '$\\left(\\right)', 'typing \\left( inserts the matching \\right)');
  await setSource('$\\left\\');
  await page.keyboard.type('{');
  check(await source() === '$\\left\\{\\right\\}', 'typing \\left\\{ inserts the escaped \\right\\}');

  // The environment closer is generated at the closing brace; existing ends are kept.
  await setSource('$\\begin');
  await page.keyboard.type('{');
  await page.keyboard.type('aligned');
  await page.keyboard.type('}');
  const environment = await source();
  check(environment === '$\\begin{aligned}\n\n\\end{aligned}',
    '\\begin{aligned} creates an editable body and the matching \\end{aligned}');
  check(await page.evaluate(() => {
    const ta = document.getElementById('editorTextarea');
    return ta.value.slice(ta.selectionStart - 1, ta.selectionStart) === '\n';
  }), 'the caret lands on the empty body line');

  const alreadyPaired = '$\\begin{aligned\nx+y\n\\end{aligned}$';
  await setSource(alreadyPaired, alreadyPaired.indexOf('\n'));
  await page.keyboard.type('}');
  check(await source() === '$\\begin{aligned}\nx+y\n\\end{aligned}$',
    'typing the begin brace does not duplicate an existing matching end environment');
  const existingBrace = '$\\begin{aligned}\nx+y\n\\end{aligned}$';
  await setSource(existingBrace, existingBrace.indexOf('}'));
  await page.keyboard.type('}');
  check(await source() === existingBrace, 'typing over an existing environment brace skips it without duplicating');

  // Suggestions: command names, keyboard selection, and environment snippets.
  await setSource('$\\al');
  check(await page.evaluate(() => !document.getElementById('latexCompletionPopup').hidden
    && [...document.querySelectorAll('.latex-completion-command')].some((item) => item.textContent === '\\alpha')),
    'typing a command prefix opens an anchored LaTeX completion list');
  await page.keyboard.press('Enter');
  check(await source() === '$\\alpha', 'Enter accepts a command suggestion without damaging the formula');
  check(await page.evaluate(() => document.getElementById('latexCompletionPopup').hidden),
    'the completion list closes after acceptance');

  await setSource('$\\begin{ali');
  check(await page.evaluate(() => [...document.querySelectorAll('.latex-completion-command')]
    .some((item) => item.textContent === '\\begin{aligned}')),
    'typing an environment prefix suggests aligned');
  await page.keyboard.press('Tab');
  check(await source() === '$\\begin{aligned}\n\n\\end{aligned}',
    'Tab accepts an environment snippet and inserts its matching end');
  check(await page.evaluate(() => document.getElementById('editorTextarea').selectionStart
    === '$\\begin{aligned}\n'.length), 'environment completion puts the caret on the body line');

  // Ordinary Markdown brackets now pair too; inline and fenced code remain literal.
  await setSource('regular prose');
  await page.keyboard.type('(');
  check(await source() === 'regular prose()', 'ordinary prose auto-pairs parentheses');
  await page.keyboard.type(')');
  check(await source() === 'regular prose()', 'an existing prose closer is skipped');
  await setSource('regular prose');
  await page.keyboard.type('[');
  check(await source() === 'regular prose[]', 'square brackets auto-pair in prose');
  await setSource('regular prose');
  await page.keyboard.type('{');
  check(await source() === 'regular prose{}', 'curly braces auto-pair in prose');
  await setSource('```tex\n$\n```', 8);
  await page.keyboard.type('(');
  check(await source() === '```tex\n$(\n```', 'a fenced code block is left untouched');
  await setSource('`code`', 5);
  await page.keyboard.type('(');
  check(await source() === '`code(`', 'inline code is left untouched');
  await setSource('hello', 0, 5);
  await page.keyboard.type('(');
  check(await source() === '(hello)', 'typing an opener wraps a selected Markdown phrase');
  await setSource('$xy$', 1, 3);
  await page.keyboard.type('(');
  check(await source() === '$(xy)$', 'typing an opener wraps a selection inside a formula');

  // Matching for a full \left...\right pair also works when the cursor is placed later.
  const matchSource = '$\\left( x + (y) \\right)$';
  await setSource(matchSource, matchSource.indexOf('(') + 1);
  const highlighted = await page.evaluate(() => [...document.querySelectorAll('#findHighlights mark.latex-match-pair')]
    .map((mark) => mark.textContent).join(''));
  check(highlighted === '()', 'moving the caret to a \left delimiter highlights both ends');
  await setSource('text (not math)');
  check(await page.evaluate(() => [...document.querySelectorAll('#findHighlights mark.latex-match-pair')]
    .map((mark) => mark.textContent).join('')) === '()',
    'matching parentheses are highlighted in ordinary Markdown prose too');

  check(errors.length === 0, 'no browser JavaScript errors', errors.slice(0, 3).join(' | '));
  const failures = checks.filter(([pass]) => !pass);
  console.log(`\nLaTeX editor ${checks.length} checks, ${failures.length} failures`);
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
