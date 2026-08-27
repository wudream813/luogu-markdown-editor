const { chromium } = require('playwright');
const path=require('path');
const FILE = process.argv[2] || 'file://'+path.resolve(__dirname,'../LuoguMarkdownEditor.html');
// Functional-fidelity probes: does the preview match what Markdown/Luogu actually mean?
const CASES = [
  ['ATX 标题',            '# H1\n## H2\n###### H6',                       s=>/<h1[^>]*>H1/.test(s)&&/<h6[^>]*>H6/.test(s)],
  ['7 个 # 不是标题',      '####### x',                                    s=>!/<h[1-6]/.test(s)],
  ['# 后无空格不是标题',   '#NotHeading',                                  s=>!/<h1/.test(s)],
  ['粗体/斜体',           '**b** *i* ***bi***',                           s=>/<strong>b<\/strong>/.test(s)&&/<em>i<\/em>/.test(s)],
  ['删除线',              '~~del~~',                                      s=>/<del>del<\/del>|<s>del<\/s>/.test(s)],
  ['行内代码',            '`code`',                                       s=>/<code[^>]*>code<\/code>/.test(s)],
  ['行内代码含反引号',     '`` a ` b ``',                                  s=>/<code[^>]*>.*`.*<\/code>/.test(s)],
  ['无序列表',            '- a\n- b',                                     s=>(s.match(/<li/g)||[]).length===2],
  ['有序列表',            '1. a\n2. b',                                   s=>/<ol/.test(s)&&(s.match(/<li/g)||[]).length===2],
  ['有序列表起始号',       '5. a\n6. b',                                   s=>/start="5"/.test(s)],
  ['嵌套列表',            '- a\n  - b',                                   s=>/<ul[\s\S]*<ul/.test(s)],
  ['任务列表',            '- [ ] a\n- [x] b',                             s=>(s.match(/type="checkbox"/g)||[]).length===2&&/checked/.test(s)],
  ['引用',                '> q',                                          s=>/<blockquote/.test(s)],
  ['嵌套引用',            '> a\n> > b',                                   s=>/<blockquote[\s\S]*<blockquote/.test(s)],
  ['分隔线',              '---',                                          s=>/<hr/.test(s)],
  ['表格',                '| a | b |\n|---|---|\n| 1 | 2 |',              s=>/<table/.test(s)&&(s.match(/<td/g)||[]).length===2],
  ['表格对齐',            '| a |\n|:-:|\n| 1 |',                          s=>/center/.test(s)],
  ['围栏代码',            '```cpp\nint a;\n```',                          s=>/language-cpp/.test(s)],
  ['缩进代码块',          '    int a;',                                   s=>/<pre|<code/.test(s)],
  ['链接',                '[t](https://a.com)',                           s=>/<a[^>]*href="https:\/\/a\.com"[^>]*>t<\/a>/.test(s)],
  ['链接 title',          '[t](https://a.com "T")',                       s=>/title="T"/.test(s)],
  ['图片',                '![alt](x.png)',                                s=>/<img[^>]*src="x\.png"/.test(s)],
  ['自动链接',            '<https://a.com>',                              s=>/href="https:\/\/a\.com"/.test(s)],
  ['行内公式',            '$x^2$',                                        s=>/katex/.test(s)],
  ['块级公式',            '$$\nx^2\n$$',                                  s=>/katex-display|katex/.test(s)],
  ['转义字符',            '\\*not italic\\*',                             s=>!/<em>/.test(s)&&/\*not italic\*/.test(s)],
  ['HTML 实体',           '&amp; &lt;',                                   s=>/&amp;|&/.test(s)],
  ['硬换行 两空格',        'a  \nb',                                       s=>/<br/.test(s)],
  ['硬换行 反斜杠',        'a\\\nb',                                       s=>/<br/.test(s)],
  ['软换行不产生 br',      'a\nb',                                         s=>!/<br/.test(s)],
  ['段落分隔',            'a\n\nb',                                       s=>(s.match(/<p[^>]*class="luogu-p"/g)||[]).length===2],
  ['容器 info',           ':::info\nx\n:::',                              s=>/luogu-callout-info/.test(s)],
  ['容器 warning',        ':::warning\nx\n:::',                           s=>/warning/.test(s)],
  ['折叠框',              ':::info[标题]\nx\n:::',                        s=>/<details|luogu-container/.test(s)],
  ['未知容器名字面输出',   ':::nosuch\nx\n:::',                            s=>/luogu-unknown-container/.test(s)],
  ['bilibili',            '![](bilibili:BV1xx411c7mD)',                   s=>/luogu-bilibili/.test(s)],
];
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(FILE); await p.waitForTimeout(2600);
  let bad=0;
  for(const [n,md,check] of CASES){
    await p.evaluate(v=>{const t=document.querySelector('textarea');t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));},md);
    await p.waitForTimeout(240);
    const h=await p.evaluate(()=>document.querySelector('#previewContent').innerHTML);
    if(!check(h)){bad++;console.log(`❌ ${n}\n    输入 ${JSON.stringify(md)}\n    输出 ${h.replace(/\s+/g,' ').slice(0,220)}`);}
  }
  console.log(`\n保真度 ${CASES.length} 项，偏差 ${bad} 项`);
  if (bad) process.exitCode = 1;
  if(errs.length) console.log('异常:',[...new Set(errs)].slice(0,5));
  await b.close();
})();
