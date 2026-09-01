/**
 * Luogu Markdown Linter & Typography Engine (洛谷官方排版规范诊断与格式化引擎)
 * 100% 严格遵循《洛谷主题库题解规范》与《洛谷专栏全站推荐规范》三大基本规范：
 * 
 * 1. 标点符号规范：
 *    - 请正确使用【全角中文】标点符号。特别地，句末要有【句号】。
 * 
 * 2. 数学公式与 LaTeX 规范：
 *    - 数学公式（运算式、运算符、参与运算的常数、作为变量的字母等）应使用 LaTeX。
 *    - 非数学公式（一般英文单词、题目名、算法名如 DFS/BFS/DP、人名等）不应使用 LaTeX。
 *    - 同一个数学公式应写在同一个 LaTeX 环境内，严禁碎拼公式。
 *    - 乘号必须使用 \times (如 $a \times b$, $5 \times 10^9$)，严禁使用 * 代替乘号。
 *    - 特定的约定俗成函数名必须使用正体（如 \gcd, \max, \min, \log, \det），未定义函数使用 \operatorname (如 \operatorname{lcm}, \operatorname{dist}, \operatorname{lowbit})。
 *    - 位运算必须使用 \operatorname{and}, \operatorname{or}, \operatorname{xor}, \operatorname{not}。
 *    - 代码运算符自动转换：-> -> \to, <- -> \gets, <= -> \le, >= -> \ge, != -> \ne, == -> =, /ne -> \ne。
 * 
 * 3. 空格与排版规范：
 *    - 【中文】与【英文、数字或公式】之间以半角空格隔开（包括带 * / ** / ` 修饰的英文与斜杠 / 分隔项）。
 *    - 【中文标点符号】与【英文、数字或公式】之间【严格严禁有空格】。
 */

(function (global) {
  'use strict';

  // Common algorithm names and English acronyms that should NOT be in LaTeX
  const NON_MATH_LATEX_REGEX = /\$(DFS|BFS|Dijkstra|DP|SPFA|Kruskal|Prim|Trie|AC|WA|TLE|MLE|RE|CE|UKE|PC|C\+\+|Python|Java|Pascal|Tarjan|Floyd|Ford|Bellman|LCT|ST|SAM|ACAM)\$/gi;

  // Bare CJK inside $...$ / $$...$$. Text wrapped in \text{}-style commands is the
  // sanctioned way to put Chinese in a formula, so it is stripped before testing.
  const MATH_TEXT_WRAPPERS =
    /\\(?:text|mathrm|mathbf|operatorname|mathcal|mathsf|mathtt|textbf|textit|textstyle|displaystyle)\s*\{[^{}]*\}/g;

  // Standard TeX functions
  const STANDARD_MATH_FUNCS = ['gcd', 'max', 'min', 'log', 'ln', 'det', 'sin', 'cos', 'tan', 'exp', 'sup', 'inf', 'lim'];
  // Custom functions requiring \operatorname
  const CUSTOM_MATH_FUNCS = ['lcm', 'deg', 'dis', 'dist', 'size', 'len', 'lowbit', 'popcount', 'mex', 'MEX', 'opt', 'cost', 'rank', 'polylog'];

  // Helper to fix code operators and math symbols inside a single LaTeX formula string
  function fixFormulaMathSymbols(formula) {
    if (!formula) return formula;
    let f = formula.trim();

    // Standalone * -> \times
    if (f === '*' || f === '\\*') return '\\times';

    // Common typo /ne, /le, /ge, /to, /gets with forward slash
    f = f.replace(/\/ne\b/g, '\\ne ');
    f = f.replace(/\/le\b/g, '\\le ');
    f = f.replace(/\/ge\b/g, '\\ge ');
    f = f.replace(/\/to\b/g, '\\to ');
    f = f.replace(/\/gets\b/g, '\\gets ');

    // 1. Code operators to LaTeX math macros
    f = f.replace(/<=/g, '\\le ');
    f = f.replace(/>=/g, '\\ge ');
    f = f.replace(/!=/g, '\\ne ');
    f = f.replace(/->/g, '\\to ');
    f = f.replace(/<-/g, '\\gets ');
    f = f.replace(/==/g, '=');

    // 2. Binary multiplication * -> \times (e.g. a * b -> a \times b, 5 * 10^9 -> 5 \times 10^9)
    f = f.replace(/([a-zA-Z0-9_\}\)\]])\s*\*+\s*([a-zA-Z0-9_\\\{\(\[])/g, '$1 \\times $2');
    f = f.replace(/\s+\*\s+/g, ' \\times ');

    // 3. Bitwise operations: and, or, xor, not -> \operatorname{and}, \operatorname{or}, \operatorname{xor}
    f = f.replace(/(?<!\\operatorname\{|\\mathrm\{|\\text\{|\\)\b(and|or|xor|not)\b/gi, '\\operatorname{$1}');

    // 4. Standard math functions -> \gcd, \max, \min, \log, \ln, \det, \sin, \cos, \tan, \exp
    for (const fn of STANDARD_MATH_FUNCS) {
      const regex = new RegExp(`(?<!\\\\operatorname\\{|\\\\mathrm\\{|\\\\text\\{|\\\\)\\b${fn}\\b`, 'g');
      f = f.replace(regex, `\\${fn}`);
    }

    // 5. Custom math functions -> \operatorname{lcm}, \operatorname{dist}, \operatorname{lowbit}, etc.
    for (const fn of CUSTOM_MATH_FUNCS) {
      const regex = new RegExp(`(?<!\\\\operatorname\\{|\\\\mathrm\\{|\\\\text\\{|\\\\)\\b${fn}\\b`, 'g');
      f = f.replace(regex, `\\operatorname{${fn}}`);
    }

    // 6. Complexity big O: O(n log n) -> \mathcal{O}(n \log n)
    //
    // The `log` rule must not fire on a `log` that is already a macro. Step 4 has
    // normally turned `log` into `\log` by now, and without the lookbehind this rule
    // matched the bare `log` inside `\log`, leaving the backslash stranded as `\ `
    // (a LaTeX hard space): `\mathcal{O}(n \log n)` -> `\mathcal{O}(n \ \log n)`.
    // That is idempotence-breaking — every format pass corrupted the formula further.
    f = f.replace(/\bO\((.*?)\)/g, '\\mathcal{O}($1)');
    f = f.replace(/\\mathcal\{O\}\((.*?)\s*(?<!\\)\blog\s*(.*?)\)/g, '\\mathcal{O}($1 \\log $2)');

    // 7. Wrap bare CJK in \text{}: $中文$ -> $\text{中文}$
    f = wrapBareCjkInMath(f);

    // Clean redundant multiple spaces
    f = f.replace(/ {2,}/g, ' ');
    return f.trim();
  }

  // Heuristic used ONLY by the autofix (never by the renderer, which always renders):
  // decide whether "$...$" is a formula or just two currency signs in a sentence.
  function looksLikeInlineFormula(formula) {
    const f = (formula || '').trim();
    if (!f) return false;
    const bare = f.replace(
      /\\(?:text|mathrm|mathbf|operatorname|mathcal|mathsf|mathtt|textbf|textit|textstyle|displaystyle)\s*\{[^{}]*\}/g,
      ''
    );
    if (!/[\u4e00-\u9fa5]/.test(bare)) return true;
    // Sentence punctuation means we are looking at prose between two currency signs.
    if (/[，。；：、！？“”‘’（）《》【】]/.test(bare)) return false;
    // A LaTeX signal settles it: definitely a formula.
    if (/\\[a-zA-Z]+|[_^{}]|[+\-*/=<>]|\\\\/.test(bare)) return true;
    // Otherwise it is pure CJK such as "$中文$". Treat it as a formula the author
    // wrote by hand (so the fix can wrap it) unless it looks like currency, i.e. the
    // run starts or ends with a digit — "$5和$10" pairs "5和" between two prices.
    return !/^\d|\d$/.test(bare.trim());
  }

  // Wrap runs of bare CJK inside a formula in \text{}. Chinese already inside
  // \text{}/\mathrm{}/... is left alone, so running the fix twice is a no-op.
  function wrapBareCjkInMath(formula) {
    if (!formula || !/[\u4e00-\u9fa5]/.test(formula)) return formula;

    // Split into "already wrapped" and "everything else" segments, then only
    // rewrite the latter. A single global regex cannot do this safely because it
    // has no way to know whether a match sits inside an existing \text{...}.
    const wrapper =
      /\\(?:text|mathrm|mathbf|operatorname|mathcal|mathsf|mathtt|textbf|textit)\s*\{[^{}]*\}/g;
    let out = '';
    let last = 0;
    let m;
    wrapper.lastIndex = 0;
    while ((m = wrapper.exec(formula)) !== null) {
      out += wrapPlainSegment(formula.slice(last, m.index));
      out += m[0];
      last = m.index + m[0].length;
    }
    out += wrapPlainSegment(formula.slice(last));
    return out;
  }

  // Wrap each maximal run of CJK (plus the CJK punctuation glued to it) in \text{}.
  function wrapPlainSegment(seg) {
    if (!seg || !/[\u4e00-\u9fa5]/.test(seg)) return seg;
    return seg.replace(
      /[\u4e00-\u9fa5][\u4e00-\u9fa5\u3000-\u303f\uff01-\uff5e]*/g,
      (run) => {
        // Trailing CJK punctuation reads better outside the \text{} block.
        const mm = run.match(/^([\s\S]*?[\u4e00-\u9fa5])([\u3000-\u303f\uff01-\uff5e]*)$/);
        const core = mm ? mm[1] : run;
        const tail = mm ? mm[2] : '';
        return `\\text{${core}}${tail}`;
      }
    );
  }

  class LuoguLinter {
    constructor() {}

    // Run comprehensive checks on markdown text
    lint(markdown) {
      if (!markdown || typeof markdown !== 'string') {
        return { issues: [], score: 100, isPerfect: true, stats: { errors: 0, warnings: 0, suggestions: 0 } };
      }

      const issues = [];
      const lines = markdown.split(/\r?\n/);
      let inCodeBlock = false;
      let lastHeadingLevel = 0;

      for (let i = 0; i < lines.length; i++) {
        const lineNum = i + 1;
        let line = lines[i];
        const trimmed = line.trim();

        // 1. Code block detection & language check
        if (/^[`~]{3,}/.test(trimmed)) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            const args = trimmed.replace(/^[`~]{3,}/, '').trim();
            if (!args) {
              issues.push({
                line: lineNum,
                type: 'warning',
                title: '代码块未指定语言',
                message: '《洛谷题解规范》要求代码块必须声明编程语言（如 ```cpp、```python），未指定时洛谷会默认按 C++ 高亮。',
                rule: 'code-language',
                fixable: true
              });
            }
          } else {
            inCodeBlock = false;
          }
          continue;
        }

        if (inCodeBlock) continue;

        // `++text++` is not Markdown. Some editors render it as an underline, but
        // Luogu's renderer (Remark + Rehype on a GFM base) emits it literally, so
        // the text ships with visible plus signs. Flag it rather than silently
        // rendering something Luogu will not reproduce.
        if (/\+\+(?=\S)[\s\S]*?\S\+\+/.test(line)) {
          issues.push({
            line: lineNum,
            type: 'warning',
            title: '洛谷不支持 ++下划线++ 语法',
            message: '洛谷渲染器基于 GFM，没有 ++ 下划线语法，该写法会原样显示为 ++文字++。如需强调请改用 **加粗** 或 *斜体*。',
            rule: 'unsupported-ins'
          });
        }

        // Skip pure container tags or horizontal rules or empty lines
        if (!trimmed || /^(\*{3,}|-{3,}|_{3,})$/.test(trimmed) || /^:{2,}/.test(trimmed) || /^::cute-table/i.test(trimmed)) {
          continue;
        }

        // 2. Prohibited / Sensational phrases check (禁止无意义求过言论)
        if (/(求管理员通过|求过|蒟蒻的第一篇题解|大佬轻喷|点个赞再走吧|求赞|管理员大大|蒟蒻刚学|神犇们)/i.test(line)) {
          issues.push({
            line: lineNum,
            type: 'error',
            title: '包含违规的无意义求过言论',
            message: '《洛谷题解规范》明确禁止出现闲聊、吐槽、加戏、求赞、求管理员通过、「蒟蒻的第一篇题解」等内容，否则直接拒稿。',
            rule: 'no-meaningless-text',
            fixable: false
          });
        }

        // 3. Heading hierarchy check
        let isHeadingLine = false;
        const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
          isHeadingLine = true;
          const level = headingMatch[1].length;
          if (lastHeadingLevel > 0 && level > lastHeadingLevel + 1) {
            issues.push({
              line: lineNum,
              type: 'warning',
              title: '标题层级跳跃',
              message: `从 H${lastHeadingLevel} 直接跳到了 H${level}。规范要求标题应对文章结构进行有序引导，不应跳级。`,
              rule: 'heading-hierarchy',
              fixable: false
            });
          }
          lastHeadingLevel = level;
          line = headingMatch[2];
        }

        // 4. Non-math algorithms / acronyms in LaTeX check ($DFS$, $DP$)
        const nonMathMatch = line.match(NON_MATH_LATEX_REGEX);
        if (nonMathMatch) {
          // NON_MATH_LATEX_REGEX has the global flag, so .match() returns full-match strings
          // (["$DFS$", ...]) rather than capture groups. Strip the surrounding "$" to get the
          // actual name (e.g. "DFS") for the hint text; without this the message shows "undefined".
          const nonMathName = (nonMathMatch[0] || '').replace(/^\$+|\$+$/g, '');
          issues.push({
            line: lineNum,
            type: 'warning',
            title: '非数学公式（算法名/英文单词）误用 LaTeX',
            message: `《洛谷基本规范第 2 条》规定：非数学公式（一般英文单词、题目名、算法名、人名等）不应使用 LaTeX。应写为 ${nonMathName} 而非 $${nonMathName}$。点击【洛谷排版修复】可一键自动去除 $ 符号。`,
            rule: 'non-math-latex',
            fixable: true
          });
        }

        // 4b. Bare Chinese inside a formula. This renders fine, but the Luogu style
        // guide asks authors to keep prose out of LaTeX, so warn rather than refuse.
        const cjkFormulas = [];
        const collectCjk = (re, isDisplay) => {
          let m;
          re.lastIndex = 0;
          while ((m = re.exec(line)) !== null) {
            const raw = m[1] || '';
            const body = raw.replace(MATH_TEXT_WRAPPERS, '');
            if (!/[\u4e00-\u9fa5]/.test(body)) continue;
            // Only flag what the autofix can actually fix, so the warning never sticks.
            if (!isDisplay && !looksLikeInlineFormula(raw)) continue;
            cjkFormulas.push(m[0].trim().replace(/^[^$]+/, ''));
          }
        };
        collectCjk(/\$\$([^\$]+?)\$\$/g, true);
        collectCjk(/(?:^|[^\\$])\$([^\$\n]+?)\$/g, false);
        if (cjkFormulas.length > 0) {
          const sample = cjkFormulas[0].length > 24
            ? `${cjkFormulas[0].slice(0, 24)}…`
            : cjkFormulas[0];
          issues.push({
            line: lineNum,
            type: 'warning',
            title: '公式中包含中文',
            message: `《洛谷题解规范》建议：中文一般不要放在 LaTeX 公式中（如 ${sample}）。公式仍会正常渲染。点击【洛谷排版修复】可自动包裹为 $\\text{中文}$。`,
            rule: 'cjk-in-math',
            fixable: true
          });
        }

        // 5. Code operators, unformatted math functions & multiplication * inside LaTeX formulas
        const formulaMatches = line.match(/\$[^\$\n]+?\$|\$\$[\s\S]*?\$\$/g);
        if (formulaMatches) {
          for (const f of formulaMatches) {
            // Standalone * in formula: $*$
            if (/^\$\s*\*+\s*\$$/.test(f.trim())) {
              issues.push({
                line: lineNum,
                type: 'warning',
                title: '数学公式中乘号使用了星号 *',
                message: '《洛谷数学公式规范》要求：乘号应使用 $\\times$ 或 $\\cdot$，严禁使用 * 代替乘号。点击【洛谷排版修复】可一键修复。',
                rule: 'math-multiplication-star',
                fixable: true
              });
              break;
            }

            // Code operators: ->, !=, <=, >=, /ne
            if (/(<=|>=|!=|->|<-|==|\/ne\b|\/le\b|\/ge\b)/.test(f)) {
              issues.push({
                line: lineNum,
                type: 'warning',
                title: 'LaTeX 公式中使用了代码运算符',
                message: '《洛谷数学公式规范》要求公式中使用数学语言而非代码语言：<= 应写为 $\\le$，>= 应写为 $\\ge$，!= 应写为 $\\ne$，-> 应写为 $\\to$，<- 应写为 $\\gets$。点击【洛谷排版修复】可一键自动转换。',
                rule: 'math-operator-latex',
                fixable: true
              });
              break;
            }

            // Multiplication * in formula: $a * b$
            if (/(?<!\^|\_)\s*\*\s*/.test(f)) {
              issues.push({
                line: lineNum,
                type: 'warning',
                title: '数学公式中乘号使用了星号 *',
                message: '《洛谷数学公式规范》要求：乘号应使用 $\\times$ 或 $\\cdot$（如 $a \\times b$），严禁使用 * 代替乘号。点击【洛谷排版修复】可一键修复。',
                rule: 'math-multiplication-star',
                fixable: true
              });
              break;
            }

            // Unformatted math functions: gcd, lcm, max, min, log, det, and, or, xor
            if (/(?<!\\operatorname\{|\\mathrm\{|\\text\{|\\)\b(gcd|lcm|max|min|log|ln|det|and|or|xor|lowbit|popcount|dist)\b/i.test(f)) {
              issues.push({
                line: lineNum,
                type: 'warning',
                title: '数学函数或位运算符未按规范使用正体',
                message: '《洛谷数学公式规范》要求：特定函数名应使用正体（如 $\\gcd, \\max, \\min, \\log, \\det$），未定义函数使用 $\\operatorname{lcm}, \\operatorname{dist}$，位运算使用 $\\operatorname{and}, \\operatorname{or}, \\operatorname{xor}$。点击【洛谷排版修复】可一键修复。',
                rule: 'math-function-upright',
                fixable: true
              });
              break;
            }
          }
        }

        // 6. Split formulas detection ($a$ + $b$ = $c$)
        if (/\$[a-zA-Z0-9_\^\{\}\\\+\-\*\/\(\)\s]+\$\s*(?:[+\-=><*\/]|<=|>=|!=|==|\-)\s*\$[a-zA-Z0-9_\^\{\}\\\+\-\*\/\(\)\s]+\$/.test(line)) {
          issues.push({
            line: lineNum,
            type: 'warning',
            title: '公式碎拼（割裂）',
            message: '《洛谷数学公式规范》要求：同一个数学公式应写在同一个 LaTeX 环境内，严禁拆分成多个独立的 $ 包裹（如 $a$ + $b$ 应写为 $a + b$）。',
            rule: 'math-split',
            fixable: false
          });
        }

        // 7. Halfwidth punctuation & sentence end period check (strictly excluding headings, lists, tables, quotes)
        if (!isHeadingLine && !trimmed.startsWith('|') && !trimmed.startsWith('>') && !/^[#\*\+\-\d\.\s]/.test(trimmed)) {
          // Halfwidth comma, colon, question, exclamation, semicolon
          if (/([\u4e00-\u9fa5]),|,\s*([\u4e00-\u9fa5])|([\u4e00-\u9fa5])\?|([\u4e00-\u9fa5])!|([\u4e00-\u9fa5]);|([\u4e00-\u9fa5]):(?![\/\d])/.test(line)) {
            issues.push({
              line: lineNum,
              type: 'warning',
              title: '中文句子中使用了半角标点符号',
              message: '《洛谷基本规范第 1 条》明确要求：请正确使用【全角中文】标点符号（如 ，。！？：； 代替英文半角符号）。',
              rule: 'fullwidth-punctuation',
              fixable: true
            });
          }

          // Halfwidth period inside Chinese text (如 格式化.再如)
          if (/([\u4e00-\u9fa5])\.\s*([\u4e00-\u9fa5])/.test(line)) {
            issues.push({
              line: lineNum,
              type: 'warning',
              title: '中文句子中使用了英文半角句号 .',
              message: '《洛谷基本规范第 1 条》明确要求：请使用全角中文标点符号（如用 句号 。 代替英文半角句号 .）。',
              rule: 'fullwidth-period',
              fixable: true
            });
          }

          // Halfwidth period at end of Chinese sentence (如 ...满足条件. )
          if (/[\u4e00-\u9fa5\$]\s*\.\s*$/.test(trimmed)) {
            issues.push({
              line: lineNum,
              type: 'warning',
              title: '句末使用了英文半角句号 .',
              message: '《洛谷基本规范第 1 条》明确要求：中文句末请使用全角句号 。 代替英文半角句号 .',
              rule: 'fullwidth-period',
              fixable: true
            });
          }

          // Missing sentence-end period. Deliberately NOT evaluated here: a Markdown
          // paragraph may span several lines, and judging each line on its own flagged
          // every line but the last one. Collected after the loop instead, where whole
          // paragraphs are visible. See the paragraph pass below.
        }

        // 8. Sanitize line for typography checks
        let testLine = line;

        // Strip images and video embeds
        testLine = testLine.replace(/!\[.*?\]\(.*?\)/g, '');
        testLine = testLine.replace(/<https?:\/\/[^\s>]+>/g, '');
        testLine = testLine.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

        // Protect inline code spans
        testLine = testLine.replace(/`[^`]+`/g, '@@CODE@@');

        // Protect backslash escapes
        testLine = testLine.replace(/\\([\\`\*_{}\[\]()#+\-.!$~|])/g, '@@ESC@@');

        // 9. Slash without space check (前/后, 中文/English)
        const slashMissingSpace = testLine.match(/([\u4e00-\u9fa5])\/([a-zA-Z0-9\u4e00-\u9fa5])|([a-zA-Z0-9])\/([\u4e00-\u9fa5])/);
        if (slashMissingSpace && !testLine.includes('http://') && !testLine.includes('https://')) {
          issues.push({
            line: lineNum,
            type: 'info',
            title: '斜杠 / 两侧缺少空格',
            message: '《洛谷基本规范第 3 条》要求：中文与英文或不同选项使用斜杠分隔时，两侧应留有半角空格（如 前 / 后、中文 / English）。',
            rule: 'slash-spacing',
            fixable: true
          });
        }

        // 10. Check styled markdown wrappers adjacent to Chinese: 中文*and* or *and*中文 or 中文**bold**
        const styledMissingSpace = testLine.match(/([\u4e00-\u9fa5])(\*{1,3}|_{1,3}|~~)([a-zA-Z0-9])|([a-zA-Z0-9])(\*{1,3}|_{1,3}|~~)([\u4e00-\u9fa5])/);
        if (styledMissingSpace) {
          issues.push({
            line: lineNum,
            type: 'info',
            title: '中英文间缺少空格（含修饰符）',
            message: '《洛谷基本规范第 3 条》要求：中文与英文、数字或公式（即使包含粗体或斜体修饰，如 `中文 *and* 标点`）之间应以半角空格隔开。',
            rule: 'cjk-styled-spacing',
            fixable: true
          });
        }

        // Strip markdown emphasis markers around words
        testLine = testLine.replace(/(\*\*\*|___|\*\*|__|\*|_|~~)/g, '');

        // Protect display & inline math formulas
        testLine = testLine.replace(/\$\$[\s\S]*?\$\$/g, '@@MATH@@');
        testLine = testLine.replace(/\$([^\$\n]+?)\$/g, '@@MATH@@');

        // 11. Chinese punctuation with unwanted spaces check (中文标点与英文/公式间严禁空格)
        const cjkPunctUnwantedSpace = testLine.match(/(@@MATH@@|@@CODE@@|[a-zA-Z0-9])\s+([，。！？：；、“”‘’（）【】《》])|([，。！？：；、“”‘’（）【】《》])\s+(@@MATH@@|@@CODE@@|[a-zA-Z0-9])/);
        if (cjkPunctUnwantedSpace) {
          issues.push({
            line: lineNum,
            type: 'info',
            title: '中文标点符号与英文/公式间有多余空格',
            message: '《洛谷基本规范第 3 条》明确要求：中文标点符号与英文、数字或公式之间【严格严禁有空格】（如 `$n \\le 10^5$，` 正确，`$n \\le 10^5$ ，` 违规）。',
            rule: 'cjk-punct-spacing',
            fixable: true
          });
        }

        // 12. Missing space between Chinese and Latin/Digits/Math
        const cjkLatin = testLine.match(/([\u4e00-\u9fa5])([a-zA-Z0-9])/);
        const latinCjk = testLine.match(/([a-zA-Z0-9])([\u4e00-\u9fa5])/);
        const cjkMath = testLine.match(/([\u4e00-\u9fa5])(@@MATH@@|@@CODE@@)|(@@MATH@@|@@CODE@@)([\u4e00-\u9fa5])/);

        if ((cjkLatin || latinCjk || cjkMath) && !cjkPunctUnwantedSpace && !styledMissingSpace) {
          issues.push({
            line: lineNum,
            type: 'info',
            title: '中英文/公式间缺少空格',
            message: '《洛谷基本规范第 3 条》要求：中文汉字与英文单词、数字或 LaTeX 公式之间必须以半角空格隔开。',
            rule: 'cjk-spacing',
            fixable: true
          });
        }
      }

      // ---- Sentence-end period, evaluated per PARAGRAPH ----
      //
      // A Markdown paragraph is a run of non-blank lines, and only its LAST line ends
      // a sentence. The previous per-line check flagged every other line of a wrapped
      // paragraph, plus setext headings, container bodies, $$...$$ interiors and
      // indented continuations. Rebuild the block structure here so only genuine
      // paragraph endings are judged.
      {
        const END_PUNCT = /[。！？：；…”’）】》、,.!?:;)\]}"'`]$/;
        let inFence = false;
        let inMathBlock = false;
        const containerStack = [];
        let para = null;                     // { startIdx, lines: [] }

        const flush = () => {
          if (!para) return;
          const lastIdx = para.startIdx + para.lines.length - 1;
          const lastLine = para.lines[para.lines.length - 1].trim();
          para = null;

          if (!lastLine) return;
          // Setext heading underline (=== / ---) means the run was a heading.
          if (/^(=+|-+)$/.test(lastLine)) return;
          // Structural or non-prose endings.
          if (/^[|>#]/.test(lastLine)) return;
          if (/^:{3,}/.test(lastLine)) return;
          if (/^(\*{3,}|-{3,}|_{3,})$/.test(lastLine)) return;
          // Pure media/link/html lines carry no sentence.
          if (/^!\[[^\]]*\]\([^)]*\)$/.test(lastLine)) return;
          if (/^\[[^\]]*\]\([^)]*\)$/.test(lastLine)) return;
          if (/^<.*>$/.test(lastLine)) return;
          if (/^\$\$/.test(lastLine) || /\$\$$/.test(lastLine)) return;
          if (END_PUNCT.test(lastLine)) return;

          // Only prose-looking endings qualify.
          const endsProse = /[\u4e00-\u9fa5a-zA-Z0-9]$/.test(lastLine)
            || /\$[^$\n]+\$$/.test(lastLine);
          if (!endsProse) return;

          issues.push({
            line: lastIdx + 1,
            type: 'info',
            title: '句末缺少句号等标点符号',
            message: '《洛谷基本规范第 1 条》明确要求：特别地，句末要有【句号】。点击【洛谷排版修复】可自动补全句末句号。',
            rule: 'missing-end-period',
            fixable: true
          });
        };

        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i];
          const t = raw.trim();

          if (/^[`~]{3,}/.test(t)) { flush(); inFence = !inFence; continue; }
          if (inFence) continue;

          // $$ on its own line toggles a display-math block.
          if (/^\$\$/.test(t) && !/\$\$.*\$\$/.test(t)) {
            flush(); inMathBlock = !inMathBlock; continue;
          }
          if (inMathBlock) continue;

          const openC = t.match(/^(:{3,})[a-zA-Z0-9_-]+/);
          const closeC = t.match(/^(:{3,})\s*$/);
          if (openC) { flush(); containerStack.push(openC[1].length); continue; }
          if (closeC) { flush(); containerStack.pop(); continue; }

          if (!t) { flush(); continue; }
          // Structural lines never join a prose paragraph.
          if (/^[|>#]/.test(t) || /^(\*{3,}|-{3,}|_{3,})$/.test(t)
              || /^\s*([*+-]|\d+[.)])\s+/.test(raw) || /^::cute-table/i.test(t)) {
            flush(); continue;
          }

          if (!para) para = { startIdx: i, lines: [] };
          para.lines.push(raw);
        }
        flush();
      }

      // Calculate health score
      let errors = 0, warnings = 0, suggestions = 0;
      let penalty = 0;
      for (const issue of issues) {
        if (issue.type === 'error') { errors++; penalty += 20; }
        else if (issue.type === 'warning') { warnings++; penalty += 6; }
        else if (issue.type === 'info') { suggestions++; penalty += 2; }
      }
      const score = Math.max(0, 100 - penalty);

      return {
        issues,
        score,
        isPerfect: issues.length === 0,
        stats: { errors, warnings, suggestions }
      };
    }

    // Auto format spacing, punctuation, sentence-end periods, and LaTeX math symbols strictly adhering to Luogu standards
    formatSpacing(markdown) {
      if (!markdown || typeof markdown !== 'string') return '';

      const lines = markdown.split(/\r?\n/);
      let inCodeBlock = false;
      let inMathBlock = false;
      const formattedLines = [];

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // Code block toggle
        if (/^[`~]{3,}/.test(line.trim())) {
          inCodeBlock = !inCodeBlock;
          formattedLines.push(line);
          continue;
        }

        if (inCodeBlock) {
          formattedLines.push(line);
          continue;
        }

        // A display-math block delimited by a lone `$$` is LaTeX, not prose: the
        // linter already exempts it, but the fixer did not track it and happily
        // appended a sentence period inside the equation ("x = 1。"), corrupting it.
        if (/^\$\$/.test(line.trim()) && !/\$\$[\s\S]*\$\$/.test(line.trim())) {
          inMathBlock = !inMathBlock;
          formattedLines.push(line);
          continue;
        }
        if (inMathBlock) {
          formattedLines.push(line);
          continue;
        }

        // Trailing whitespace is structural in Markdown: two or more spaces at end of
        // line are a hard line break. Many rules below collapse whitespace (notably the
        // ones around CJK punctuation) and would eat that break, joining the two lines
        // in the rendered output. Detach it up front and re-attach it at the very end,
        // so no individual rule has to remember it exists.
        //
        // A run of >= 2 is normalised to exactly 2 (the canonical hard break); a single
        // trailing space carries no meaning and is dropped.
        const trailingWs = (line.match(/[ \t]+$/) || [''])[0];
        const hardBreak = trailingWs.length >= 2 ? '  ' : '';
        if (trailingWs) line = line.slice(0, line.length - trailingWs.length);

        // A line that was nothing but whitespace is blank; emit it empty.
        if (!line) {
          formattedLines.push('');
          continue;
        }

        // 1. Fix non-math algorithm names inside LaTeX before tokenizing: $dfs$ -> dfs, $DP$ -> DP
        line = line.replace(NON_MATH_LATEX_REGEX, '$1');

        const tokens = [];
        let tokenIdx = 0;

        // 2. Protect URLs and images
        line = line.replace(/!\[(.*?)\]\((.*?)\)/g, (m) => {
          const id = `LUOGUTOKENMEDIA${tokenIdx++}END`;
          tokens.push({ id, val: m });
          return id;
        });

        line = line.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (m) => {
          const id = `LUOGUTOKENLINK${tokenIdx++}END`;
          tokens.push({ id, val: m });
          return id;
        });

        line = line.replace(/(https?:\/\/[^\s\)]+)/g, (m) => {
          const id = `LUOGUTOKENURL${tokenIdx++}END`;
          tokens.push({ id, val: m });
          return id;
        });

        // 3. Protect inline code
        line = line.replace(/(`[^`\n]+`)/g, (m) => {
          const id = `LUOGUTOKENCODE${tokenIdx++}END`;
          tokens.push({ id, val: m });
          return id;
        });

        // 4. Protect display math $$...$$ FIRST (and fix symbols inside)
        line = line.replace(/\$\$([\s\S]*?)\$\$/g, (match, formula) => {
          const id = `LUOGUTOKENDISPLAYMATH${tokenIdx++}END`;
          const fixed = '$$' + (formula.includes('\n') ? '\n' + fixFormulaMathSymbols(formula) + '\n' : fixFormulaMathSymbols(formula)) + '$$';
          tokens.push({ id, val: fixed });
          return id;
        });

        // 5. Protect inline math $...$ AFTER display math (and fix symbols inside).
        // A span that is really two currency signs in prose ("花费$5和$10 元") must be
        // left completely alone — wrapping its text in \text{} would turn ordinary
        // prose into a formula.
        line = line.replace(/\$([^\$\n]+?)\$/g, (match, formula) => {
          if (!looksLikeInlineFormula(formula)) {
            // Tokenise it anyway. Leaving the raw "$5和$10" in the line let the later
            // CJK<->Latin spacing rule see a bare digit next to a Chinese character and
            // "fix" it into "$5 和$10", re-breaking the currency case on every run.
            const cid = `LUOGUTOKENCURRENCY${tokenIdx++}END`;
            tokens.push({ id: cid, val: match });
            return cid;
          }
          const id = `LUOGUTOKENINLINEMATH${tokenIdx++}END`;
          const fixed = '$' + fixFormulaMathSymbols(formula) + '$';
          tokens.push({ id, val: fixed });
          return id;
        });

        // 6. Protect escaped symbols.
        //
        // This MUST run after the math rules above. It used to run before them, and
        // because `\{` etc. were replaced by an opaque LUOGUTOKENESC<n>END first, the
        // `$...$` matcher could no longer see a formula in `$\{$` — the token leaked
        // into the document as literal text. Escapes inside math are part of the
        // formula and are handled by fixFormulaMathSymbols; only escapes in ordinary
        // prose still need protecting from the spacing rules.
        line = line.replace(/\\([\\`\*_{}\[\]()#+\-.!$~|])/g, (m) => {
          const id = `LUOGUTOKENESC${tokenIdx++}END`;
          tokens.push({ id, val: m });
          return id;
        });

        // 7. Convert halfwidth punctuation in Chinese context to fullwidth
        line = line.replace(/([\u4e00-\u9fa5]),/g, '$1，');
        line = line.replace(/,([\u4e00-\u9fa5])/g, '，$1');
        line = line.replace(/([\u4e00-\u9fa5])\?/g, '$1？');
        line = line.replace(/([\u4e00-\u9fa5])!/g, '$1！');
        line = line.replace(/([\u4e00-\u9fa5]);/g, '$1；');
        line = line.replace(/([\u4e00-\u9fa5]):(?![\/\d])/g, '$1：');
        // Convert halfwidth period inside Chinese sentence: 格式化.再如 -> 格式化。再如
        line = line.replace(/([\u4e00-\u9fa5])\.\s*([\u4e00-\u9fa5])/g, '$1。$2');
        line = line.replace(/([\u4e00-\u9fa5])\.\s*$/g, '$1。');

        // 8. Clean spaces around formatted Chinese punctuation: **注意：** 要 -> **注意：**要
        const cjkPunct = '[，。！？：；、“”‘’（）【】《》、]';
        line = line.replace(new RegExp(`(${cjkPunct})(\\*{1,3}|_{1,3}|~~)\\s+([\\u4e00-\\u9fa5])`, 'g'), '$1$2$3');
        line = line.replace(new RegExp(`([\\u4e00-\\u9fa5])\\s+(\\*{1,3}|_{1,3}|~~)(${cjkPunct})`, 'g'), '$1$2$3');

        // 9. Slash spacing: 前/后 -> 前 / 后, 中文/English -> 中文 / English, C++/Python -> C++ / Python
        line = line.replace(/([\u4e00-\u9fa5])\/([\u4e00-\u9fa5])/g, '$1 / $2');
        line = line.replace(/([\u4e00-\u9fa5])\/([a-zA-Z0-9])/g, '$1 / $2');
        line = line.replace(/([a-zA-Z0-9])\/([\u4e00-\u9fa5])/g, '$1 / $2');
        line = line.replace(/([a-zA-Z0-9\+])\/([a-zA-Z0-9])/g, '$1 / $2');

        // 10. Remove spaces between Chinese punctuation and English/numbers/tokens (严格严禁有空格)
        // `\s+` would also swallow a trailing two-space hard line break, silently
        // deleting the author's forced newline. Anchor the trailing form so it only
        // collapses space that is followed by more text on the same line.
        line = line.replace(new RegExp(`[^\\S\\n]+(${cjkPunct})`, 'g'), '$1');
        line = line.replace(new RegExp(`(${cjkPunct})[^\\S\\n]+(?=\\S)`, 'g'), '$1');

        // 11. Spacing around styled markdown wrappers (中文*and*标点 -> 中文 *and* 标点)
        line = line.replace(/([\u4e00-\u9fa5])(\*{1,3}|_{1,3}|~~)([a-zA-Z0-9])/g, '$1 $2$3');
        line = line.replace(/([a-zA-Z0-9])(\*{1,3}|_{1,3}|~~)([\u4e00-\u9fa5])/g, '$1$2 $3');

        // 12. Add halfwidth space between CJK and ASCII Latin/Digits.
        // Placeholder tokens are spelled with ASCII letters, so this rule would happily
        // insert a space between a Chinese character and the token itself. Math and
        // code tokens are re-spaced deliberately by rule 13 below, but a currency token
        // must keep the author's original spacing ("花费$5和$10 元"), so skip it here.
        const CURRENCY_TOKEN = /LUOGUTOKENCURRENCY\d+END/;
        line = line.replace(/([\u4e00-\u9fa5\u3040-\u30ff])([a-zA-Z0-9])/g, (m, a, b, off, str) => {
          if (CURRENCY_TOKEN.test(str.slice(off + 1, off + 40))) return m;
          return `${a} ${b}`;
        });
        line = line.replace(/([a-zA-Z0-9])([\u4e00-\u9fa5\u3040-\u30ff])/g, (m, a, b, off, str) => {
          const before = str.slice(Math.max(0, off - 40), off + 1);
          if (/LUOGUTOKENCURRENCY\d+END$/.test(before)) return m;
          return `${a} ${b}`;
        });

        // 13. Spacing around math/code tokens and CJK
        line = line.replace(/([\u4e00-\u9fa5])(LUOGUTOKENINLINEMATH\d+END|LUOGUTOKENCODE\d+END)/g, '$1 $2');
        line = line.replace(/(LUOGUTOKENINLINEMATH\d+END|LUOGUTOKENCODE\d+END)([\u4e00-\u9fa5])/g, '$1 $2');

        // Clean space before/after Chinese punctuation once more after token spacing
        // `\s+` would also swallow a trailing two-space hard line break, silently
        // deleting the author's forced newline. Anchor the trailing form so it only
        // collapses space that is followed by more text on the same line.
        line = line.replace(new RegExp(`[^\\S\\n]+(${cjkPunct})`, 'g'), '$1');
        line = line.replace(new RegExp(`(${cjkPunct})[^\\S\\n]+(?=\\S)`, 'g'), '$1');
        line = line.replace(new RegExp(`(${cjkPunct})(\\*{1,3}|_{1,3}|~~)\\s+([\\u4e00-\\u9fa5])`, 'g'), '$1$2$3');

        // 14. Append sentence-end fullwidth period for plain text Chinese sentences or formulas or English words missing end punctuation (strictly excluding headings, lists, tables, quotes)
        //
        // Only the LAST line of a paragraph ends a sentence. Without this lookahead the
        // fixer turned a paragraph wrapped over three lines into "第一行。第二行。第三行。",
        // inserting periods in the middle of a sentence — and disagreeing with the
        // linter, which (correctly) only flags the final line.
        const nextRaw = i + 1 < lines.length ? lines[i + 1] : '';
        const nextTrim = nextRaw.trim();
        const paragraphContinues = !!nextTrim
          && !/^[`~]{3,}/.test(nextTrim)
          && !/^[|>#]/.test(nextTrim)
          && !/^:{3,}/.test(nextTrim)
          && !/^(\*{3,}|-{3,}|_{3,})$/.test(nextTrim)
          && !/^(=+|-+)$/.test(nextTrim)
          && !/^\s*([*+-]|\d+[.)])\s+/.test(nextRaw)
          && !/^\$\$/.test(nextTrim);

        const trimmedLine = line.trim();
        if (!paragraphContinues && trimmedLine && !/^[#\*\+\-\|:>`\d\.\s]/.test(trimmedLine)) {
          // A standalone block-level element — a display equation ($$...$$), an image/video,
          // or a link on its own line — is not a prose sentence, so never append a sentence
          // period here. These are tokenized into LUOGUTOKEN...END during formatting.
          const endsWithBlockToken = /LUOGUTOKEN(?:MEDIA|LINK|URL|DISPLAYMATH)\d+END$/.test(trimmedLine);
          if (!endsWithBlockToken) {
            if (/[\u4e00-\u9fa5a-zA-Z0-9]$/.test(trimmedLine) || /LUOGUTOKENINLINEMATH\d+END$/.test(trimmedLine)) {
              const endPunct = '[。！？：；……“”‘’（）【】《》、]';
              if (!new RegExp(`${endPunct}$`).test(trimmedLine)) {
                line = line + '。';
              }
            }
          }
        }

        // Clean redundant multiple spaces. The hard break was detached above, so this
        // only ever sees interior runs.
        line = line.replace(/ {2,}/g, ' ');

        // Restore protected tokens (using function callback to prevent $$ replacement in JS)
        for (const token of tokens) {
          while (line.includes(token.id)) {
            line = line.replace(token.id, () => token.val);
          }
        }

        formattedLines.push(line + hardBreak);
      }

      return formattedLines.join('\n');
    }
  }

  // Export
  global.LuoguLinter = LuoguLinter;
  if (typeof window !== 'undefined') {
    window.LuoguLinter = LuoguLinter;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LuoguLinter };
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
