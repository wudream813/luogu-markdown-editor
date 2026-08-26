// Render every case with a given parser file and dump a JSON snapshot.
// Usage: node test/snapshot.js <parser.js> <out.json>
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cases = require('../test/cases.js');

const parserPath = process.argv[2] || path.join(__dirname, '../src/luogu-parser.js');
const outPath = process.argv[3];

const sandbox = { window: {}, document: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(parserPath, 'utf8'), sandbox);
const LuoguParser = sandbox.window.LuoguParser;

const parser = new LuoguParser();
const out = {};
for (const [name, md] of cases) {
  try {
    out[name] = parser.render(md);
  } catch (e) {
    out[name] = `__THREW__ ${e.message}`;
  }
}

const json = JSON.stringify(out, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, json);
  console.log(`wrote ${Object.keys(out).length} snapshots -> ${outPath}`);
} else {
  process.stdout.write(json);
}
