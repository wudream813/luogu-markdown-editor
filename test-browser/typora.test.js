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

  // 列表：要求 38 起，点某一条目只编辑该条目（点 <li> 命中最内层锚点）
  await p.evaluate(()=>document.querySelectorAll('#previewContent ul li')[1].click());
  await p.waitForTimeout(150);
  v=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(v==='- 项目二','点列表条目只展开该条目',JSON.stringify(v));
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
  // ---- 细粒度就地编辑（代码/表格/折叠框/bili）----
  let sf;
  const clickCell=(t)=>p.evaluate((x)=>{const c=[...document.querySelectorAll('td,th')].find(e=>e.textContent.trim()===x);if(c)c.click();},t);
  const box=()=>p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  const blur=async()=>{await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());await p.waitForTimeout(280);};
  // ===== 1. 代码块：只改代码，不碰围栏/语言 =====
  await setSrc('# T\n\n```cpp\nint main(){\n    return 0;\n}\n```\n\n后文。');
  await p.evaluate(()=>LuoguEditor.setViewMode('typora'));await p.waitForTimeout(300);
  await p.evaluate(()=>document.querySelector('pre[data-code-body]').click());
  await p.waitForTimeout(200);
  ck(box()!==undefined&&(await box())==='int main(){\n    return 0;\n}','代码块只展开代码体',JSON.stringify(await box()));

  // Tab 缩进
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.focus();t.selectionStart=t.selectionEnd=0;});
  await p.keyboard.press('Tab');await p.waitForTimeout(120);
  ck((await box()).startsWith('    int'),'Tab 可插入缩进',JSON.stringify((await box()).slice(0,12)));
  ck(await p.evaluate(()=>document.activeElement.classList.contains('typora-block-input')),'Tab 后焦点仍在框内');
  await p.keyboard.press('Shift+Tab');await p.waitForTimeout(120);
  ck((await box()).startsWith('int'),'Shift+Tab 可反缩进');
  await blur();
  sf=await src();
  ck(sf.includes('```cpp')&&sf.includes('int main(){'),'围栏与语言保留',JSON.stringify(s));

  // 改代码不影响语言
  await p.evaluate(()=>document.querySelector('pre[data-code-body]').click());await p.waitForTimeout(200);
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='puts("hi");';t.blur();});
  await p.waitForTimeout(300);
  sf=await src();
  ck(sf.includes('```cpp\nputs("hi");\n```'),'改代码体不动语言标记',JSON.stringify(s));

  // ===== 2. 表格：只改一个格子 =====
  await setSrc('| 甲 | 乙 |\n|:--:|:--:|\n| 1 | 2 |\n| 3 | 4 |');
  await p.waitForTimeout(300);
  await p.evaluate(()=>{const c=[...document.querySelectorAll('td[data-cell-col]')]
    .find(x=>x.textContent.trim()==='4');c.click();});
  await p.waitForTimeout(200);
  ck((await box()).trim()==='4','点单元格只展开该格',JSON.stringify(await box()));
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value=' 九 ';t.blur();});
  await p.waitForTimeout(300);
  sf=await src();
  ck(sf.includes('| 3 | 九 |'),'只改中该格',JSON.stringify(s));
  ck(sf.includes('| 甲 | 乙 |')&&sf.includes('|:--:|:--:|')&&sf.includes('| 1 | 2 |'),'其余行原样保留');
  // 表头
  await p.evaluate(()=>{const h=[...document.querySelectorAll('th[data-cell-col]')]
    .find(x=>x.textContent.trim()==='甲');h.click();});
  await p.waitForTimeout(200);
  ck((await box()).trim()==='甲','点表头只展开该表头格',JSON.stringify(await box()));
  await blur();

  // ===== 3. 折叠框 =====
  await setSrc(':::info[原标题]\n框内文字。\n:::');
  await p.waitForTimeout(300);
  // 标题
  await p.evaluate(()=>document.querySelector('.luogu-callout-title').click());
  await p.waitForTimeout(200);
  ck((await box())==='原标题','点标题只展开标题',JSON.stringify(await box()));
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='新标题';t.blur();});
  await p.waitForTimeout(300);
  sf=await src();
  ck(sf.includes(':::info[新标题]')&&sf.includes('框内文字。'),'只改标题不动其他',JSON.stringify(s));
  // 图标弹菜单选类别（v1.14.0 起由循环切换改为下拉菜单）
  await p.evaluate(()=>document.querySelector('.luogu-callout-icon').click());
  await p.waitForTimeout(250);
  await p.evaluate(()=>{const it=[...document.querySelectorAll('.typora-type-item')]
    .find(x=>x.textContent.includes('成功'));
    it.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));});
  await p.waitForTimeout(320);
  sf=await src();
  ck(sf.includes(':::success[新标题]'),'菜单选“成功”切换类别',JSON.stringify(sf));
  // 内部文字
  await p.evaluate(()=>{const c=document.querySelector('.luogu-callout-content p');c.click();});
  await p.waitForTimeout(200);
  ck((await box())==='框内文字。','点内部文字只展开该段',JSON.stringify(await box()));
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');t.value='改后的内文。';t.blur();});
  await p.waitForTimeout(300);
  sf=await src();
  ck(sf.includes(':::success[新标题]')&&sf.includes('改后的内文。')&&sf.trim().endsWith(':::'),'改内文不破坏折叠框',JSON.stringify(sf));

  // ===== bilibili =====
  await p.evaluate(()=>{const ta=document.getElementById('editorTextarea');
    ta.value='![演示](bilibili:BV1GJ411x7h7)';ta.dispatchEvent(new Event('input',{bubbles:true}));
    LuoguEditor.render();LuoguEditor.setViewMode('typora');});
  await p.waitForTimeout(400);
  ck(await p.evaluate(()=>!!document.querySelector('.luogu-bilibili-container')),'bili 已渲染');
  // 点卡片头部（非播放按钮）
  await p.evaluate(()=>{const h=document.querySelector('.luogu-bilibili-header')
    ||document.querySelector('.luogu-bilibili-container');h.click();});
  await p.waitForTimeout(250);
  const vb=await p.evaluate(()=>document.querySelector('.typora-block-input')?.value);
  ck(vb&&vb.includes('bilibili:BV1GJ411x7h7'),'点 bili 卡片可编辑 BV 号',JSON.stringify(vb));
  await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');
    t.value='![新标题](bilibili:BV1xx411c7XD)';t.blur();});
  await p.waitForTimeout(350);
  const sBili=await p.evaluate(()=>document.getElementById('editorTextarea').value);
  ck(sBili.includes('BV1xx411c7XD')&&sBili.includes('新标题'),'改 BV 号与标题生效',JSON.stringify(s));
  // 播放按钮仍可用（不被劫持成编辑）
  await p.evaluate(()=>{const ta=document.getElementById('editorTextarea');
    ta.value='![演示](bilibili:BV1GJ411x7h7)';ta.dispatchEvent(new Event('input',{bubbles:true}));LuoguEditor.render();});
  await p.waitForTimeout(300);
  await p.evaluate(()=>document.querySelector('.luogu-bilibili-facade')?.click());
  await p.waitForTimeout(400);
  ck(await p.evaluate(()=>!!document.querySelector('.luogu-bilibili-container iframe')),'播放按钮仍能加载视频');
  ck(await p.evaluate(()=>!document.querySelector('.typora-block-input')),'播放按钮不触发编辑');

  // ---- 要求 32: 折叠框类别下拉菜单 -------------------------------------------
  {
    await setSrc(':::info[标题]\n内容。\n:::');await p.waitForTimeout(320);
    await p.evaluate(() => document.querySelector('.luogu-callout-icon').click());
    await p.waitForTimeout(200);
    ck(await p.evaluate(() => !!document.querySelector('.typora-type-menu')), '点图标弹出类别菜单');
    ck(await p.evaluate(() => document.querySelectorAll('.typora-type-item').length) === 4, '菜单四个类别');
    ck(await p.evaluate(() => !!document.querySelector('.typora-type-item.is-current')), '标出当前类别');
    await p.evaluate(() => {
      const w = [...document.querySelectorAll('.typora-type-item')].find((x) => x.textContent.includes('警告'));
      w.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await p.waitForTimeout(300);
    ck((await src()).includes(':::warning[标题]'), '选警告写回源码');
    ck(await p.evaluate(() => !document.querySelector('.typora-type-menu')), '选完菜单关闭');
    await p.evaluate(() => document.querySelector('.luogu-callout-icon').click());
    await p.waitForTimeout(180);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(180);
    ck(await p.evaluate(() => !document.querySelector('.typora-type-menu')), 'Esc 关闭菜单');
  }

  // ---- 要求 32: 合并单元格按原始标记编辑 ---------------------------------------
  {
    const TBL = '| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await setSrc(TBL);await p.waitForTimeout(320);
    await clickCell('A');await p.waitForTimeout(240);
    const mv = await box();
    ck(!!mv && mv.includes('<') && mv.includes('^'), '合并格编辑框显示 < 与 ^ 原始标记');
    ck(!!mv && mv.split('\n').length === 2, '合并格按 rowspan 展开两行');
    await p.evaluate(() => document.querySelector('.typora-block-input').blur());
    await p.waitForTimeout(280);
    ck((await src()) === TBL, '合并格原样提交不改文档');

    await clickCell('A');await p.waitForTimeout(240);
    await p.evaluate(() => {
      const t = document.querySelector('.typora-block-input');
      t.value = ' A | < \n B | C ';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.blur();
    });
    await p.waitForTimeout(320);
    const ms = await src();
    ck(ms.includes('| B | C | 2 |'), '解除合并写回正确');
    ck(ms.includes('| A | < | 1 |'), '相邻行未受影响');
    ck(ms.split('\n').length === 4, '合并格编辑不增删表行');

    await setSrc(TBL);await p.waitForTimeout(320);
    await clickCell('1');await p.waitForTimeout(240);
    ck((await box()).trim() === '1', '普通格仍只编辑自身');
  }

  // ---- 要求 34: 合并格 hover 临时解除合并 ---------------------------------------
  {
    const TBL='| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await setSrc(TBL);await p.waitForTimeout(320);
    const shape=()=>p.evaluate(()=>[...document.querySelectorAll('#previewContent table tr')]
      .map(r=>[...r.children].map(c=>c.textContent.trim()+(c.getAttribute('rowspan')||'')+(c.getAttribute('colspan')||''))));
    const before=await shape();
    ck(JSON.stringify(before[1])==='["A22","1"]','初始 A 为 2x2 合并格',JSON.stringify(before[1]));
    const cb=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')].find(x=>x.textContent.trim()==='A');
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(cb.x,cb.y);await p.waitForTimeout(300);
    const during=await shape();
    ck(JSON.stringify(during[1])==='["A","<","1"]','hover 时第一行解除为 A < 1',JSON.stringify(during[1]));
    ck(JSON.stringify(during[2])==='["^","^","2"]','hover 时第二行解除为 ^ ^ 2',JSON.stringify(during[2]));
    ck(await p.evaluate(()=>document.querySelectorAll('.typora-unmerged-cell').length)===3,'新增 3 个临时格');
    await p.mouse.move(5,420);await p.waitForTimeout(300);
    ck(JSON.stringify(await shape())===JSON.stringify(before),'移开后完全还原');
    ck((await src())===TBL,'hover 不改动源码');
  }

  // ---- 要求 34: 合并 span 计数（回归）------------------------------------------
  {
    await setSrc('| 甲 | 乙 | 丙 |\n|:-:|:-:|:-:|\n| A | < | 1 |\n| ^ | ^ | 2 |');
    await p.waitForTimeout(300);
    const sp=await p.evaluate(()=>{const t=document.querySelector('#previewContent td');
      return t.getAttribute('rowspan')+'x'+t.getAttribute('colspan');});
    ck(sp==='2x2','两行两列合并应为 rowspan=2（曾错算为 3）',sp);
    await setSrc('| 甲 |\n|:-:|\n| A |\n| ^ |\n| ^ |');
    await p.waitForTimeout(300);
    ck(await p.evaluate(()=>document.querySelector('#previewContent td').getAttribute('rowspan'))==='3',
      '三行纵向合并 rowspan=3');
  }

  // ---- 要求 33: cute-table 样式 ------------------------------------------------
  {
    const tblSrc='\n\n| 甲 | 乙 |\n|:--:|:--:|\n| 1 | 2 |';
    await setSrc('::cute-table{three}'+tblSrc);await p.waitForTimeout(320);
    const three=await p.evaluate(()=>{const t=document.querySelector('#previewContent table');
      if(!t)return null;const th=t.querySelector('th'),td=t.querySelector('td');
      return {cls:t.className,thTop:getComputedStyle(th).borderTopWidth,
        thBottom:getComputedStyle(th).borderBottomWidth,tdLeft:getComputedStyle(td).borderLeftWidth};});
    ck(three&&/luogu-three-table/.test(three.cls),'{three} 使用三线表类',JSON.stringify(three&&three.cls));
    ck(three&&three.tdLeft==='0px','三线表无竖线',JSON.stringify(three&&three.tdLeft));
    ck(three&&parseFloat(three.thTop)>=2,'三线表顶线加粗',JSON.stringify(three&&three.thTop));

    await setSrc('::cute-table{tuack=2}'+tblSrc);await p.waitForTimeout(320);
    const tk=await p.evaluate(()=>{const t=document.querySelector('#previewContent table');
      const td=t&&t.querySelector('tbody td:nth-child(2)');
      return {cls:t?t.className:null,attr:t?t.getAttribute('data-tuack-col'):null,
        bl:td?getComputedStyle(td).borderLeftWidth:null};});
    ck(tk&&/luogu-tuack-table/.test(tk.cls),'{tuack=N} 使用 tuack 类');
    ck(tk&&tk.attr==='2','{tuack=N} 记录分栏列号',JSON.stringify(tk&&tk.attr));
    ck(tk&&parseFloat(tk.bl)>=2,'{tuack=N} 该列竖线加粗',JSON.stringify(tk&&tk.bl));
  }

  // ---- 要求 35: 点击临时解除的格子只编辑该格 -----------------------------------
  {
    const TBL='| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await setSrc(TBL);await p.waitForTimeout(320);
    const cb=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')].find(x=>x.textContent.trim()==='A');
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(cb.x,cb.y);await p.waitForTimeout(280);
    const mk=await p.evaluate(()=>{const t=[...document.querySelectorAll('.typora-unmerged-cell')]
      .find(x=>x.textContent.trim()==='<');if(!t)return null;
      const r=t.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    ck(!!mk,'临时格中存在 < 标记');
    if(mk){
      await p.mouse.click(mk.x,mk.y);await p.waitForTimeout(300);
      const v=await box();
      ck(!!v&&v.trim()==='<','点 < 只编辑该格',JSON.stringify(v));
      ck(!!v&&!v.includes('\n'),'不是整块表格');
      await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');
        t.value=' X ';t.dispatchEvent(new Event('input',{bubbles:true}));t.blur();});
      await p.waitForTimeout(320);
      const s2=await src();
      ck(s2.includes('| A | X | 1 |'),'写回仅改该格',JSON.stringify(s2));
      ck(s2.split('\n').length===4,'未增删表行');
    }
  }

  // ---- 要求 35: :::align / :::epigraph 内文可单独编辑 ---------------------------
  {
    await setSrc(':::align{center}\n居中的文字。\n:::');await p.waitForTimeout(320);
    await p.evaluate(()=>document.querySelector('#previewContent [class*="luogu-align-"] p').click());
    await p.waitForTimeout(280);
    ck((await box())==='居中的文字。','点 align 内文字只编辑该段',JSON.stringify(await box()));
    await p.evaluate(()=>{const t=document.querySelector('.typora-block-input');
      t.value='改后文字。';t.dispatchEvent(new Event('input',{bubbles:true}));t.blur();});
    await p.waitForTimeout(320);
    const as=await src();
    ck(as.includes(':::align{center}')&&as.includes('改后文字。')&&as.trim().endsWith(':::'),
      'align 容器结构保持完整',JSON.stringify(as));

    await setSrc(':::epigraph[——otto]\n名言内容。\n:::');await p.waitForTimeout(320);
    await p.evaluate(()=>document.querySelector('#previewContent .luogu-epigraph-body p').click());
    await p.waitForTimeout(280);
    ck((await box())==='名言内容。','点 epigraph 内文字只编辑该段',JSON.stringify(await box()));
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(250);
  }

  // ---- 要求 35: 点折叠框图标不改变开合状态 --------------------------------------
  {
    await setSrc(':::info[标题]\n内容。\n:::');await p.waitForTimeout(320);
    const o0=await p.evaluate(()=>document.querySelector('details.luogu-callout').open);
    await p.evaluate(()=>document.querySelector('.luogu-callout-icon').click());
    await p.waitForTimeout(260);
    const st=await p.evaluate(()=>({open:document.querySelector('details.luogu-callout').open,
      menu:!!document.querySelector('.typora-type-menu')}));
    ck(st.open===o0,'点图标不切换折叠状态',`${o0} -> ${st.open}`);
    ck(st.menu,'仍然弹出类别菜单');
    await p.keyboard.press('Escape');await p.waitForTimeout(200);

    await setSrc(':::info[标题]{open}\n内容。\n:::');await p.waitForTimeout(320);
    const p0=await p.evaluate(()=>document.querySelector('details.luogu-callout').open);
    await p.evaluate(()=>document.querySelector('.luogu-callout-icon').click());
    await p.waitForTimeout(260);
    ck(await p.evaluate(()=>document.querySelector('details.luogu-callout').open)===p0,
      '展开态点图标也不收起');
    await p.keyboard.press('Escape');await p.waitForTimeout(200);
  }

  // ---- 要求 36: align / epigraph 容器可视标识 ----------------------------------
  {
    await setSrc(':::align{center}\n居中文字。\n:::\n\n:::align{right}\n居右文字。\n:::\n\n:::epigraph[——otto]\n名言。\n:::');
    await p.waitForTimeout(340);
    const marks=await p.evaluate(()=>[...document.querySelectorAll('#previewContent [class*="luogu-align-"], #previewContent .luogu-epigraph')]
      .map(e=>({cls:e.className,
        label:getComputedStyle(e,e.classList.contains('luogu-epigraph')?'::after':'::before').content,
        border:getComputedStyle(e).borderTopStyle})));
    ck(marks.length===3,'三个容器都渲染');
    ck(marks[0].label.includes('居中'),'居中容器有标签',JSON.stringify(marks[0].label));
    ck(marks[1].label.includes('居右'),'居右容器有标签',JSON.stringify(marks[1].label));
    ck(marks[2].label.includes('引言'),'引言容器有标签',JSON.stringify(marks[2].label));
    ck(marks.every(m=>m.border==='dashed'),'容器有虚线边界');
    // 退出 Typora 模式后不应残留标识
    await p.evaluate(()=>LuoguEditor.setViewMode('preview'));
    await p.waitForTimeout(300);
    ck(await p.evaluate(()=>{const e=document.querySelector('#previewContent [class*="luogu-align-"]');
      return getComputedStyle(e,'::before').content;})==='none','非 Typora 模式无标识');
    await p.evaluate(()=>LuoguEditor.setViewMode('typora'));
    await p.waitForTimeout(300);
  }

  // ---- 要求 36: 折叠框标题只在文字上编辑 ----------------------------------------
  {
    await setSrc(':::info[短标题]\n内容。\n:::');await p.waitForTimeout(340);
    const g=await p.evaluate(()=>{const t=document.querySelector('.luogu-callout-title');
      const smy=document.querySelector('summary');
      const rng=document.createRange();rng.selectNodeContents(t);
      const tr=rng.getClientRects()[0];const sr=smy.getBoundingClientRect();
      return {tx:tr.x+tr.width/2,ty:tr.y+tr.height/2,titleW:t.getBoundingClientRect().width,
        sumW:sr.width,blankX:sr.right-80,blankY:sr.y+sr.height/2};});
    ck(g.titleW<g.sumW-40,'标题 span 不撑满整行',`${Math.round(g.titleW)}/${Math.round(g.sumW)}`);
    const o0=await p.evaluate(()=>document.querySelector('details.luogu-callout').open);
    await p.mouse.click(g.tx,g.ty);await p.waitForTimeout(300);
    ck((await box())==='短标题','点标题文字打开重命名',JSON.stringify(await box()));
    ck(await p.evaluate(()=>document.querySelector('details.luogu-callout').open)===o0,
      '点标题文字不改变开合');
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);
    await setSrc(':::info[短标题]\n内容。\n:::');await p.waitForTimeout(320);
    const o1=await p.evaluate(()=>document.querySelector('details.luogu-callout').open);
    await p.mouse.click(g.blankX,g.blankY);await p.waitForTimeout(300);
    ck((await box())===undefined,'点标题栏空白不进入编辑');
    ck(await p.evaluate(()=>document.querySelector('details.luogu-callout').open)!==o1,
      '点标题栏空白切换开合');
    await setSrc(':::info[短标题]\n内容。\n:::');await p.waitForTimeout(320);
    await p.mouse.move(g.tx,g.ty);await p.waitForTimeout(240);
    const hv=await p.evaluate(()=>{const cs=getComputedStyle(document.querySelector('.luogu-callout-title'));
      return {cursor:cs.cursor,deco:cs.textDecorationLine,bg:cs.backgroundColor};});
    ck(hv.cursor==='text','hover 标题为文本光标',JSON.stringify(hv));
    ck(hv.deco.includes('underline')||hv.bg!=='rgba(0, 0, 0, 0)','hover 标题有视觉提示',JSON.stringify(hv));
  }

  // ---- 要求 36: 编辑合并格标记时表格保持正常渲染 --------------------------------
  {
    const TBL='| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await setSrc(TBL);await p.waitForTimeout(340);
    const cb=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')].find(x=>x.textContent.trim()==='A');
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(cb.x,cb.y);await p.waitForTimeout(280);
    const mk=await p.evaluate(()=>{const t=[...document.querySelectorAll('.typora-unmerged-cell')]
      .find(x=>x.textContent.trim()==='^');if(!t)return null;
      const r=t.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    ck(!!mk,'找到 ^ 临时格');
    if(mk){
      await p.mouse.click(mk.x,mk.y);await p.waitForTimeout(320);
      ck((await box()).trim()==='^','只编辑该标记格',JSON.stringify(await box()));
      const shp=await p.evaluate(()=>[...document.querySelectorAll('#previewContent table tr')]
        .map(r=>[...r.children].map(c=>c.textContent.trim()+(c.getAttribute('rowspan')||'')+(c.getAttribute('colspan')||''))));
      // 要求 37 起改为：保持 hover 拆开的骨架，只有被点的那一格变成输入框，
      // 其余临时格继续显示自己的 < / ^ 标记。
      ck(JSON.stringify(shp[1])==='["A","<","1"]','其余临时格保持骨架渲染',JSON.stringify(shp));
      ck(await p.evaluate(()=>document.querySelectorAll('.typora-unmerged-cell').length===3),
        '临时格仍在（共 3 个）',
        String(await p.evaluate(()=>document.querySelectorAll('.typora-unmerged-cell').length)));
      ck(await p.evaluate(()=>{const h=document.querySelector('.typora-host-editing');
        return !!h && h.tagName==='TD' && h.contains(document.querySelector('.typora-block-input'));}),
        '编辑框就地嵌在该单元格内');
      await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
      await p.waitForTimeout(320);
      ck((await src())===TBL,'原样提交不改文档');
    }
  }

  // ---- 要求 37: 编辑合并标记时其余格照常渲染 -------------------------------------
  {
    const TBL='| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await setSrc(TBL);await p.waitForTimeout(360);
    const a=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')].find(x=>x.textContent.trim()==='A');
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(a.x,a.y);await p.waitForTimeout(300);
    const hoverN=await p.evaluate(()=>document.querySelectorAll('#previewContent td').length);
    const g=await p.evaluate(()=>{const t=[...document.querySelectorAll('.typora-unmerged-cell')]
      .find(x=>x.textContent.trim()==='^');const r=t.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(g.x,g.y);await p.waitForTimeout(400);
    const cells=await p.evaluate(()=>[...document.querySelectorAll('#previewContent td')]
      .map(c=>c.querySelector('textarea')?'[EDIT]':c.textContent.trim()));
    ck((await box()).trim()==='^','只编辑被点的 ^ 格',JSON.stringify(await box()));
    ck(cells.length===hoverN,'骨架格数与 hover 时一致',`${hoverN} vs ${cells.length}`);
    ck(cells.filter(x=>x==='<').length===1,'其余 < 标记照常渲染',JSON.stringify(cells));
    ck(cells.filter(x=>x==='^').length===1,'另一个 ^ 标记照常渲染',JSON.stringify(cells));
    ck(cells.filter(x=>x==='[EDIT]').length===1,'只有一个编辑框',JSON.stringify(cells));
    ck(await p.evaluate(()=>{const h=document.querySelector('.typora-host-editing');
      return !!h && h.tagName==='TD' && h.contains(document.querySelector('.typora-block-input'));}),
      '编辑框位于该单元格内');
    await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
    await p.waitForTimeout(400);
    ck((await src())===TBL,'原样提交不改文档');
    await p.mouse.move(5,5);await p.waitForTimeout(350);
    ck(await p.evaluate(()=>!document.querySelector('.typora-unmerged-cell')),'鼠标移开后骨架收起');
  }

  // ---- 要求 37: 改标题/类型不重置开合状态 ---------------------------------------
  {
    for (const [name,doc,expect] of [
      ['手动展开(无 open)',':::info[我的标题]\n框内文字。\n:::',true],
      ['手动收起(带 open)',':::info[我的标题]{open}\n框内文字。\n:::',false]]) {
      await setSrc(doc);await p.waitForTimeout(360);
      const arrow=await p.evaluate(()=>{const s=document.querySelector('summary');
        const r=s.getBoundingClientRect();return {x:r.right-24,y:r.y+r.height/2};});
      await p.mouse.click(arrow.x,arrow.y);await p.waitForTimeout(350);
      ck(await p.evaluate(()=>document.querySelector('details.luogu-callout').open)===expect,
        `${name}: 手动切换生效`);
      const tg=await p.evaluate(()=>{const t=document.querySelector('.luogu-callout-title');
        const rng=document.createRange();rng.selectNodeContents(t);const r=rng.getClientRects()[0];
        return {x:r.x+r.width/2,y:r.y+r.height/2};});
      await p.mouse.click(tg.x,tg.y);await p.waitForTimeout(350);
      ck(await p.evaluate(()=>document.querySelector('details.luogu-callout').open)===expect,
        `${name}: 点标题时开合不变`);
      await p.evaluate(()=>{const i=document.querySelector('.typora-block-input');
        i.value='新标题';i.dispatchEvent(new Event('input',{bubbles:true}));i.blur();});
      await p.waitForTimeout(550);
      ck(await p.evaluate(()=>document.querySelector('details.luogu-callout')?.open)===expect,
        `${name}: 改标题后开合不变`,
        `期望 ${expect} 实得 ${await p.evaluate(()=>document.querySelector('details.luogu-callout')?.open)}`);
      ck((await src()).includes('新标题'),`${name}: 标题已写回`);
    }
    // 改类型同样保持
    await setSrc(':::info[标题A]\n内容。\n:::');await p.waitForTimeout(360);
    const arrow2=await p.evaluate(()=>{const s=document.querySelector('summary');
      const r=s.getBoundingClientRect();return {x:r.right-24,y:r.y+r.height/2};});
    await p.mouse.click(arrow2.x,arrow2.y);await p.waitForTimeout(350);
    const ic=await p.evaluate(()=>{const i=document.querySelector('.luogu-callout-icon');
      const r=i.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(ic.x,ic.y);await p.waitForTimeout(400);
    const pick=await p.evaluate(()=>{const it=[...document.querySelectorAll('.typora-type-item')]
      .find(x=>/成功/.test(x.textContent));const r=it.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(pick.x,pick.y);await p.waitForTimeout(550);
    ck(await p.evaluate(()=>document.querySelector('details.luogu-callout')?.open)===true,
      '改类型后仍保持展开');
    ck((await src()).startsWith(':::success'),'类型已写回');
  }

  // ---- 要求 37: align 角标菜单切换左/中/右 --------------------------------------
  {
    await setSrc(':::align{center}\n居中文字。\n:::');await p.waitForTimeout(360);
    const badge=await p.evaluate(()=>{const e=document.querySelector('[class*="luogu-align-"]');
      const r=e.getBoundingClientRect();return {x:r.x+20,y:r.y+2};});
    await p.mouse.click(badge.x,badge.y);await p.waitForTimeout(400);
    const items=await p.evaluate(()=>[...document.querySelectorAll('.typora-type-item')]
      .map(x=>x.textContent.trim()));
    ck(items.join(',')==='居左,居中,居右','角标弹出左/中/右菜单',JSON.stringify(items));
    ck(await p.evaluate(()=>!document.querySelector('.typora-block-input')),'点角标不进入源码编辑');
    const right=await p.evaluate(()=>{const it=[...document.querySelectorAll('.typora-type-item')]
      .find(x=>/居右/.test(x.textContent));const r=it.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(right.x,right.y);await p.waitForTimeout(550);
    ck((await src()).includes(':::align{right}'),'切换为居右',(await src()).split('\n')[0]);
    ck(await p.evaluate(()=>!!document.querySelector('.luogu-align-right')),'渲染为居右');
    // 容器内文字仍可单独编辑
    const inner=await p.evaluate(()=>{const el=[...document.querySelectorAll('#previewContent [class*="luogu-align-"] p')]
      .find(x=>x.textContent.trim()==='居中文字。');if(!el)return null;
      const rng=document.createRange();rng.selectNodeContents(el);const r=rng.getClientRects()[0];
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    ck(!!inner,'找到容器内段落');
    if(inner){await p.mouse.click(inner.x,inner.y);await p.waitForTimeout(400);
      ck((await box())==='居中文字。','点容器内文字仍编辑该段',JSON.stringify(await box()));}
  }

  // ---- 要求 37: 嵌套引用分层编辑 -------------------------------------------------
  {
    const Q='> 外层引用。\n>\n> > 内层引用。\n> >\n> > 更深内容。';
    await setSrc(Q);await p.waitForTimeout(360);
    const hit=async(sel,txt)=>{const gg=await p.evaluate(([s,t])=>{
      const el=[...document.querySelectorAll(s)].find(x=>x.textContent.trim()===t);
      if(!el)return null;const rng=document.createRange();rng.selectNodeContents(el);
      const r=rng.getClientRects()[0];return {x:r.x+r.width/2,y:r.y+r.height/2};},[sel,txt]);
      if(!gg)return false;await p.mouse.click(gg.x,gg.y);await p.waitForTimeout(400);return true;};
    ck(await p.evaluate(()=>{const q=document.querySelector('#previewContent blockquote blockquote');
      return !!q && q.hasAttribute('data-src-line') && q.hasAttribute('data-src-end-line');}),
      '内层引用带 data-src-line/end-line');
    ck(await hit('#previewContent blockquote blockquote p','内层引用。'),'找到内层段落');
    ck((await box()).includes('内层引用')&&!(await box()).includes('外层引用'),
      '点内层只编辑内层',JSON.stringify(await box()));
    await p.evaluate(()=>{const i=document.querySelector('.typora-block-input');
      i.value='> > 内层改了。\n> >';i.dispatchEvent(new Event('input',{bubbles:true}));i.blur();});
    await p.waitForTimeout(550);
    const after=await src();
    ck(after.includes('内层改了'),'内层修改已写回');
    ck(after.includes('外层引用。')&&after.includes('更深内容。'),'其余层未被破坏',JSON.stringify(after));
    await setSrc(Q);await p.waitForTimeout(360);
    ck(await hit('#previewContent > blockquote > p','外层引用。'),'找到外层段落');
    ck((await box()).includes('外层引用')&&!(await box()).includes('内层'),
      '点外层只编辑外层段',JSON.stringify(await box()));
  }

  // ---- 要求 38: 列表条目可单独编辑 ---------------------------------------------
  {
    const L='- 第一项\n- 第二项\n- 第三项';
    // 上一段用例可能还开着编辑框，先收掉再换文档
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);
    await p.mouse.move(5,5);
    await setSrc(L);await p.waitForTimeout(400);
    const lis=await p.evaluate(()=>[...document.querySelectorAll('#previewContent li')]
      .map(l=>({line:l.getAttribute('data-src-line'),end:l.getAttribute('data-src-end-line')})));
    ck(lis.every(l=>l.line!==null&&l.end!==null),'每个 li 都带源码行号',JSON.stringify(lis));
    // 命中条目自身的文字节点：<li> 的 textContent 含嵌套子项，不能整体比较
    const hit=async(sel,txt)=>{const g=await p.evaluate(([s2,t])=>{
      for(const el of document.querySelectorAll(s2)){
        for(const n of el.childNodes){
          if(n.nodeType!==3||n.data.trim()!==t)continue;
          const rng=document.createRange();rng.selectNodeContents(n);
          const r=rng.getClientRects()[0];
          if(r)return {x:r.x+r.width/2,y:r.y+r.height/2};
        }
        if(el.textContent.trim()===t){
          const rng=document.createRange();rng.selectNodeContents(el);
          const r=rng.getClientRects()[0]||el.getBoundingClientRect();
          return {x:r.x+r.width/2,y:r.y+r.height/2};
        }
      }
      return null;},[sel,txt]);
      if(!g)return false;await p.mouse.click(g.x,g.y);await p.waitForTimeout(400);return true;};
    ck(await hit('#previewContent li','第二项'),'找到第二项');
    ck((await box())==='- 第二项','点条目只编辑该条目',JSON.stringify(await box()));
    await p.evaluate(()=>{const i=document.querySelector('.typora-block-input');
      i.value='- 第二项改了';i.dispatchEvent(new Event('input',{bubbles:true}));i.blur();});
    await p.waitForTimeout(550);
    ck((await src())==='- 第一项\n- 第二项改了\n- 第三项','只改写该行',JSON.stringify(await src()));
    await setSrc('1. 甲\n2. 乙\n   - 子项\n3. 丙');await p.waitForTimeout(360);
    ck(await hit('#previewContent li li','子项'),'找到嵌套子项');
    ck((await box()).trim()==='- 子项','嵌套条目单独编辑',JSON.stringify(await box()));
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(320);
    await setSrc('- [ ] 待办A\n- [x] 待办B');await p.waitForTimeout(360);
    ck(await hit('#previewContent .luogu-task-text','待办A'),'找到任务项');
    ck((await box())==='- [ ] 待办A','任务项单独编辑',JSON.stringify(await box()));
  }

  // ---- 要求 38: 编辑合并格原始格不破坏邻格 --------------------------------------
  {
    const TBL='| 甲 | 乙 | 丙 |\n|:--:|:--:|:--:|\n| A | < | 1 |\n| ^ | ^ | 2 |';
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);
    await p.mouse.move(5,5);
    await setSrc(TBL);await p.waitForTimeout(400);
    const a0=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')]
      .find(x=>x.textContent.trim()==='A');const r=c.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(a0.x,a0.y);await p.waitForTimeout(320);
    const wBefore=await p.evaluate(()=>[...document.querySelectorAll('#previewContent td')]
      .map(c=>Math.round(c.getBoundingClientRect().width)));
    const a1=await p.evaluate(()=>{const c=[...document.querySelectorAll('td')]
      .find(x=>x.textContent.trim()==='A');const r=c.getBoundingClientRect();
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(a1.x,a1.y);await p.waitForTimeout(430);
    const cells=await p.evaluate(()=>[...document.querySelectorAll('#previewContent td')]
      .map(c=>({t:c.querySelector('textarea')?'[EDIT]':c.textContent.trim(),
        w:Math.round(c.getBoundingClientRect().width)})));
    ck((await box()).trim()==='A','编辑的是 A 格',JSON.stringify(await box()));
    ck(cells.some(c=>c.t==='<'),'右侧 < 未消失',JSON.stringify(cells.map(c=>c.t)));
    ck(cells.every(c=>c.w>0),'没有单元格塌陷为 0 宽',JSON.stringify(cells));
    ck(Math.max(...cells.map(c=>c.w))<Math.max(...wBefore)*2.5,'列宽未被编辑框撑爆',
      `${JSON.stringify(wBefore)} -> ${JSON.stringify(cells.map(c=>c.w))}`);
    await p.evaluate(()=>document.querySelector('.typora-block-input').blur());
    await p.waitForTimeout(430);
    ck((await src())===TBL,'原样提交不改文档');
  }

  // ---- 要求 38: align 角标菜单紧贴角标 ------------------------------------------
  {
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);
    await p.mouse.move(5,5);
    await setSrc('\n\n\n:::align{center}\n居中文字。\n:::\n');await p.waitForTimeout(400);
    const geo=await p.evaluate(()=>{const e=document.querySelector('[class*="luogu-align-"]');
      const r=e.getBoundingClientRect();const cs=getComputedStyle(e,'::before');
      return {left:r.left,top:r.top,bottom:r.bottom,bh:parseFloat(cs.height)||0};});
    await p.mouse.click(geo.left+20,geo.top+2);await p.waitForTimeout(400);
    const m=await p.evaluate(()=>{const el=document.querySelector('.typora-type-menu');
      if(!el)return null;const r=el.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom};});
    ck(!!m,'角标菜单已弹出');
    ck(m&&Math.abs(m.left-geo.left)<12,'菜单左缘对齐角标',
      `${m&&Math.round(m.left)} vs ${Math.round(geo.left)}`);
    ck(m&&m.top<geo.top+geo.bh+20,'菜单紧贴角标下方而非容器底部',
      `菜单 top=${m&&Math.round(m.top)} 角标 top=${Math.round(geo.top)} 容器 bottom=${Math.round(geo.bottom)}`);
    ck(m&&m.top>=0&&m.left>=0,'菜单未跑出视口',JSON.stringify(m));
    await p.evaluate(()=>document.body.click());await p.waitForTimeout(250);
  }

  // ---- 要求 39: 列表 hover 只高亮当前条目 ---------------------------------------
  {
    const TRANSPARENT='rgba(0, 0, 0, 0)';
    // 上一段用例可能还开着类型/对齐菜单，它是 position:fixed 覆盖层，会挡住 hover
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);await p.mouse.move(5,5);
    await setSrc('- 第一项\n- 第二项\n- 第三项');await p.waitForTimeout(400);
    const li2=await p.evaluate(()=>{const l=[...document.querySelectorAll('#previewContent li')][1];
      const r=l.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    // 先移到别处再移入，确保触发一次真实的 mouseover（上一段用例可能停在同一元素上）
    await p.mouse.move(li2.x,li2.y-200);await p.waitForTimeout(120);
    await p.mouse.move(li2.x,li2.y);await p.waitForTimeout(400);
    const hl=await p.evaluate(()=>({ul:getComputedStyle(document.querySelector('#previewContent ul')).backgroundColor,
      li:[...document.querySelectorAll('#previewContent li')].map(l=>getComputedStyle(l).backgroundColor)}));
    ck(hl.ul===TRANSPARENT,'hover 条目时整个列表不高亮',hl.ul);
    ck(hl.li[1]!==TRANSPARENT,'当前条目被高亮',JSON.stringify(hl.li));
    ck(hl.li[0]===TRANSPARENT&&hl.li[2]===TRANSPARENT,'其它条目不高亮',JSON.stringify(hl.li));
    await setSrc('- 外层项\n  - 内层项\n  - 内层项2\n- 外层项2');await p.waitForTimeout(400);
    const inner=await p.evaluate(()=>{
      const li=[...document.querySelectorAll('#previewContent li li')].find(x=>x.textContent.trim()==='内层项');
      const rng=document.createRange();rng.selectNodeContents(li);const r=rng.getClientRects()[0];
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.move(inner.x,inner.y-200);await p.waitForTimeout(120);
    await p.mouse.move(inner.x,inner.y);await p.waitForTimeout(400);
    const nb=await p.evaluate(()=>[...document.querySelectorAll('#previewContent li')]
      .map(l=>getComputedStyle(l).backgroundColor));
    ck(nb[0]===TRANSPARENT,'嵌套时外层项不高亮',JSON.stringify(nb));
    ck(nb[1]!==TRANSPARENT,'嵌套时只有最内层项高亮',JSON.stringify(nb));
    await p.mouse.move(5,5);await p.waitForTimeout(250);
  }

  // ---- 要求 39: 任务列表复选框与文字分工 ----------------------------------------
  {
    const T='- [ ] 待办A\n- [x] 待办B';
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);await p.mouse.move(5,5);
    await setSrc(T);await p.waitForTimeout(400);
    const cb=await p.evaluate(()=>{const c=document.querySelector('#previewContent .luogu-task-checkbox');
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(cb.x,cb.y);await p.waitForTimeout(500);
    ck((await src()).startsWith('- [x] 待办A'),'点复选框切换勾选',JSON.stringify(await src()));
    ck(!(await p.evaluate(()=>!!document.querySelector('.typora-block-input'))),
      '点复选框不进入编辑');
    await setSrc(T);await p.waitForTimeout(400);
    const tx=await p.evaluate(()=>{const t=document.querySelector('#previewContent .luogu-task-text');
      const rng=document.createRange();rng.selectNodeContents(t);const r=rng.getClientRects()[0];
      return {x:r.x+r.width/2,y:r.y+r.height/2};});
    await p.mouse.click(tx.x,tx.y);await p.waitForTimeout(450);
    ck((await box())==='- [ ] 待办A','点文字编辑该任务项',JSON.stringify(await box()));
    ck((await src())===T,'点文字不改变勾选状态',JSON.stringify(await src()));
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(400);
    ck((await src())===T,'收起后源码不变',JSON.stringify(await src()));
  }

  // ---- 要求 39: 编辑单元格期间不出现第二组骨架 ----------------------------------
  {
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(300);await p.mouse.move(5,5);
    await setSrc('| 甲 | 乙 |\n|:--:|:--:|\n| A | 1 |\n| ^ | 2 |\n| B | 3 |\n| ^ | 4 |');
    await p.waitForTimeout(400);
    const at=(t)=>p.evaluate((txt)=>{const c=[...document.querySelectorAll('#previewContent td')]
      .find(x=>x.textContent.trim()===txt);if(!c)return null;
      const r=c.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},t);
    let A=await at('A');await p.mouse.move(A.x,A.y);await p.waitForTimeout(320);
    A=await at('A');await p.mouse.click(A.x,A.y);await p.waitForTimeout(420);
    ck((await box()).trim()==='A','正在编辑 A 格',JSON.stringify(await box()));
    const B=await at('B');
    if(B){await p.mouse.move(B.x,B.y);await p.waitForTimeout(450);}
    const st=await p.evaluate(()=>({o:document.querySelectorAll('.typora-unmerged-origin').length,
      i:document.querySelectorAll('.typora-block-input').length}));
    ck(st.o<=1,'hover 另一合并格不产生第二组骨架',JSON.stringify(st));
    ck(st.i===1,'编辑框仍只有一个',JSON.stringify(st));
    const B2=await at('B');
    if(B2){await p.mouse.click(B2.x,B2.y);await p.waitForTimeout(500);}
    const st2=await p.evaluate(()=>({o:document.querySelectorAll('.typora-unmerged-origin').length,
      i:document.querySelectorAll('.typora-block-input').length}));
    ck(st2.o<=1&&st2.i<=1,'切换到另一格后仍只有一组',JSON.stringify(st2));
    await p.evaluate(()=>document.querySelector('.typora-block-input')?.blur());
    await p.waitForTimeout(350);await p.mouse.move(5,5);await p.waitForTimeout(300);
    ck(await p.evaluate(()=>document.querySelectorAll('.typora-unmerged-cell').length===0),
      '收起并移开后骨架清空');
  }







  console.log(`\nTypora ${pass+fail} 项，失败 ${fail}`);
  await b.close();process.exit(fail?1:0);
})();
