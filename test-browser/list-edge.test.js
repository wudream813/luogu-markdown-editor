const { chromium } = require('playwright');
const path=require('path');
const FILE = process.argv[2] || 'file://'+path.resolve(__dirname,'../LuoguMarkdownEditor.html');
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(FILE); await p.waitForTimeout(2600);
  const setup=async v=>{await p.evaluate(x=>{const t=document.querySelector('textarea');t.value=x;t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.selectionStart=t.selectionEnd=x.length;},v);};
  const val=()=>p.evaluate(()=>document.querySelector('textarea').value);
  let bad=0; const chk=(n,got,exp)=>{ if(got!==exp){bad++;console.log(`❌ ${n}\n    实得 ${JSON.stringify(got)}\n    期望 ${JSON.stringify(exp)}`);} };

  // 1) Undo must revert the auto-inserted marker.
  await setup('- 第一项'); await p.keyboard.press('Enter'); await p.keyboard.type('第二项');
  await p.waitForTimeout(200); await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  const afterUndo=await val();
  if(!/第一项/.test(afterUndo)||/第二项$/.test(afterUndo)) console.log('  撤销后:',JSON.stringify(afterUndo));
  else console.log('✓ 撤销可回退');

  // 2) IME composition: Enter that confirms a candidate must NOT continue the list.
  await setup('- 项目');
  const imeResult = await p.evaluate(()=>{
    const t=document.querySelector('textarea');
    t.selectionStart=t.selectionEnd=t.value.length;
    t.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    const ev=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});
    Object.defineProperty(ev,'isComposing',{get:()=>true});
    t.dispatchEvent(ev);
    t.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
    return {defaultPrevented:ev.defaultPrevented, value:t.value};
  });
  chk('IME Enter 不应被拦截', imeResult.defaultPrevented, false);

  // 3) Caret mid-line: split, marker goes to the new line.
  await p.evaluate(()=>{const t=document.querySelector('textarea');t.value='- 前面后面';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.selectionStart=t.selectionEnd=4;});
  await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  chk('行中换行', await val(), '- 前面\n- 后面');

  // 4) Selection replacement.
  await p.evaluate(()=>{const t=document.querySelector('textarea');t.value='- 一\n- 二';t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.selectionStart=2;t.selectionEnd=5;});
  await p.keyboard.press('Enter'); await p.waitForTimeout(150);
  console.log('  选区替换后:',JSON.stringify(await val()));

  // 5) Deep nesting + big numbers
  await setup('      - 深缩进'); await p.keyboard.press('Enter'); await p.keyboard.type('x');
  chk('深缩进', await val(), '      - 深缩进\n      - x');
  await setup('99. 第九九'); await p.keyboard.press('Enter'); await p.keyboard.type('x');
  chk('大序号', await val(), '99. 第九九\n100. x');
  await setup('- [X] 大写勾'); await p.keyboard.press('Enter'); await p.keyboard.type('x');
  chk('大写 X', await val(), '- [X] 大写勾\n- [ ] x');

  console.log(`\n边界 失败 ${bad}`);
  if (bad) process.exitCode = 1;
  if(errs.length) console.log('异常:',errs.slice(0,3));
  await b.close();
})();
