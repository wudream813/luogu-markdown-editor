const { chromium } = require('playwright');
const path=require('path');
const FILE = process.argv[2] || 'file://'+path.resolve(__dirname,'../LuoguMarkdownEditor.html');
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(FILE); await p.waitForTimeout(2600);
  const type = async (initial, keys) => {
    await p.evaluate(v=>{const t=document.querySelector('textarea');t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();t.selectionStart=t.selectionEnd=v.length;},initial);
    for(const k of keys){ if(k==='\n') await p.keyboard.press('Enter'); else await p.keyboard.type(k); }
    await p.waitForTimeout(150);
    return p.evaluate(()=>document.querySelector('textarea').value);
  };
  const C=[
    ['无序 -',        '- 第一项',        ['\n','第二项'],      '- 第一项\n- 第二项'],
    ['无序 *',        '* 第一项',        ['\n','第二项'],      '* 第一项\n* 第二项'],
    ['无序 +',        '+ 第一项',        ['\n','第二项'],      '+ 第一项\n+ 第二项'],
    ['有序递增',      '1. 第一项',       ['\n','第二项'],      '1. 第一项\n2. 第二项'],
    ['有序从5',       '5. 第五项',       ['\n','第六项'],      '5. 第五项\n6. 第六项'],
    ['有序 )',        '1) 第一项',       ['\n','第二项'],      '1) 第一项\n2) 第二项'],
    ['任务列表',      '- [ ] 任务一',    ['\n','任务二'],      '- [ ] 任务一\n- [ ] 任务二'],
    ['已勾选续行未勾', '- [x] 完成',      ['\n','下一个'],      '- [x] 完成\n- [ ] 下一个'],
    ['缩进保持',      '  - 缩进项',      ['\n','第二项'],      '  - 缩进项\n  - 第二项'],
    ['空项退出',      '- 第一项',        ['\n','\n'],          '- 第一项\n'],
    ['空任务先退框',   '- [ ] 任务',      ['\n','\n'],          '- [ ] 任务\n- '],
    ['空任务两次退出', '- [ ] 任务',      ['\n','\n','\n'],     '- [ ] 任务\n'],
    ['非列表不触发',   '普通文本',        ['\n','第二行'],      '普通文本\n第二行'],
    ['引用不触发',    '> 引用',          ['\n','第二行'],      '> 引用\n第二行'],
  ];
  let bad=0;
  for(const [n,init,keys,exp] of C){
    const got=await type(init,keys);
    if(got!==exp){bad++;console.log(`❌ ${n}\n    实得 ${JSON.stringify(got)}\n    期望 ${JSON.stringify(exp)}`);}
  }
  console.log(`\n列表续行 ${C.length} 项，失败 ${bad}`);
  if (bad) process.exitCode = 1;
  if(errs.length) console.log('异常:',errs.slice(0,3));
  await b.close();
})();
