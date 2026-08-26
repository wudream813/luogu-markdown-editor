const fs = require('fs');
const path = require('path');

const baseDir = '/home/user/luogu-markdown-editor';

// 1. Read Katex CSS and embed all woff2 fonts as Base64 Data URIs
let katexCss = fs.readFileSync(path.join(baseDir, 'assets/katex/katex.min.css'), 'utf8');

const fontsDir = path.join(baseDir, 'assets/katex/fonts');
const fontFiles = fs.readdirSync(fontsDir);

for (const file of fontFiles) {
  if (file.endsWith('.woff2')) {
    const filePath = path.join(fontsDir, file);
    const fontData = fs.readFileSync(filePath);
    const base64 = fontData.toString('base64');
    const dataUri = `data:font/woff2;base64,${base64}`;
    
    // Replace url(fonts/KaTeX_...woff2) or url("fonts/KaTeX_...woff2")
    const regex = new RegExp(`url\\(["']?fonts\\/${file}["']?\\)`, 'g');
    katexCss = katexCss.replace(regex, `url("${dataUri}")`);
  }
}

// 2. Read Prism & App CSS
const prismCss = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-tomorrow.min.css'), 'utf8');
const appCss = fs.readFileSync(path.join(baseDir, 'src/styles.css'), 'utf8');

// 3. Read JS files
const katexJs = fs.readFileSync(path.join(baseDir, 'assets/katex/katex.min.js'), 'utf8');
const prismJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism.js'), 'utf8');
const prismCJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-c.min.js'), 'utf8');
const prismCppJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-cpp.min.js'), 'utf8');
const prismPyJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-python.min.js'), 'utf8');
const prismJavaJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-java.min.js'), 'utf8');
const prismPascalJs = fs.readFileSync(path.join(baseDir, 'assets/prism/prism-pascal.min.js'), 'utf8');

const parserJs = fs.readFileSync(path.join(baseDir, 'src/luogu-parser.js'), 'utf8');
const linterJs = fs.readFileSync(path.join(baseDir, 'src/luogu-linter.js'), 'utf8');
const mathCheatsheetJs = fs.readFileSync(path.join(baseDir, 'src/luogu-math-cheatsheet.js'), 'utf8');
const templatesJs = fs.readFileSync(path.join(baseDir, 'src/luogu-templates.js'), 'utf8');
let editorJs = fs.readFileSync(path.join(baseDir, 'src/editor.js'), 'utf8');

// 4. Read template HTML
let indexHtml = fs.readFileSync(path.join(baseDir, 'index.html'), 'utf8');

// Replace CSS links with inline <style>
const inlineStyles = `
  <style>
    ${katexCss}
  </style>
  <style>
    ${prismCss}
  </style>
  <style>
    ${appCss}
  </style>
`;

indexHtml = indexHtml.replace(/<link rel="stylesheet" href="assets\/katex\/katex\.min\.css">[\s\S]*?<link rel="stylesheet" href="src\/styles\.css">/, () => inlineStyles);

// Replace JS script tags with inline <script>
const inlineScripts = `
  <script>${katexJs}</script>
  <script>${prismJs}</script>
  <script>${prismCJs}</script>
  <script>${prismCppJs}</script>
  <script>${prismPyJs}</script>
  <script>${prismJavaJs}</script>
  <script>${prismPascalJs}</script>
  <script>${parserJs}</script>
  <script>${linterJs}</script>
  <script>${mathCheatsheetJs}</script>
  <script>${templatesJs}</script>
  <script>${editorJs}</script>
`;

indexHtml = indexHtml.replace(/<!-- Scripts -->[\s\S]*?<\/body>/, () => `${inlineScripts}\n</body>`);

fs.writeFileSync(path.join(baseDir, 'LuoguMarkdownEditor.html'), indexHtml, 'utf8');
console.log('Successfully generated standalone single-file: LuoguMarkdownEditor.html (Size: ' + Math.round(indexHtml.length / 1024) + ' KB)');
