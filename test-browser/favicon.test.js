/**
 * Favicon / app-icon suite.
 *
 * A favicon is fetched as an *image* resource, which uses a strict XML parser —
 * unlike inline SVG in an HTML document, which is parsed leniently. That gap once
 * shipped a broken icon here: the markup omitted `</linearGradient>`, rendered fine
 * when pasted into a page, and silently failed to decode as a favicon (naturalWidth
 * 0), leaving a blank tab. These checks decode every declared icon the same way a
 * browser does, so a malformed one cannot reach a release again.
 *
 * Usage: node test-browser/favicon.test.js [file-url-or-http-url]
 */
const { chromium } = require('playwright');
const path = require('path');

const target =
  process.argv[2] ||
  'file://' + path.resolve(__dirname, '..', 'LuoguMarkdownEditor.html');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`);
  }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(target);
  await page.waitForTimeout(600);

  // ---- Declared icon links ----
  const links = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]')].map((l) => ({
      rel: l.getAttribute('rel'),
      type: l.getAttribute('type'),
      sizes: l.getAttribute('sizes'),
      href: l.getAttribute('href'),
    }))
  );

  check('声明了 SVG favicon', links.some((l) => l.type === 'image/svg+xml'));
  check('声明了 PNG 回退图标', links.some((l) => l.rel.includes('icon') && l.type === 'image/png'));
  check('声明了 apple-touch-icon', links.some((l) => l.rel === 'apple-touch-icon'));

  // ---- Every icon must actually decode as an image ----
  for (const l of links) {
    const dim = await page.evaluate(
      (href) =>
        new Promise((res) => {
          const img = new Image();
          const done = () => res({ w: img.naturalWidth, h: img.naturalHeight });
          img.onload = done;
          img.onerror = () => res({ w: 0, h: 0 });
          img.src = href;
          setTimeout(done, 3000);
        }),
      l.href
    );
    const label = `${l.rel}${l.sizes ? ' ' + l.sizes : ''} 可解码为图像`;
    check(label, dim.w > 0 && dim.h > 0, `naturalWidth=${dim.w}`);
  }

  // ---- The SVG must be well-formed XML, not just lenient-HTML-parseable ----
  const svgLink = links.find((l) => l.type === 'image/svg+xml');
  if (svgLink) {
    const xmlOk = await page.evaluate((href) => {
      let svgText;
      try {
        svgText = decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, ''));
      } catch (e) {
        // A malformed percent-encoding is itself a broken icon, not a test crash.
        return { ok: false, msg: 'URI 编码非法: ' + String(e).slice(0, 80), gradientResolves: false };
      }
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const err = doc.querySelector('parsererror');
      return {
        ok: !err,
        msg: err ? err.textContent.replace(/\s+/g, ' ').slice(0, 120) : '',
        // A gradient referenced by fill="url(#id)" must resolve to a real element.
        gradientResolves: [...doc.querySelectorAll('[fill^="url(#"]')].every((el) => {
          const id = el.getAttribute('fill').match(/url\(#([^)]+)\)/)[1];
          return !!doc.getElementById(id);
        }),
      };
    }, svgLink.href);
    check('SVG 图标是合法 XML', xmlOk.ok, xmlOk.msg);
    check('SVG 渐变引用可解析', xmlOk.gradientResolves);
  }

  // ---- Manifest and theme colour ----
  const meta = await page.evaluate(() => ({
    theme: document.querySelector('meta[name="theme-color"]')?.content || null,
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') || null,
  }));
  check('设置了 theme-color', !!meta.theme, String(meta.theme));
  check('声明了 web app manifest', !!meta.manifest);

  if (meta.manifest) {
    const m = await page.evaluate((href) => {
      try {
        const json = decodeURIComponent(href.replace(/^data:application\/manifest\+json,/, ''));
        const o = JSON.parse(json);
        return { ok: true, name: o.name, icons: (o.icons || []).length, theme: o.theme_color };
      } catch (e) {
        return { ok: false, err: String(e).slice(0, 100) };
      }
    }, meta.manifest);
    check('manifest 是合法 JSON', m.ok, m.err || '');
    check('manifest 含图标条目', m.ok && m.icons > 0, `icons=${m.icons}`);
  }

  // ---- Offline: no icon may depend on the network ----
  const remote = links.filter((l) => /^(?:https?:)?\/\//i.test(l.href));
  check('图标全部内联（无远程请求）', remote.length === 0, remote.map((r) => r.href).join(', '));

  console.log(`\n图标 ${pass + fail} 项，失败 ${fail}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
