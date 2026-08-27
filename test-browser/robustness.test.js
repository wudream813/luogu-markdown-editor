const { chromium } = require('playwright');
const path=require('path');
const FILE = process.argv[2] || 'file://'+path.resolve(__dirname,'../LuoguMarkdownEditor.html');
// Robustness: malformed / adversarial input must not throw or hang.
const C=[
  ['空文档',''],
  ['仅空白','   \n\n\t\n  '],
  ['未闭合围栏','```cpp\nint a;'],
  ['未闭合容器',':::info\n内容'],
  ['未闭合公式','$x^2'],
  ['未闭合块公式','$$\nx^2'],
  ['未闭合表格','| a | b'],
  ['孤立表格分隔','|---|---|'],
  ['未闭合粗体','**bold'],
  ['未闭合链接','[text]('],
  ['未闭合图片','![alt]('],
  ['嵌套围栏','````\n```\n````'],
  ['容器深嵌套',':::info\n'.repeat(30)+'x\n'+':::\n'.repeat(30)],
  ['列表深嵌套',Array.from({length:40},(_,i)=>' '.repeat(i*2)+'- L'+i).join('\n')],
  ['引用深嵌套','>'.repeat(80)+' deep'],
  ['超长单行','a'.repeat(60000)],
  ['超多行',Array.from({length:6000},(_,i)=>'行 '+i).join('\n')],
  ['大量公式',Array.from({length:400},(_,i)=>`$x_{${i}}$`).join(' ')],
  ['大量代码块',Array.from({length:120},()=>'```cpp\nint a;\n```').join('\n\n')],
  ['ReDoS 强调','*'.repeat(400)],
  ['ReDoS 下划线','_'.repeat(400)],
  ['ReDoS 反引号','`'.repeat(400)],
  ['ReDoS 美元','$'.repeat(400)],
  ['ReDoS 方括号','['.repeat(300)+'x'+']'.repeat(300)],
  ['ReDoS 链接嵌套','[a](b'.repeat(200)],
  ['CRLF 换行','a\r\nb\r\n\r\nc'],
  ['孤立 CR','a\rb'],
  ['零宽字符','a\u200bb\u200c\u200dc'],
  ['RTL 字符','a\u202eb\u202dc'],
  ['代理对 emoji','👨‍👩‍👧‍👦 🇨🇳 x'],
  ['NULL 字符','a\u0000b'],
  ['组合字符','é'.repeat(100)+'\u0301'.repeat(100)],
  ['混合极端',':::info\n```\n$$\n| a |\n> q\n- l\n'.repeat(40)],
];
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto(FILE); await p.waitForTimeout(2600);
  let bad=0, slow=[];
  for(const [n,md] of C){
    const before=errs.length; const t0=Date.now();
    let timedOut=false;
    try{
      await p.evaluate(v=>{const t=document.querySelector('textarea');t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));},md);
      await p.waitForFunction(()=>!!document.querySelector('#previewContent'),{timeout:9000});
      await p.waitForTimeout(260);
    }catch(e){timedOut=true;}
    const ms=Date.now()-t0;
    const alive=await p.evaluate(()=>!!document.querySelector('textarea')).catch(()=>false);
    const newErr=errs.slice(before);
    if(timedOut||!alive||newErr.length){bad++;console.log(`❌ ${n} (${ms}ms)`,timedOut?'超时':'',!alive?'页面死':'',newErr[0]||'');}
    else if(ms>2500) slow.push(`${n} ${ms}ms`);
  }
  console.log(`\n健壮性 ${C.length} 项，失败 ${bad}`);
  if (bad) process.exitCode = 1;
  if(slow.length) console.log('偏慢:',slow.join(' | '));
  await b.close();
})();
