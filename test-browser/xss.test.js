const { chromium } = require('playwright');
const path=require('path');
const FILE = process.argv[2] || 'file://'+path.resolve(__dirname,'../LuoguMarkdownEditor.html');

const VECTORS = [
  ['script 标签',            '<script>window.__x=1</script>'],
  ['img onerror',            '<img src=x onerror="window.__x=1">'],
  ['svg onload',             '<svg onload="window.__x=1">'],
  ['iframe srcdoc',          '<iframe srcdoc="<script>parent.__x=1</script>"></iframe>'],
  ['body onload',            '<body onload="window.__x=1">'],
  ['details ontoggle',       '<details open ontoggle="window.__x=1">'],
  ['link js: 协议',           '[点我](javascript:window.__x=1)'],
  ['link JAVASCRIPT 大写',    '[点我](JAVASCRIPT:window.__x=1)'],
  ['link js: 制表符',         '[点我](java\tscript:window.__x=1)'],
  ['link js: 换行',           '[点我](java\nscript:window.__x=1)'],
  ['link js: 空字节',         '[点我](java\u0000script:window.__x=1)'],
  ['link data:html',         '[点我](data:text/html,<script>window.__x=1</script>)'],
  ['link vbscript',          '[点我](vbscript:window.__x=1)'],
  ['img src js:',            '![](javascript:window.__x=1)'],
  ['img onerror via title',  '![a](x.png "onerror=alert(1)")'],
  ['属性逃逸 引号',           '[a](x.png" onmouseover="window.__x=1)'],
  ['代码块 lang 逃逸',        '```js" onload="window.__x=1\ncode\n```'],
  ['代码块 lang 尖括号',      '```<img src=x onerror=window.__x=1>\ncode\n```'],
  ['容器名逃逸',              ':::info" onload="window.__x=1\n内容\n:::'],
  ['表格单元格 html',         '| <img src=x onerror=window.__x=1> | b |\n|---|---|\n| 1 | 2 |'],
  ['bilibili BV 逃逸',        '![](bilibili:BV1" onload="window.__x=1)'],
  ['KaTeX \\href js:',        '$\\href{javascript:window.__x=1}{click}$'],
  ['KaTeX \\htmlClass',       '$\\htmlClass{x" onload="window.__x=1}{y}$'],
  ['KaTeX \\includegraphics', '$\\includegraphics[width=1]{x.png" onerror="window.__x=1}$'],
  ['引用内 html',             '> <img src=x onerror=window.__x=1>'],
  ['列表内 html',             '- <img src=x onerror=window.__x=1>'],
  ['标题内 html',             '# <img src=x onerror=window.__x=1>'],
  ['行内代码内 html',         '`<img src=x onerror=window.__x=1>`'],
  ['HTML 实体绕过',           '&lt;img src=x onerror=window.__x=1&gt;'],
  ['双重编码',                '%3Cimg%20src=x%20onerror=window.__x=1%3E'],
  ['mailto 正常',            '[mail](mailto:a@b.com)'],
  ['https 正常',             '[link](https://luogu.com.cn)'],
];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1280,height:800} });
  const dialogs=[]; p.on('dialog', d=>{dialogs.push(d.message()); d.dismiss();});
  const errs=[]; p.on('pageerror', e=>errs.push(e.message));
  await p.goto(FILE); await p.waitForTimeout(2600);

  let bad=0;
  for (const [name, md] of VECTORS) {
    await p.evaluate(()=>{ window.__x=undefined; });
    await p.evaluate(v=>{const t=document.querySelector('textarea');t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));}, md);
    await p.waitForTimeout(280);
    const r = await p.evaluate(()=>({
      fired: window.__x===1,
      // any live event-handler attribute or script tag that survived into the DOM
      // The renderer legitimately emits a few fixed inline handlers of its own
      // (copy button, image-error fallback, bilibili lazy-load). Those are static
      // strings in the source, never attacker input, so match them exactly and
      // flag only handlers whose VALUE is not one of them.
      handlers: (()=>{ const OK=[
          'copyCodeBlock(this)','loadBilibiliPlayer(this)',
          "this.classList.add('luogu-img-error'); this.alt='[图片加载失败: ' + this.alt + ']';"];
        const out=[];
        document.querySelectorAll('#previewContent *').forEach(e=>{
          [...e.attributes].filter(a=>/^on/i.test(a.name))
            .filter(a=>!OK.includes(a.value.trim()))
            .forEach(a=>out.push(e.tagName+' '+a.name+'="'+a.value.slice(0,80)+'"'));
        }); return out; })(),
      scripts: document.querySelectorAll('#previewContent script').length,
      iframes: [...document.querySelectorAll('#previewContent iframe')].map(f=>f.src||'srcdoc:'+(f.getAttribute('srcdoc')||'').slice(0,30)),
      badhref: [...document.querySelectorAll('#previewContent a[href],#previewContent img[src]')]
        .map(e=>e.getAttribute('href')||e.getAttribute('src'))
        .filter(u=>/^\s*(javascript|data:text\/html|vbscript)/i.test((u||'').replace(/[\u0000-\u0020]/g,''))),
    }));
    const fail = r.fired || r.handlers.length || r.scripts || r.badhref.length;
    if (fail) { bad++; console.log(`❌ ${name}`); console.log('   ', JSON.stringify(r)); }
  }
  console.log(`\nXSS 向量 ${VECTORS.length} 个，命中 ${bad} 个`);
  if (bad) process.exitCode = 1;
  if (dialogs.length) console.log('弹窗:', dialogs);
  if (errs.length) console.log('页面异常:', errs.slice(0,5));
  await b.close();
})();
