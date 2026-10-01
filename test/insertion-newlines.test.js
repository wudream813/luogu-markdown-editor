const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/i18n.js');
require('../src/i18n-en.js');
const { LuoguEditorApp } = require('../src/editor.js');

function inserted(method, ...args) {
  const editor = new LuoguEditorApp();
  let result;
  editor.insertAtCursor = value => { result = value; };
  editor[method](...args);
  return result;
}
for (const lang of ['zh', 'en']) {
  test(`${lang}: callout insertion uses real line breaks, including translated text`, () => {
    i18n.setLang(lang);
    for (const type of ['info', 'success', 'warning', 'error']) {
      const result = inserted('insertCallout', type, '$\\neq$ title', true);
      assert.ok(result.startsWith(`\n\n::::${type}[$\\neq$ title]{open}\n`));
      assert.ok(result.endsWith('\n::::\n\n'));
      assert.equal(result.split('\n').length, 7);
      assert.ok(result.includes('$\\neq$')); // do not globally replace legitimate LaTeX commands
      assert.ok(result.includes(lang === 'en' ? 'This is the body' : '折叠框的内容'));
    }
  });
  test(`${lang}: epigraph insertion uses real line breaks and preserves user escapes`, () => {
    i18n.setLang(lang);
    const body = 'First line\nSecond line with $\\neq$ and literal \\n';
    assert.equal(inserted('insertEpigraph', 'Author', body), `\n\n:::epigraph[——Author]\n${body}\n:::\n\n`);
    const result = inserted('insertEpigraph', '', '');
    assert.ok(result.startsWith('\n\n:::epigraph\n'));
    assert.ok(result.endsWith('\n:::\n\n'));
    assert.ok(!result.includes('\\n'));
    assert.ok(result.includes(lang === 'en' ? 'A journey' : '千里之行'));
  });
}
