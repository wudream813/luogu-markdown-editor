/**
 * Export fidelity: the standalone HTML must render maths and code exactly like the
 * preview pane. Two real regressions motivated this suite: the export template
 * hardcoded `.katex { font: normal 1.15em }` (KaTeX's own default is 1.21em, so every
 * formula came out slightly small) and it used a different monospace stack than the
 * editor's --font-mono, so code changed shape on export.
 */
const path = require('path');
const { chromium } = require('playwright');

const DOC = [
  '# 导出对比', '',
  '行内 $x^2+\\frac{1}{2}$ 文字。', '',
  '$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$', '',
  '```cpp',
  '#include <bits/stdc++.h>   // 注释',
  'using namespace std;',
  'int main(){',
  '  string s = "hello";',
  '  int a = 42;',
  '  if (a > 0) return 0;',
  '}',
  '```', '',
  '| 甲 | 乙 |', '|:--:|:--:|', '| 1 | 2 |', '',
].join('\n');

const SNAP = `(function(root){
  const q = (s) => document.querySelector(root === 'body' ? s : root + ' ' + s);
  const qa = (s) => document.querySelectorAll(root === 'body' ? s : root + ' ' + s);
  const out = { tokens: {} };
  const k = q('.katex');
  if (k) {
    const cs = getComputedStyle(k);
    out.mathSize = cs.fontSize;
    out.mathFamily = cs.fontFamily;
    out.mathW = Math.round(k.getBoundingClientRect().width);
    out.mathH = Math.round(k.getBoundingClientRect().height);
  }
  for (const cls of ['comment','keyword','string','number','function','operator','punctuation','macro']) {
    const t = q('.token.' + cls);
    out.tokens[cls] = t ? getComputedStyle(t).color : null;
  }
  const pre = q('pre');
  if (pre) {
    out.codeFamily = getComputedStyle(pre).fontFamily;
    out.codeSize = getComputedStyle(pre).fontSize;
  }
  out.tokenTotal = qa('.token').length;
  out.tableCount = qa('table').length;
  return out;
})`;

(async () => {
  const url = process.argv[2] || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };

  const p = await b.newPage({ viewport: { width: 1000, height: 800 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.evaluate((v) => {
    const ta = document.getElementById('editorTextarea');
    ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
    LuoguEditor.render(); LuoguEditor.setViewMode('preview');
  }, DOC);
  await p.waitForTimeout(800);
  const prev = await p.evaluate((s) => eval(s)('#previewContent'), SNAP);

  const html = await p.evaluate(async () => {
    let cap = null;
    const OB = window.Blob;
    window.Blob = class extends OB {
      constructor(parts, o) { super(parts, o); if (o && /html/.test(o.type || '')) cap = parts[0]; }
    };
    window.showSaveFilePicker = undefined;
    HTMLAnchorElement.prototype.click = function () {};
    await LuoguEditor.exportStandaloneHTML();
    window.Blob = OB;
    return cap;
  });
  await p.close();

  ck(typeof html === 'string' && html.length > 1000, '导出产生 HTML');
  ck(/@font-face\s*\{[^}]*KaTeX_/.test(html), 'KaTeX 字体已内嵌');
  ck((html.match(/url\(["']?data:font/g) || []).length > 5, '字体为 base64 内嵌（离线可用）');
  ck(!/(?:src|href)="https?:\/\//.test(html), '无外链资源');
  ck(/\.token\.(comment|keyword)/.test(html), 'Prism 配色已内嵌');

  const q = await b.newPage({ viewport: { width: 1000, height: 800 } });
  const eerrs = [];
  q.on('pageerror', (e) => eerrs.push(e.message));
  await q.setContent(html, { waitUntil: 'networkidle' });
  await q.waitForTimeout(800);
  const exp = await q.evaluate((s) => eval(s)('body'), SNAP);

  ck(eerrs.length === 0, '导出文件无 JS 报错', eerrs.join(';'));
  ck(exp.mathSize === prev.mathSize, `公式字号一致 (${prev.mathSize})`, `预览 ${prev.mathSize} vs 导出 ${exp.mathSize}`);
  ck(exp.mathFamily === prev.mathFamily, '公式字体族一致');
  ck(Math.abs(exp.mathW - prev.mathW) <= 1, '公式宽度一致', `${prev.mathW} vs ${exp.mathW}`);
  ck(Math.abs(exp.mathH - prev.mathH) <= 1, '公式高度一致', `${prev.mathH} vs ${exp.mathH}`);
  ck(exp.codeFamily === prev.codeFamily, '代码字体族一致', `${prev.codeFamily} vs ${exp.codeFamily}`);
  ck(exp.codeSize === prev.codeSize, '代码字号一致', `${prev.codeSize} vs ${exp.codeSize}`);
  ck(exp.tokenTotal === prev.tokenTotal, '高亮 token 数一致', `${prev.tokenTotal} vs ${exp.tokenTotal}`);
  ck(exp.tableCount === prev.tableCount, '表格数一致');

  // 页面必须可滚动：曾因导出内联了编辑器外壳的 html,body{overflow:hidden;height:100%}
  // 导致长文档卡在首屏。
  const scroll = await q.evaluate(() => {
    const de = document.documentElement;
    return { ov: getComputedStyle(de).overflow, bov: getComputedStyle(document.body).overflow };
  });
  ck(scroll.ov !== 'hidden' && scroll.bov !== 'hidden', '导出页面未锁定 overflow',
    JSON.stringify(scroll));

  const tall = await q.evaluate(() => {
    const d = document.createElement('div');
    d.style.height = '3000px';
    document.body.appendChild(d);
    window.scrollTo(0, 400);
    const y = window.scrollY || document.documentElement.scrollTop;
    d.remove();
    window.scrollTo(0, 0);
    return y;
  });
  ck(tall > 0, '导出页面可以滚动', `scrollY=${tall}`);

  for (const k of Object.keys(prev.tokens)) {
    if (prev.tokens[k] === null) continue;
    ck(exp.tokens[k] === prev.tokens[k], `token 配色一致: ${k}`, `${prev.tokens[k]} vs ${exp.tokens[k]}`);
  }

  // ---- 要求 36: 嵌套折叠框各用自身类型色 ----------------------------------------
  {
    const MD=[':::::warning[父容器]{open}','父层文字。','',
      '::::success[子容器]{open}','子层文字。','',
      ':::error[孙容器]{open}','孙层文字。',':::','::::',':::::'].join('\n');
    const PROBE=(scoped)=>{
      const sel=scoped?'#previewContent details.luogu-callout':'details.luogu-callout';
      return [...document.querySelectorAll(sel)].map((d)=>{
        const sm=d.querySelector(':scope > summary');
        return {type:(d.className.match(/luogu-callout-(\w+)/)||[])[1],
          edge:getComputedStyle(d).borderLeftColor,
          bg:sm?getComputedStyle(sm).backgroundColor:null,
          fg:sm?getComputedStyle(sm).color:null};});
    };
    const pg=await b.newPage({viewport:{width:1000,height:800}});
    await pg.goto(url,{waitUntil:'networkidle'});
    await pg.evaluate((v)=>{const ta=document.getElementById('editorTextarea');
      ta.value=v;ta.dispatchEvent(new Event('input',{bubbles:true}));
      LuoguEditor.render();LuoguEditor.setViewMode('preview');},MD);
    await pg.waitForTimeout(500);
    const prev=await pg.evaluate((f)=>eval('('+f+')')(true),PROBE.toString());
    const html=await pg.evaluate(async()=>{let cap=null;const OB=window.Blob;
      window.Blob=class extends OB{constructor(parts,o){super(parts,o);
        if(o&&/html/.test(o.type||''))cap=parts[0];}};
      window.showSaveFilePicker=undefined;
      HTMLAnchorElement.prototype.click=function(){};
      await LuoguEditor.exportStandaloneHTML();window.Blob=OB;return cap;});
    await pg.close();
    const out=await b.newPage({viewport:{width:1000,height:800}});
    await out.setContent(html,{waitUntil:'networkidle'});
    await out.waitForTimeout(400);
    const exp=await out.evaluate((f)=>eval('('+f+')')(false),PROBE.toString());
    await out.close();
    ck(exp.length===3,'导出保留三层折叠框',String(exp.length));
    ck(exp.map(x=>x.type).join(',')==='warning,success,error','层级类型正确',
      exp.map(x=>x.type).join(','));
    ck(new Set(exp.map(x=>x.edge)).size===3,'三层边框色互不相同',
      JSON.stringify([...new Set(exp.map(x=>x.edge))]));
    ck(new Set(exp.map(x=>x.bg)).size===3,'三层标题底色互不相同',
      JSON.stringify([...new Set(exp.map(x=>x.bg))]));
    for(let i=0;i<3;i++){
      ck(exp[i].edge===prev[i].edge&&exp[i].bg===prev[i].bg&&exp[i].fg===prev[i].fg,
        `第 ${i+1} 层配色与预览一致`,`${JSON.stringify(prev[i])} vs ${JSON.stringify(exp[i])}`);
    }
  }

  // ---- 要求 40: 导出件的目录 ------------------------------------------------------
  {
    const secs=['背景','这是什么','使用','在线快速体验','单文件运行','其他方式','功能','开源协议','结语'];
    const MD=['# LuoguMarkdownEditor',''].concat(secs.flatMap((x,i)=>
      [(i>=3&&i<=5?'###':'##')+' '+x,''].concat(
        Array.from({length:12},(_,k)=>x+' 的第 '+(k+1)+' 段内容，用来撑高页面。')).concat([''])
    )).join('\n');
    const pg=await b.newPage({viewport:{width:1600,height:900}});
    await pg.goto(url,{waitUntil:'networkidle'});
    await pg.evaluate((v)=>{const ta=document.getElementById('editorTextarea');
      ta.value=v;ta.dispatchEvent(new Event('input',{bubbles:true}));
      LuoguEditor.render();LuoguEditor.setViewMode('preview');},MD);
    await pg.waitForTimeout(600);
    const h=await pg.evaluate(async()=>{let cap=null;const OB=window.Blob;
      window.Blob=class extends OB{constructor(a,o){super(a,o);
        if(o&&/html/.test(o.type||''))cap=a[0];}};
      window.showSaveFilePicker=undefined;HTMLAnchorElement.prototype.click=function(){};
      await LuoguEditor.exportStandaloneHTML();window.Blob=OB;return cap;});
    await pg.close();

    const v=await b.newPage({viewport:{width:1600,height:900}});
    const verr=[];v.on('pageerror',(e)=>verr.push(e.message));
    await v.setContent(h,{waitUntil:'networkidle'});
    await v.waitForTimeout(600);

    const items=await v.evaluate(()=>[...document.querySelectorAll('.toc-list a')]
      .map(a=>({t:a.textContent,cls:a.parentElement.className,href:a.getAttribute('href')})));
    ck(items.length===10,'目录列出全部标题',String(items.length));
    ck(items[0].t==='LuoguMarkdownEditor'&&items[0].cls==='toc-lv1','一级标题层级正确',
      JSON.stringify(items[0]));
    ck(items.some(x=>x.cls==='toc-lv3'),'三级标题有更深缩进层级',
      JSON.stringify(items.map(x=>x.cls)));
    ck(items.every(x=>x.href&&x.href.length>1),'每个条目都有锚点');
    ck(await v.evaluate(()=>[...document.querySelectorAll('.toc-list a')]
      .every(a=>document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1))))),
      '锚点都能定位到真实标题');

    // 滚动到某节，该节应被标记
    const jump=async(name)=>{const y=await v.evaluate((n)=>{
      const el=[...document.querySelectorAll('#articleBody h2,#articleBody h3')]
        .find(x=>x.textContent.trim()===n);
      return window.scrollY+el.getBoundingClientRect().top-60;},name);
      await v.evaluate((t)=>window.scrollTo({top:t,behavior:'instant'}),y);
      await v.waitForTimeout(320);
      return v.evaluate(()=>document.querySelector('.toc-list a.is-active')?.textContent);};
    ck(await jump('使用')==='使用','滚动时高亮当前章节');
    ck(await jump('功能')==='功能','滚动到后段仍准确高亮');

    // 点击目录跳转（含位于最后一屏、无法再滚动的章节）
    await v.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await v.waitForTimeout(300);
    await v.evaluate(()=>[...document.querySelectorAll('.toc-list a')]
      .find(a=>a.textContent==='开源协议').click());
    await v.waitForTimeout(900);
    ck(await v.evaluate(()=>document.querySelector('.toc-list a.is-active')?.textContent)==='开源协议',
      '点击最后一屏的章节也能正确标记',
      String(await v.evaluate(()=>document.querySelector('.toc-list a.is-active')?.textContent)));
    ck(await v.evaluate(()=>Math.round(window.scrollY))>0,'点击目录确实发生了跳转');

    // 明暗两色下当前项都要可辨认
    for(const th of ['light','dark']){
      await v.evaluate((t)=>document.documentElement.setAttribute('data-theme',t),th);
      await v.waitForTimeout(250);
      const cmp=await v.evaluate(()=>{
        const act=document.querySelector('.toc-list a.is-active');
        const oth=[...document.querySelectorAll('.toc-list a')]
          .find(a=>!a.classList.contains('is-active'));
        const g=(e)=>{const s=getComputedStyle(e);return s.color+'|'+s.backgroundColor;};
        return g(act)!==g(oth);});
      ck(cmp,`${th} 主题下当前项与其它项可区分`);
    }
    ck(verr.length===0,'目录脚本无报错',verr.join(';'));
    await v.close();

    // 标题少于两个时不显示目录
    const pg2=await b.newPage({viewport:{width:1600,height:800}});
    await pg2.goto(url,{waitUntil:'networkidle'});
    await pg2.evaluate(()=>{const ta=document.getElementById('editorTextarea');
      ta.value='# 只有一个标题\n\n正文。';ta.dispatchEvent(new Event('input',{bubbles:true}));
      LuoguEditor.render();LuoguEditor.setViewMode('preview');});
    await pg2.waitForTimeout(500);
    const h2=await pg2.evaluate(async()=>{let cap=null;const OB=window.Blob;
      window.Blob=class extends OB{constructor(a,o){super(a,o);
        if(o&&/html/.test(o.type||''))cap=a[0];}};
      window.showSaveFilePicker=undefined;HTMLAnchorElement.prototype.click=function(){};
      await LuoguEditor.exportStandaloneHTML();window.Blob=OB;return cap;});
    await pg2.close();
    const v2=await b.newPage({viewport:{width:1600,height:800}});
    await v2.setContent(h2,{waitUntil:'networkidle'});
    await v2.waitForTimeout(400);
    ck(await v2.evaluate(()=>{const t=document.getElementById('articleToc');
      return !!t.hidden||getComputedStyle(t).display==='none';}),'标题过少时不显示目录');
    await v2.close();
  }

  // ---- 要求 40: 大图不得溢出 -------------------------------------------------------
  {
    const pg=await b.newPage({viewport:{width:1200,height:800}});
    await pg.goto(url,{waitUntil:'networkidle'});
    // 2400x600 的 SVG 通过 blob: 提供，避免依赖磁盘文件
    await pg.evaluate(()=>{const ta=document.getElementById('editorTextarea');
      ta.value='# 图\n\n![大图](wide-test.png)\n\n## 第二节\n\n正文。';
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      LuoguEditor.render();LuoguEditor.setViewMode('preview');});
    await pg.waitForTimeout(500);
    const h=await pg.evaluate(async()=>{let cap=null;const OB=window.Blob;
      window.Blob=class extends OB{constructor(a,o){super(a,o);
        if(o&&/html/.test(o.type||''))cap=a[0];}};
      window.showSaveFilePicker=undefined;HTMLAnchorElement.prototype.click=function(){};
      await LuoguEditor.exportStandaloneHTML();window.Blob=OB;return cap;});
    await pg.close();
    ck(/\.article-content\s+img/.test(h)||/article-content img/.test(h),
      '导出模板包含图片约束规则');

    const v=await b.newPage({viewport:{width:1200,height:800}});
    // 把 <img> 换成一张真实的超宽图片再测实际布局
    await v.setContent(h.replace('src="wide-test.png"',
      'src="data:image/svg+xml;base64,'+Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="600">'
        +'<rect width="2400" height="600" fill="#39f"/></svg>').toString('base64')+'"'),
      {waitUntil:'networkidle'});
    await v.waitForTimeout(600);
    const m=await v.evaluate(()=>{const img=document.querySelector('.article-content img');
      const box=document.querySelector('.article-container');
      return {mw:getComputedStyle(img).maxWidth,
        imgW:Math.round(img.getBoundingClientRect().width),
        boxW:Math.round(box.getBoundingClientRect().width),
        docW:document.documentElement.scrollWidth,
        viewW:window.innerWidth};});
    ck(m.mw==='100%','导出件中图片 max-width 为 100%',JSON.stringify(m));
    ck(m.imgW<=m.boxW,'图片不超出文章容器',JSON.stringify(m));
    ck(m.docW<=m.viewW+1,'页面不出现横向溢出',JSON.stringify(m));
    await v.close();
  }



  console.log(`\n导出保真 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
