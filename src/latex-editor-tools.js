/*
 * Lightweight, offline LaTeX helpers for the textarea editor.
 *
 * The editor keeps Markdown as plain source, so these helpers deliberately work on
 * source offsets rather than rendered KaTeX DOM. TeX commands and delimiter semantics
 * are math-aware; ordinary bracket pairing also works in prose, while code is ignored.
 */
(function (root) {
  'use strict';

  const ENVIRONMENTS = [
    'aligned', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix',
    'smallmatrix', 'gathered', 'array', 'split', 'align', 'alignat', 'gather',
  ];

  const COMMANDS = [
    ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'],
    ['epsilon', 'ε'], ['theta', 'θ'], ['lambda', 'λ'], ['mu', 'μ'],
    ['pi', 'π'], ['sigma', 'σ'], ['phi', 'φ'], ['omega', 'ω'],
    ['approx', '≈'], ['cdot', '·'], ['times', '×'], ['pm', '±'],
    ['leq', '≤'], ['geq', '≥'], ['neq', '≠'], ['infty', '∞'],
    ['partial', '∂'], ['nabla', '∇'], ['rightarrow', '→'], ['in', '∈'],
    ['frac', '□/□', '\\frac{}{}', 6],
    ['sqrt', '√□', '\\sqrt{}', 6],
    ['text', 'text', '\\text{}', 6],
    ['sum', '∑', '\\sum_{i=1}^{n}', 14],
    ['int', '∫', '\\int_{a}^{b}', 12],
    ['left', '( )', '\\left(\\right)', 6],
  ].map(([name, preview, insert, caretOffset]) => ({
    name,
    display: `\\${name}`,
    preview,
    insert: insert || `\\${name}`,
    caretOffset: caretOffset === undefined ? (insert || `\\${name}`).length : caretOffset,
  }));

  const MACRO_DELIMITERS = [
    ['\\langle', 'angle', 'open'], ['\\rangle', 'angle', 'close'],
    ['\\lbrace', 'brace', 'open'], ['\\rbrace', 'brace', 'close'],
    ['\\lvert', 'bar', 'open'], ['\\rvert', 'bar', 'close'],
    ['\\lVert', 'doublebar', 'open'], ['\\rVert', 'doublebar', 'close'],
  ];
  let cachedMathText = null;
  let cachedMathRanges = null;

  function clampPosition(text, position) {
    return Math.max(0, Math.min(text.length, Number.isFinite(position) ? position : text.length));
  }

  function isEscaped(text, index) {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
    return slashes % 2 === 1;
  }

  function rangeAt(ranges, position) {
    // Ranges are few and sorted; binary search keeps the hot keydown path cheap even
    // for a document with many code fences.
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const range = ranges[mid];
      if (position < range.start) hi = mid - 1;
      else if (position >= range.end) lo = mid + 1;
      else return range;
    }
    return null;
  }

  function getCodeRanges(text) {
    const ranges = [];
    const fenced = [];
    let fence = null;
    let lineStart = 0;

    while (lineStart <= text.length) {
      const newline = text.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? text.length : newline;
      const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);

      if (!fence && marker) {
        fence = { start: lineStart, char: marker[1][0], length: marker[1].length };
      } else if (fence && marker && marker[1][0] === fence.char && marker[1].length >= fence.length) {
        const end = newline === -1 ? text.length : newline + 1;
        fenced.push({ start: fence.start, end });
        fence = null;
      } else if (!fence && /^(?: {4}|\\t)/.test(line)) {
        // CommonMark indented code blocks (four spaces or a tab) are source too,
        // but they are not a place to insert TeX pairs or show command suggestions.
        fenced.push({ start: lineStart, end: newline === -1 ? text.length : newline + 1 });
      }

      if (newline === -1) break;
      lineStart = newline + 1;
    }
    if (fence) fenced.push({ start: fence.start, end: text.length });

    // Markdown code spans use matching runs of backticks. They may cross a newline,
    // but only an equal-length, unescaped run closes the span.
    let i = 0;
    while (i < text.length) {
      const blocked = rangeAt(fenced, i);
      if (blocked) { i = blocked.end; continue; }
      if (text[i] !== '`' || isEscaped(text, i)) { i++; continue; }

      let runEnd = i + 1;
      while (text[runEnd] === '`') runEnd++;
      const runLength = runEnd - i;
      let j = runEnd;
      let closingEnd = -1;
      while (j < text.length) {
        const codeFence = rangeAt(fenced, j);
        if (codeFence) { j = codeFence.end; continue; }
        if (text[j] !== '`' || isEscaped(text, j)) { j++; continue; }
        let candidateEnd = j + 1;
        while (text[candidateEnd] === '`') candidateEnd++;
        if (candidateEnd - j === runLength) {
          closingEnd = candidateEnd;
          break;
        }
        j = candidateEnd;
      }
      if (closingEnd !== -1) {
        ranges.push({ start: i, end: closingEnd });
        i = closingEnd;
      } else {
        i = runEnd;
      }
    }

    ranges.push(...fenced);
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    return ranges;
  }

  function lineStartAt(text, position) {
    return text.lastIndexOf('\n', Math.max(-1, position - 1)) + 1;
  }

  function lineEndAt(text, position) {
    const end = text.indexOf('\n', position);
    return end === -1 ? text.length : end;
  }

  function firstBlankLineEnd(text, start, limit) {
    let lineStart = lineStartAt(text, start);
    while (lineStart < limit) {
      const end = lineEndAt(text, lineStart);
      if (/^[ \t]*$/.test(text.slice(lineStart, end))) return lineStart;
      if (end >= limit) break;
      lineStart = end + 1;
    }
    return limit;
  }

  function nextUnescapedDollarRun(text, from, limit, codeRanges, wantedLength, sameLine) {
    for (let i = from; i < limit; i++) {
      const code = rangeAt(codeRanges, i);
      if (code) { i = code.end - 1; continue; }
      if (text[i] !== '$' || isEscaped(text, i)) continue;
      let end = i + 1;
      while (text[end] === '$') end++;
      if (sameLine && text.slice(i, end).includes('\n')) continue;
      if (end - i === wantedLength) return { start: i, end };
      i = end - 1;
    }
    return null;
  }

  function getMathRanges(text) {
    if (text === cachedMathText && cachedMathRanges) return cachedMathRanges;
    const codeRanges = getCodeRanges(text);
    const mathRanges = [];
    let i = 0;

    while (i < text.length) {
      const code = rangeAt(codeRanges, i);
      if (code) { i = code.end; continue; }
      if (text[i] !== '$' || isEscaped(text, i)) { i++; continue; }

      let dollarEnd = i + 1;
      while (text[dollarEnd] === '$') dollarEnd++;
      const width = dollarEnd - i;

      if (width >= 2) {
        const startOfLine = lineStartAt(text, i);
        const leading = text.slice(startOfLine, i);
        const isBlockFence = /^ {0,3}$/.test(leading);
        const endOfLine = lineEndAt(text, dollarEnd);
        const sameLineClose = nextUnescapedDollarRun(
          text, dollarEnd, endOfLine, codeRanges, 2, true,
        );

        if (sameLineClose) {
          mathRanges.push({ start: dollarEnd, end: sameLineClose.start });
          i = sameLineClose.end;
          continue;
        }

        if (isBlockFence) {
          let closeLineStart = -1;
          let scan = endOfLine < text.length ? endOfLine + 1 : endOfLine;
          while (scan < text.length) {
            const blocked = rangeAt(codeRanges, scan);
            if (blocked) { scan = blocked.end; continue; }
            const scanEnd = lineEndAt(text, scan);
            if (/^ {0,3}\$\$[ \t]*$/.test(text.slice(scan, scanEnd))) {
              closeLineStart = scan;
              break;
            }
            if (scanEnd >= text.length) break;
            scan = scanEnd + 1;
          }
          // The source renderer treats this as a line-based display-math fence. Keep
          // same-line content usable too, which is helpful while an opening fence is
          // still being typed, without changing the Markdown parser's output.
          const contentStart = dollarEnd;
          const contentEnd = closeLineStart === -1 ? text.length : closeLineStart;
          mathRanges.push({ start: contentStart, end: contentEnd });
          i = closeLineStart === -1 ? text.length : lineEndAt(text, closeLineStart) + 1;
          continue;
        }

        // A non-fence `$$` is only math when it has a same-line closer. Otherwise it
        // stays literal Markdown text.
        i = dollarEnd;
        continue;
      }

      const blankEnd = firstBlankLineEnd(text, dollarEnd, text.length);
      const close = nextUnescapedDollarRun(text, dollarEnd, blankEnd, codeRanges, 1, false);
      if (close) {
        mathRanges.push({ start: dollarEnd, end: close.start });
        i = close.end;
      } else {
        // An unfinished `$...` remains an editing region up to the next blank line;
        // this lets pairing and completions work before the author types the closer.
        mathRanges.push({ start: dollarEnd, end: blankEnd });
        i = Math.max(dollarEnd, blankEnd);
      }
    }

    mathRanges.sort((a, b) => a.start - b.start || a.end - b.end);
    cachedMathText = text;
    cachedMathRanges = { mathRanges, codeRanges };
    return cachedMathRanges;
  }

  function isInCode(text, position) {
    const pos = clampPosition(text, position);
    return !!rangeAt(getCodeRanges(text), pos);
  }

  function getMathRangeAt(text, position) {
    const pos = clampPosition(text, position);
    const { mathRanges, codeRanges } = getMathRanges(text);
    if (rangeAt(codeRanges, pos)) return null;
    return mathRanges.find((range) => pos >= range.start && pos <= range.end) || null;
  }

  function isInLatexComment(text, position) {
    const start = lineStartAt(text, position);
    for (let i = start; i < position; i++) {
      if (text[i] === '%' && !isEscaped(text, i)) return true;
    }
    return false;
  }

  function getCompletionContext(text, position) {
    const caret = clampPosition(text, position);
    if (isInLatexComment(text, caret) || !getMathRangeAt(text, caret)) return null;
    const before = text.slice(0, caret);

    const environment = before.match(/\\begin\{([A-Za-z0-9*]*)$/);
    if (environment) {
      const commandStart = caret - environment[0].length;
      if (isEscaped(text, commandStart)) return null;
      return {
        type: 'environment',
        start: caret - environment[1].length,
        end: caret,
        prefix: environment[1],
      };
    }

    const beginCommand = before.match(/\\begin$/);
    if (beginCommand) {
      const commandStart = caret - beginCommand[0].length;
      if (!isEscaped(text, commandStart)) {
        return { type: 'begin-command', start: commandStart, end: caret, prefix: 'begin' };
      }
    }

    const command = before.match(/\\([A-Za-z]+)$/);
    if (!command || command[1].length === 0) return null;
    const commandStart = caret - command[0].length;
    if (isEscaped(text, commandStart)) return null;
    return {
      type: 'command',
      start: commandStart,
      end: caret,
      prefix: command[1],
    };
  }

  function getLatexSuggestions(context) {
    if (!context) return [];
    const limit = 8;

    if (context.type === 'environment' || context.type === 'begin-command') {
      const prefix = context.type === 'environment' ? context.prefix : '';
      return ENVIRONMENTS
        .filter((name) => name.startsWith(prefix) && name !== prefix)
        .slice(0, limit)
        .map((name) => {
          const open = `\\begin{${name}}`;
          const insert = context.type === 'begin-command'
            ? `${open}\n\n\\end{${name}}`
            : `${name}}\n\n\\end{${name}}`;
          const caretOffset = context.type === 'begin-command'
            ? insert.indexOf('\n') + 1
            : name.length + 2;
          return {
            name,
            display: open,
            preview: `\\end{${name}}`,
            insert,
            caretOffset,
          };
        });
    }

    if (context.type !== 'command') return [];
    const prefix = context.prefix;
    return COMMANDS
      .filter((item) => item.name.startsWith(prefix) && item.name !== prefix)
      .slice(0, limit);
  }

  function getEnvironmentAtCloseBrace(text, position) {
    const caret = clampPosition(text, position);
    if (isInLatexComment(text, caret) || !getMathRangeAt(text, caret)) return null;
    const before = text.slice(0, caret);
    const match = before.match(/\\begin\{([A-Za-z][A-Za-z0-9*]*)$/);
    if (!match) return null;
    const commandStart = caret - match[0].length;
    if (isEscaped(text, commandStart)) return null;
    return { name: match[1], start: commandStart, end: caret };
  }

  function isCommentedAt(text, position) {
    return isInLatexComment(text, position);
  }

  function hasMatchingEnvironmentEnd(text, environment, fromPosition) {
    const start = clampPosition(text, fromPosition);
    const mathRange = getMathRangeAt(text, start);
    if (!mathRange) return false;
    // Do not let an unrelated `\\end{...}` in prose or a later formula suppress
    // completion for the current math expression.
    const limit = mathRange.end;
    // Environment names are restricted to TeX's usual letters/digits plus `*`; the
    // star is the only character here that needs escaping for the regular expression.
    const escapedName = String(environment).replace(/\*/g, '\\*');
    const re = new RegExp('\\\\(begin|end)\\s*\\{\\s*' + escapedName + '\\s*\\}', 'g');
    const codeRanges = getCodeRanges(text);
    let depth = 1;
    re.lastIndex = start;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index >= limit) break;
      if (rangeAt(codeRanges, match.index) || isEscaped(text, match.index)
          || isInLatexComment(text, match.index)) continue;
      if (match[1] === 'begin') depth++;
      else if (--depth === 0) return true;
    }
    return false;
  }

  function findLatexDelimiter(text, position, bound) {
    const limit = Math.min(text.length, bound);
    let cursor = position;
    while (cursor < limit && /\s/.test(text[cursor])) cursor++;
    if (cursor >= limit) return null;

    if (text[cursor] === '\\') {
      if (/[{}|]/.test(text[cursor + 1] || '')) {
        return { start: cursor, end: cursor + 2, value: text.slice(cursor, cursor + 2) };
      }
      const command = text.slice(cursor, limit).match(/^\\[A-Za-z]+/);
      if (command) {
        return { start: cursor, end: cursor + command[0].length, value: command[0] };
      }
      return null;
    }

    if ('()[]|./<>'.includes(text[cursor])) {
      return { start: cursor, end: cursor + 1, value: text[cursor] };
    }
    return null;
  }

  function startsCommand(text, position, name, bound) {
    if (!text.startsWith(`\\${name}`, position)) return false;
    const end = position + name.length + 1;
    return end <= bound && !/[A-Za-z]/.test(text[end] || '');
  }

  function findMatchingDelimiter(text, position) {
    const caret = clampPosition(text, position);
    const { mathRanges, codeRanges } = getMathRanges(text);
    if (rangeAt(codeRanges, caret)) return null;
    const mathRange = mathRanges.find((range) => caret >= range.start && caret <= range.end);
    let scanRange = mathRange;
    if (!scanRange) {
      // In ordinary Markdown, match brackets only within the surrounding prose
      // segment; never reach through a formula or code span into unrelated text.
      let start = 0;
      let end = text.length;
      for (const range of [...mathRanges, ...codeRanges]) {
        if (caret >= range.start && caret < range.end) return null;
        if (range.end <= caret) start = Math.max(start, range.end);
        else if (range.start > caret) end = Math.min(end, range.start);
      }
      scanRange = { start, end };
    }

    const comments = [];
    if (mathRange) {
      let line = lineStartAt(text, mathRange.start);
      while (line <= mathRange.end) {
        const end = lineEndAt(text, line);
        for (let i = Math.max(line, mathRange.start); i < Math.min(end, mathRange.end); i++) {
          if (text[i] === '%' && !isEscaped(text, i)) {
            comments.push({ start: i, end: Math.min(end, mathRange.end) });
            break;
          }
        }
        if (end >= mathRange.end) break;
        line = end + 1;
      }
    }

    const pairs = [];
    const ordinaryStack = [];
    const verticalBars = [];
    const latexLeft = [];
    let i = scanRange.start;

    const addPair = (open, close, kind) => {
      if (!open || !close) return;
      pairs.push({ open, close, kind });
    };

    while (i < scanRange.end) {
      const code = rangeAt(codeRanges, i);
      if (code) { i = code.end; continue; }
      const comment = rangeAt(comments, i);
      if (comment) { i = comment.end; continue; }

      if (mathRange && startsCommand(text, i, 'left', scanRange.end)) {
        const commandEnd = i + '\\left'.length;
        const delimiter = findLatexDelimiter(text, commandEnd, scanRange.end);
        if (delimiter) {
          latexLeft.push({ ...delimiter, commandStart: i, commandEnd });
          i = delimiter.end;
          continue;
        }
      }
      if (mathRange && startsCommand(text, i, 'right', scanRange.end)) {
        const commandEnd = i + '\\right'.length;
        const delimiter = findLatexDelimiter(text, commandEnd, scanRange.end);
        if (delimiter) {
          const open = latexLeft.pop();
          if (open) addPair(open, delimiter, 'latex-left-right');
          i = delimiter.end;
          continue;
        }
      }

      // TeX's named angle/brace delimiters also have an unambiguous opener and closer.
      let handledMacro = false;
      if (mathRange) {
        for (const [macro, kind, side] of MACRO_DELIMITERS) {
          if (!text.startsWith(macro, i) || /[A-Za-z]/.test(text[i + macro.length] || '')) continue;
          const token = { start: i, end: i + macro.length, value: macro };
          if (side === 'open') {
            ordinaryStack.push({ ...token, kind });
          } else {
            const top = ordinaryStack[ordinaryStack.length - 1];
            if (top && top.kind === kind) addPair(ordinaryStack.pop(), token, kind);
          }
          i = token.end;
          handledMacro = true;
          break;
        }
      }
      if (handledMacro) continue;

      // Escaped curly braces are still TeX delimiters (for example, \\{x\\}).
      if (mathRange && text[i] === '\\' && (text[i + 1] === '{' || text[i + 1] === '}') && !isEscaped(text, i)) {
        const open = text[i + 1] === '{';
        const token = { start: i, end: i + 2, value: text.slice(i, i + 2) };
        if (open) ordinaryStack.push({ ...token, kind: 'brace' });
        else {
          const top = ordinaryStack[ordinaryStack.length - 1];
          if (top && top.kind === 'brace') addPair(ordinaryStack.pop(), token, 'brace');
        }
        i += 2;
        continue;
      }

      const ch = text[i];
      const openKinds = { '(': 'paren', '[': 'square', '{': 'brace' };
      const closeKinds = { ')': 'paren', ']': 'square', '}': 'brace' };
      if (openKinds[ch] && !isEscaped(text, i)) {
        ordinaryStack.push({ start: i, end: i + 1, value: ch, kind: openKinds[ch] });
      } else if (closeKinds[ch] && !isEscaped(text, i)) {
        const top = ordinaryStack[ordinaryStack.length - 1];
        if (top && top.kind === closeKinds[ch]) {
          addPair(ordinaryStack.pop(), { start: i, end: i + 1, value: ch }, closeKinds[ch]);
        }
      } else if (mathRange && ch === '|' && !isEscaped(text, i)) {
        const token = { start: i, end: i + 1, value: ch, kind: 'bar' };
        if (verticalBars.length) addPair(verticalBars.pop(), token, 'bar');
        else verticalBars.push(token);
      }
      i++;
    }

    const touches = (range) => caret >= range.start && caret <= range.end;
    const candidates = pairs.filter((pair) => touches(pair.open) || touches(pair.close));
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const spanA = a.close.end - a.open.start;
      const spanB = b.close.end - b.open.start;
      return spanA - spanB;
    });
    const match = candidates[0];
    return {
      open: { start: match.open.start, end: match.open.end },
      close: { start: match.close.start, end: match.close.end },
      kind: match.kind,
    };
  }

  const api = {
    ENVIRONMENTS,
    COMMANDS,
    isEscaped,
    getCodeRanges,
    getMathRanges,
    isInCode,
    getMathRangeAt,
    getCompletionContext,
    getLatexSuggestions,
    getEnvironmentAtCloseBrace,
    hasMatchingEnvironmentEnd,
    isCommentedAt,
    findMatchingDelimiter,
  };

  root.LuoguLatexEditorTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
