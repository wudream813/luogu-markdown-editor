/**
 * Typora mode: the preview pane doubles as the editor.
 *
 * Clicking a rendered block swaps it for a textarea holding that block's Markdown
 * source; blurring (or Escape / Ctrl+Enter) folds it back. The left source textarea
 * stays canonical, so these checks pin both halves: that the right source range is
 * extracted for every block type, and that committing writes back without drifting
 * the document's line count or breaking undo.
 */
const {chromium}=require('playwright');
const path=require('path');
(async()=>{

  // Resolve relative to this file, not a fixed path: CI checks the repo out under a
  // different root, where an absolute /home/user/... path does not exist.
  const url=process.argv[2]||'file://'+path.resolve(__dirname,'..','LuoguMarkdownEditor.html');
  const b=await chromium.launch();const p=await b.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto(url,{waitUntil:'networkidle'});

  const setSrc=(s)=>p.evaluate((v)=>{
    const ta=document.getElementById('editorTextarea');
    ta.value=v;ta.dispatchEvent(new Event('input',{bubbles:true}));
    LuoguEditor.render();
  },s);
  const src=()=>p.evaluate(()=>document.getElementById('editorTextarea').value);

  const DOC=['# 标题','','第一段文字。','','- 项目一','- 项目二','','> 引用内容','','| a | b |','|---|---|','| 1 | 2 |','','$$','x^2','$$','','最后一段。'].join('\n');
  await setSrc(DOC);
  await p.evaluate(()=>LuoguEditor.setViewMode('typora'));
  await p.waitForTimeout(200);

  let pass=0,fail=0;
  const ck=(c,n,x)=>{c?(pass++,console.log('  ✅',n)):(fail++,console.log('  ❌',n,x||''));};

  ck(await p.evaluate(()=>document.getElementById('mainWorkspace').classList.contains('mode-typora')),'切换到 typora 模式');
  ck(await p.evaluate(()=>getComputedStyle(document.querySelector('.editor-pane')).display==='none'),'左侧源码栏已隐藏');
  ck(await p.evaluate(()=>document.getElementById('previewContent').classList.contains('typora-mode')),'预览区带 typora-mode 类');

  // 点击段落 -> 出现 textarea 且内容正确
  await p.evaluate(()=>{
    const ps=[...document.querySelectorAll('#previewContent > p')];
    ps.find(e=>e.textContent.includes('第一段')).click();
  });
  await p.waitForTimeout(150);
  let v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v==='第一段文字。','点击段落展开源码',JSON.stringify(v));

  // 编辑并提交
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='改过的段落。';});
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(250);
  let s=await src();
  ck(s.includes('改过的段落。')&&!s.includes('第一段文字。'),'编辑写回源码',JSON.stringify(s.split('\n')[2]));
  ck(s.split('\n').length===DOC.split('\n').length,'行数未漂移',`${s.split('\n').length} vs ${DOC.split('\n').length}`);

  // 标题
  await p.evaluate(()=>document.querySelector('#previewContent h1').click());
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v==='# 标题','点击标题展开含 # 的源码',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(200);

  // 列表（多行块）
  await p.evaluate(()=>document.querySelector('#previewContent ul').click());
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v==='- 项目一\n- 项目二','列表整块展开',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(200);

  // 表格
  await p.evaluate(()=>{const t=document.querySelector('#previewContent table');(t.closest('[data-src-line]')||t).click();});
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v&&v.includes('| a | b |')&&v.includes('| 1 | 2 |'),'表格整块展开',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(200);

  // 块公式
  await p.evaluate(()=>{const m=document.querySelector('.luogu-math-display');(m.closest('[data-src-line]')||m).click();});
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v&&v.includes('$$')&&v.includes('x^2'),'块公式展开',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(200);

  // Escape 折叠
  await p.evaluate(()=>[...document.querySelectorAll('#previewContent > p')].pop().click());
  await p.waitForTimeout(150);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  ck(await p.evaluate(()=>!document.querySelector('.typora-block-input')),'Escape 折叠回渲染');

  // 切回 split 保持内容
  await p.evaluate(()=>LuoguEditor.setViewMode('split'));
  await p.waitForTimeout(200);
  ck(await p.evaluate(()=>getComputedStyle(document.querySelector('.editor-pane')).display!=='none'),'切回 split 恢复左栏');
  ck((await src()).includes('改过的段落。'),'切模式后内容保留');

  ck(errs.length===0,'无 JS 报错',errs.join(';'));

  // ---- 进阶：容器 / 代码块 / 交互元素 / 自动提交 / 撤销 ----
  const DOC2=[':::info[提示标题]','容器内容。',':::','','```cpp','int a = 1;','```','','- [ ] 任务一','- [x] 任务二','','普通段落。','','---','','结尾。'].join('\n');
  await setSrc(DOC2);
  await p.evaluate(()=>LuoguEditor.setViewMode('typora'));
  await p.waitForTimeout(250);

  // 容器 :::info 整块
  await p.evaluate(()=>{const d=document.querySelector('#previewContent details.luogu-callout');
    d.click();});
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v&&v.includes(':::info')&&v.includes('容器内容。')&&v.trim().endsWith(':::'),'容器整块展开',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(200);

  // 代码块
  await p.evaluate(()=>{const c=document.querySelector('#previewContent .luogu-code-block,#previewContent pre');
    (c.closest('[data-src-line]')||c).click();});
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v&&v.includes('```cpp')&&v.includes('int a = 1;'),'代码块整块展开',JSON.stringify(v));
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(200);

  // 任务列表复选框不应触发编辑
  const before=await src();
  await p.evaluate(()=>{const cb=document.querySelector('#previewContent input[type=checkbox]');if(cb)cb.click();});
  await p.waitForTimeout(250);
  ck(await p.evaluate(()=>!document.querySelector('.typora-block-input')),'点复选框不展开源码');
  const after=await src();
  ck(after!==before&&after.includes('- [x] 任务一'),'复选框仍能勾选',JSON.stringify(after.split('\n')[8]));

  // hr 不可编辑
  await p.evaluate(()=>{const h=document.querySelector('#previewContent hr');if(h)h.click();});
  await p.waitForTimeout(150);
  ck(await p.evaluate(()=>!document.querySelector('.typora-block-input')),'hr 不展开');

  // 连续点两个不同块：前一个应自动提交
  await p.evaluate(()=>[...document.querySelectorAll('#previewContent > p')].find(e=>e.textContent.includes('普通段落')).click());
  await p.waitForTimeout(150);
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='第一次改。';});
  await p.evaluate(()=>[...document.querySelectorAll('#previewContent > p')].find(e=>e.textContent.includes('结尾')).click());
  await p.waitForTimeout(300);
  const s2=await src();
  ck(s2.includes('第一次改。'),'点别处自动提交上一个块',JSON.stringify(s2));
  ck((await p.evaluate(()=>document.querySelectorAll('.typora-block-input').length))===1,'同时只有一个编辑框');

  // 多行输入：段落改成两行
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='结尾第一行\n\n结尾第二段';t.blur();});
  await p.waitForTimeout(300);
  const s3=await src();
  ck(s3.includes('结尾第一行')&&s3.includes('结尾第二段'),'块内可扩成多段',JSON.stringify(s3.slice(-40)));

  // 撤销仍可用
  await p.evaluate(()=>LuoguEditor.undo());
  await p.waitForTimeout(200);
  ck(!(await src()).includes('结尾第二段'),'撤销可回退 typora 编辑');

  ck(errs.length===0,'无 JS 报错',errs.join(';'));
  // ---- 空行/间隙起草新段落 ----
  // 1. 空文档：点正文区就能打字
  await setSrc('');
  await p.evaluate(()=>LuoguEditor.setViewMode('typora'));
  await p.waitForTimeout(200);
  await p.evaluate(()=>{const pc=document.getElementById('previewContent');
    const r=pc.getBoundingClientRect();
    pc.dispatchEvent(new MouseEvent('click',{bubbles:true,clientY:r.top+80,clientX:r.left+100}));});
  await p.waitForTimeout(150);
  ck(await p.evaluate(()=>!!document.querySelector('.typora-block-input')),'空文档点击可起草');
  await p.keyboard.type('全新的一段。');
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(250);
  ck((await src()).includes('全新的一段。'),'空文档写入成功',JSON.stringify(await src()));

  // 2. 两块之间的空隙插入
  await setSrc('第一段。\n\n第二段。');
  await p.waitForTimeout(200);
  const gapY=await p.evaluate(()=>{
    const ps=[...document.querySelectorAll('#previewContent > p')];
    const a=ps[0].getBoundingClientRect(),c=ps[1].getBoundingClientRect();
    return (a.bottom+c.top)/2;});
  await p.evaluate((cy)=>{const pc=document.getElementById('previewContent');
    pc.dispatchEvent(new MouseEvent('click',{bubbles:true,clientY:cy,clientX:pc.getBoundingClientRect().left+100}));},gapY);
  await p.waitForTimeout(150);
  ck(await p.evaluate(()=>!!document.querySelector('.typora-block-input')),'块间空隙可起草');
  await p.keyboard.type('插入的中间段。');
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(250);
  s=await src();
  const li=s.split('\n').filter(l=>l.trim());
  ck(li[1]==='插入的中间段。','插到两段之间且顺序正确',JSON.stringify(li));
  ck(/第一段。\n\n插入的中间段。\n\n第二段。/.test(s),'前后各有空行分隔',JSON.stringify(s));

  // 3. 末尾追加
  await p.evaluate(()=>{const pc=document.getElementById('previewContent');
    const r=pc.getBoundingClientRect();
    pc.dispatchEvent(new MouseEvent('click',{bubbles:true,clientY:r.bottom-40,clientX:r.left+100}));});
  await p.waitForTimeout(150);
  await p.keyboard.type('末尾追加段。');
  await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
  await p.waitForTimeout(250);
  s=await src();
  ck(s.trim().endsWith('末尾追加段。'),'末尾可追加',JSON.stringify(s.slice(-30)));

  // 4. 空内容不脏文档
  const before2=await src();
  await p.evaluate(()=>{const pc=document.getElementById('previewContent');
    const r=pc.getBoundingClientRect();
    pc.dispatchEvent(new MouseEvent('click',{bubbles:true,clientY:r.bottom-30,clientX:r.left+100}));});
  await p.waitForTimeout(150);
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(250);
  ck((await src())===before2,'空白起草放弃后文档不变');

  // 5. 起草多行 / Markdown 语法
  await p.evaluate(()=>{const pc=document.getElementById('previewContent');
    const r=pc.getBoundingClientRect();
    pc.dispatchEvent(new MouseEvent('click',{bubbles:true,clientY:r.bottom-30,clientX:r.left+100}));});
  await p.waitForTimeout(150);
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');
    t.value='## 新标题\n\n- 甲\n- 乙';t.blur();});
  await p.waitForTimeout(300);
  s=await src();
  ck(s.includes('## 新标题')&&s.includes('- 甲'),'可起草多行 Markdown');
  ck(await p.evaluate(()=>!!document.querySelector('#previewContent h2')),'新内容已渲染');

  // 6. 点已有块仍是编辑而非插入
  await p.evaluate(()=>[...document.querySelectorAll('#previewContent > p')].find(e=>e.textContent.includes('第一段')).click());
  await p.waitForTimeout(150);
  ck(await p.evaluate(()=>document.querySelector('.typora-block-input')?.value)==='第一段。','点已有块仍走编辑');
  await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
  await p.waitForTimeout(200);

  ck(errs.length===0,'无 JS 报错',errs.join(';'));
  console.log(`\nTypora ${pass+fail} 项，失败 ${fail}`);
  await b.close();process.exit(fail?1:0);
})();
