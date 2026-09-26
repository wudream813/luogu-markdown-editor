/**
 * Long-image (PNG) export.
 *
 * The capture has to survive four things that each silently ruin the picture:
 * the preview is a scroll container (only the visible slice would be drawn), its
 * scrollbars would be baked in, collapsed callouts would be shot shut, and the
 * scroll-sync tail padding would leave a blank strip under the article. Every one
 * of those must also be undone afterwards, so exporting does not disturb the page.
 *
 * SnapDOM clamps to the 32767px canvas limit by shrinking proportionally rather
 * than truncating, so "is it complete" is checked via aspect ratio, not height.
 */
const path = require('path');
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const APP = process.argv[2]
    || 'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  // What must never happen is the document reaching a third party. Same-origin
  // fetches are legitimate: in the hosted (multi-file) build SnapDOM reads the local
  // KaTeX font files in order to inline them. The single-file build already carries
  // them as data URIs, so it makes no requests at all.
  const origin = (() => { try { return new URL(APP).origin; } catch (e) { return null; } })();
  const net = [];
  const foreign = [];
  p.on('request', (r) => {
    const u = r.url();
    if (/^(file|data|blob):/.test(u)) return;
    net.push(u);
    if (!origin || !u.startsWith(origin)) foreign.push(u);
  });

  // 拦截下载，拿到 PNG 字节
  await p.goto(APP, { waitUntil: 'networkidle' });
  await p.evaluate(() => {
    window.__caught = null;
    const oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && /\.png$/.test(this.download)) {
        window.__caught = { name: this.download, href: this.href };
        return;
      }
      return oc.apply(this, arguments);
    };
  });

  let pass = 0, fail = 0;
  const ck = (c, n, x) => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, x || '')); };

  const run = async (md, label, theme) => {
    await p.evaluate(([v, th]) => {
      window.__caught = null;
      document.documentElement.setAttribute('data-theme', th);
      const ta = document.getElementById('editorTextarea');
      ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
      LuoguEditor.render(); LuoguEditor.setViewMode('preview');
    }, [md, theme || 'light']);
    await p.waitForTimeout(1200);
    const before = await p.evaluate(() => {
      const el = document.getElementById('previewContent');
      const cs = getComputedStyle(el);
      return { h: el.style.height, ov: el.style.overflow, st: el.scrollTop,
               pb: el.style.paddingBottom,
               open: [...el.querySelectorAll('details')].map((d) => d.open),
               overflowComputed: cs.overflowY };
    });
    const t0 = Date.now();
    net.length = 0; foreign.length = 0;   // 页面自身的加载不算"截图联网"
    await p.evaluate(() => LuoguEditor.exportImage());
    await p.waitForFunction(() => window.__caught !== null, { timeout: 120000 });
    const ms = Date.now() - t0;
    const got = await p.evaluate(() => window.__caught);
    const after = await p.evaluate(() => {
      const el = document.getElementById('previewContent');
      return { h: el.style.height, ov: el.style.overflow, st: el.scrollTop,
               pb: el.style.paddingBottom,
               open: [...el.querySelectorAll('details')].map((d) => d.open),
               leftoverStyle: !!document.querySelector('style')
                 && [...document.querySelectorAll('style')].some((x) => /scrollbar-width:none!important/.test(x.textContent)) };
    });
    const buf = Buffer.from(got.href.split(',')[1], 'base64');
    if (process.env.KEEP_SHOTS) fs.writeFileSync(`/tmp/w-${label}.png`, buf);
    // PNG 头部读尺寸
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    return { got, ms, w, h, kb: Math.round(buf.length / 1024), before, after };
  };

  console.log('=== 1) 基本导出（含公式/代码/表格/折叠框）===');
  const MD = '# 题解\n\n$$\\sum_{i=1}^{n}\\frac{1}{i^2}=\\frac{\\pi^2}{6}$$\n\n行内 $O(n\\log n)$。\n\n```cpp\nint main(){ return 0; }\n```\n\n| 甲 | 乙 |\n|:-:|:-:|\n| 1 | 2 |\n\n:::info[折叠的提示]\n这段在折叠框里，导出时应可见。\n:::';
  let r = await run(MD, 'basic');
  ck(/\.png$/.test(r.got.name), '触发 PNG 下载', r.got.name);
  ck(r.w > 100 && r.h > 100, `图片尺寸合理 ${r.w}×${r.h}`, `${r.w}×${r.h}`);
  console.log(`     ${r.w}×${r.h}, ${r.kb}KB, ${r.ms}ms`);
  ck(JSON.stringify(r.before.open) === JSON.stringify(r.after.open), '折叠框开合状态已还原',
    `${JSON.stringify(r.before.open)} -> ${JSON.stringify(r.after.open)}`);
  ck(r.after.h === r.before.h && r.after.ov === r.before.ov && r.after.pb === r.before.pb,
    '容器样式（含尾部留白）已还原', JSON.stringify(r.after));
  ck(!r.after.leftoverStyle, '临时隐藏滚动条的样式已移除');
  ck(foreign.length === 0, '截图期间无任何第三方请求（内容不外泄）', foreign.slice(0, 3).join(','));
  if (/^file:/.test(APP)) {
    ck(net.length === 0, '单文件版截图期间零网络请求（完全离线）', net.slice(0, 3).join(','));
  } else {
    ck(true, `托管版仅同源取本地字体用于内嵌（${net.length} 个同源请求）`);
  }

  console.log('\n=== 2) 长文档：是否完整、是否自动降 scale ===');
  for (const n of [60, 300, 700]) {
    const md = Array.from({ length: n }, (_, i) => `## 第 ${i} 节\n\n内容含 $O(n)$ 说明文字。`).join('\n\n');
    const rr = await run(md, `long${n}`);
    const srcH = await p.evaluate(() => document.getElementById('previewContent').scrollHeight);
    console.log(`  ${String(n).padStart(3)} 节: 内容 ${srcH}px → 图 ${rr.w}×${rr.h} (${rr.kb}KB, ${rr.ms}ms)`);
    ck(rr.h <= 32767, `未超画布上限`, String(rr.h));
    // 覆盖率：图高/ (内容高*scale) 应接近 1；至少不能只截到首屏
    // SnapDOM 超限时按比例整体缩小而非截断，所以用宽高比判断"是否完整"。
    // 尺寸必须在与截图相同的条件下测量：导出会去掉滚动同步用的尾部留白，
    // 用带留白的高度去比会得出"被截断"的错误结论。
    const dim = await p.evaluate(() => {
      const el = document.getElementById('previewContent');
      const save = [el.style.height, el.style.maxHeight, el.style.overflow, el.style.paddingBottom];
      el.style.height = 'auto'; el.style.maxHeight = 'none';
      el.style.overflow = 'visible'; el.style.paddingBottom = '0px';
      const d = { w: el.scrollWidth, h: el.scrollHeight };
      [el.style.height, el.style.maxHeight, el.style.overflow, el.style.paddingBottom] = save;
      return d;
    });
    const arSrc = dim.h / dim.w, arImg = rr.h / rr.w;
    ck(Math.abs(arSrc - arImg) / arSrc < 0.02, `完整成图（宽高比一致，非截断）`,
      `内容 ${dim.w}×${dim.h} 比 ${arSrc.toFixed(2)} vs 图 ${rr.w}×${rr.h} 比 ${arImg.toFixed(2)}`);
  }

  console.log('\n=== 3) 暗色主题 ===');
  r = await run(MD, 'dark', 'dark');
  ck(r.w > 100 && r.h > 100, `暗色导出成功 ${r.w}×${r.h}`);
  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  console.log('\n=== 4) 空文档 ===');
  await p.evaluate(() => {
    window.__caught = null;
    const ta = document.getElementById('editorTextarea');
    ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
    LuoguEditor.render();
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => LuoguEditor.exportImage());
  await p.waitForTimeout(800);
  ck(await p.evaluate(() => window.__caught === null), '空文档不产生下载');

  ck(errs.length === 0, '无 JS 报错', errs.slice(0, 2).join(' | '));
  console.log(`\n长图导出 ${pass + fail} 项，失败 ${fail}`);
  await b.close();
  process.exit(fail ? 1 : 0);
})();
