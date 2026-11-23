// A small, safe reader for POSIX sh command lines, for checks such as `burrow doctor`. It
// never runs anything: it splits a script into simple commands (at ;, &, &&, ||, | and
// newlines) and each command into words, honouring '…', "…" and backslash escapes, and
// skipping redirections. Compound commands are read too:
// - $(…) and `…` (also inside "…"): the inner commands are returned before the command
//   that uses them, in their own scope (a cd inside doesn't leak out);
// - ( … ) subshells: their commands, in their own scope; { …; } groups: their commands;
// - if/then/elif/else/fi, while/until/do/done and for … in …; do … done: the reserved words
//   are dropped and the conditions and bodies returned with depth > 0 (they may not run);
// - case … in pattern) …;; esac: each arm's commands, with depth > 0.
// What it doesn't model is reported in `unsupported` so the caller can leave it unchecked:
// function definitions, unterminated quotes or brackets, redirections without a target.
// Here-document bodies are skipped (the command itself is still read).

const OPERATORS = ['&&', '||', ';;', ';', '&', '|', '\n'];
const OPENERS = new Set(['if', 'while', 'until']);
const CLOSERS = new Set(['fi', 'done']);
const PREFIX_WORDS = new Set(['then', 'else', 'elif', 'do', '!']);
const SEP = /[\s;&|<>()]/;

// Index just past the `)` that closes the `(` before `i`, skipping quotes and escapes; -1 if
// it never closes.
function closeParen(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '"') { const j = closeDouble(src, i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '`') { const j = closeBacktick(src, i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
    i++;
  }
  return -1;
}
// Index of the closing " (from just after the opening one), or -1.
function closeDouble(src, i) {
  while (i < src.length && src[i] !== '"') {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '$' && src[i + 1] === '(') { const j = closeParen(src, i + 2); if (j < 0) return -1; i = j; continue; }
    if (src[i] === '`') { const j = closeBacktick(src, i + 1); if (j < 0) return -1; i = j + 1; continue; }
    i++;
  }
  return i < src.length ? i : -1;
}
const closeBacktick = (src, i) => { while (i < src.length && src[i] !== '`') i += src[i] === '\\' ? 2 : 1; return i < src.length ? i : -1; };
const unBacktick = (s) => s.replace(/\\([\\`$])/g, '$1');
const wordAt = (src, i, w) => src.startsWith(w, i) && (i === 0 || /[\s;&|(]/.test(src[i - 1])) && (i + w.length >= src.length || SEP.test(src[i + w.length]));

// Index of the `}` closing a { group whose body starts at i (standalone braces are counted).
function closeBrace(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '"') { const j = closeDouble(src, i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '`') { const j = closeBacktick(src, i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '$' && src[i + 1] === '(') { const j = closeParen(src, i + 2); if (j < 0) return -1; i = j; continue; }
    if (wordAt(src, i, '{')) depth++;
    else if (wordAt(src, i, '}') && --depth === 0) return i;
    i++;
  }
  return -1;
}

// case WORD in [(]pat[|pat]) body ;; … esac, starting just after `case`. -> { arms: [body], end } or null
function readCase(src, i) {
  const m = /^\s+(?:"[^"]*"|'[^']*'|[^\s;&|<>()]+)\s+in(?=[\s;])/.exec(src.slice(i));
  if (!m) return null;
  i += m[0].length;
  const arms = [];
  for (;;) {
    while (i < src.length && /[\s;]/.test(src[i])) i++;
    if (wordAt(src, i, 'esac')) return { arms, end: i + 4 };
    if (i >= src.length) return null;
    if (src[i] === '(') i++;
    const close = closeParen(src, i);
    if (close < 0) return null;
    i = close;
    // The body runs to ;; or esac at this level (nested case … esac is skipped over).
    const start = i;
    let nest = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { const j = src.indexOf("'", i + 1); if (j < 0) return null; i = j + 1; continue; }
      if (c === '"') { const j = closeDouble(src, i + 1); if (j < 0) return null; i = j + 1; continue; }
      if (c === '$' && src[i + 1] === '(') { const j = closeParen(src, i + 2); if (j < 0) return null; i = j; continue; }
      if (wordAt(src, i, 'case')) nest++;
      if (wordAt(src, i, 'esac')) { if (nest === 0) break; nest--; }
      if (nest === 0 && src.startsWith(';;', i)) break;
      i++;
    }
    arms.push(src.slice(start, i));
    if (src.startsWith(';;', i)) i += 2;
  }
}

// -> [{ words: [{ text, plain, quoted, expands }], unsupported: '<reason>' | null, depth, scope }]
// (plain: the word's unquoted leading part, used to spot NAME=value; depth: how many
// if/while/for/case bodies it is inside; scope: '' at the top, another string inside each
// subshell or command substitution; branchStart: the first command of a then/elif/else/do
// body or case arm, which starts from the directory the block was entered in)
export function parseCommands(script, ctx = { scope: '', depth: 0, ids: { n: 0 } }) {
  const src = String(script ?? '');
  const commands = [];
  let depth = ctx.depth;
  let words = [];
  let unsupported = null;
  let before = []; // commands of $(…) in this command, which run first
  let word = null; // { text, plain, quoted, expands }
  let heredocs = []; // delimiters waiting for the next newline
  let pendingBranch = false; // `then` / `do` / `else` alone: the next command starts the branch
  const nested = (text, extra = {}) => parseCommands(text, { ...ctx, depth, ...extra });
  const isolated = (text) => nested(text, { scope: `${ctx.scope}/${++ctx.ids.n}` });
  const flush = () => { if (word) { words.push(word); word = null; } };
  const end = () => {
    flush();
    commands.push(...before); before = [];
    // Reserved words: drop then/do/else/…, and track how deep in blocks we are.
    let opened = false;
    let branch = false;
    while (words.length && !words[0].quoted) {
      const t = words[0].text;
      if (PREFIX_WORDS.has(t)) { words.shift(); if (t !== '!') branch = true; continue; }
      if (OPENERS.has(t)) { words.shift(); if (!opened) { depth++; opened = true; } continue; }
      break;
    }
    const head = words[0] && !words[0].quoted ? words[0].text : '';
    if (CLOSERS.has(head)) { words.shift(); depth = Math.max(ctx.depth, depth - 1); }
    else if (head === 'for' || head === 'select') { words = []; depth++; } // the loop header: for NAME [in WORDS]
    if (words.length || unsupported) commands.push({ words, unsupported, depth, scope: ctx.scope, ...(branch || pendingBranch ? { branchStart: true } : {}) });
    if (words.length || unsupported) pendingBranch = false; else if (branch) pendingBranch = true;
    words = []; unsupported = null;
  };
  const cur = () => (word ||= { text: '', plain: '', quoted: false, expands: false });
  // At the start of a command, possibly after then/do/else/if/while/…
  const atStart = () => !word && words.every((w) => !w.quoted && (PREFIX_WORDS.has(w.text) || OPENERS.has(w.text)));
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n' && heredocs.length) {
      end(); i++;
      // Skip each here-document body up to its delimiter line.
      for (const { delim, strip } of heredocs) {
        while (i < src.length) {
          let nl = src.indexOf('\n', i); if (nl < 0) nl = src.length;
          const line = src.slice(i, nl); i = nl + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (c === '#' && !word) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t') { flush(); i++; continue; }
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      cur().text += src[i + 1] ?? ''; word.quoted = true; i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) { unsupported ||= 'unterminated quote'; i = src.length; continue; }
      cur().text += src.slice(i + 1, j); word.quoted = true; i = j + 1; continue;
    }
    if (c === '"') {
      const close = closeDouble(src, i + 1);
      if (close < 0) { unsupported ||= 'unterminated quote'; i = src.length; continue; }
      let j = i + 1; let text = '';
      while (j < close) {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { text += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(' && src[j + 2] !== '(') {
          const k = closeParen(src, j + 2);
          before.push(...isolated(src.slice(j + 2, k - 1))); cur().expands = true; text += src.slice(j, k); j = k; continue;
        }
        if (src[j] === '`') {
          const k = closeBacktick(src, j + 1);
          before.push(...isolated(unBacktick(src.slice(j + 1, k)))); cur().expands = true; text += src.slice(j, k + 1); j = k + 1; continue;
        }
        if (src[j] === '$') cur().expands = true;
        text += src[j++];
      }
      cur().text += text; word.quoted = true; i = close + 1; continue;
    }
    if (c === '$') {
      if (src[i + 1] === '(') {
        const arith = src[i + 2] === '(';
        const k = closeParen(src, i + 2);
        if (k < 0) { unsupported ||= 'unterminated $('; i = src.length; continue; }
        if (!arith) before.push(...isolated(src.slice(i + 2, k - 1)));
        cur().expands = true; word.text += src.slice(i, k); if (!word.quoted) word.plain += src.slice(i, k); i = k; continue;
      }
      cur().expands = true; cur().text += c; if (!word.quoted) word.plain += c; i++; continue;
    }
    if (c === '`') {
      const k = closeBacktick(src, i + 1);
      if (k < 0) { unsupported ||= 'unterminated `'; i = src.length; continue; }
      before.push(...isolated(unBacktick(src.slice(i + 1, k))));
      cur().expands = true; word.text += src.slice(i, k + 1); i = k + 1; continue;
    }
    if (atStart() && wordAt(src, i, 'case')) {
      const r = readCase(src, i + 4);
      if (!r) { unsupported ||= 'case block it could not read'; i = src.length; continue; }
      for (const arm of r.arms) {
        const cmds = nested(arm, { depth: depth + 1 });
        if (cmds[0]) cmds[0].branchStart = true; // arms are alternatives
        commands.push(...cmds);
      }
      i = r.end; continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op && !(op === '&' && /[<>]$/.test(word?.text || ''))) { end(); i += op.length; continue; }
    if (c === '(') {
      if (atStart()) {
        const k = closeParen(src, i + 1);
        if (k < 0) { unsupported ||= 'unterminated ('; i = src.length; continue; }
        commands.push(...isolated(src.slice(i + 1, k - 1)));
        i = k; continue;
      }
      // NAME() { …; }: a function definition; its body isn't checked.
      unsupported ||= /^\s*\)/.test(src.slice(i + 1)) ? 'function definition' : 'unexpected (';
      end(); i = src.length; continue;
    }
    if (c === ')') { unsupported ||= 'unexpected )'; i++; continue; }
    if (c === '<' || c === '>') {
      // A redirection: optional fd digits already in `word`, the operator, then its target.
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null; else flush();
      const heredoc = src.startsWith('<<', i) && src[i + 2] !== '<';
      const strip = heredoc && src[i + 2] === '-';
      while (src[i] === '<' || src[i] === '>' || src[i] === '&' || src[i] === '|' || (heredoc && src[i] === '-')) i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      // skip the target word (simple form)
      if (/^\d|-/.test(src[i] || '') && src[i - 1] === '&') { while (i < src.length && /[\d-]/.test(src[i])) i++; continue; }
      const start = i;
      while (i < src.length && !SEP.test(src[i])) {
        if (src[i] === "'" || src[i] === '"') { const q = src[i]; const j = src.indexOf(q, i + 1); i = j < 0 ? src.length : j + 1; } else i++;
      }
      if (i === start) unsupported ||= 'redirection without a target';
      else if (heredoc) heredocs.push({ delim: src.slice(start, i).replace(/['"\\]/g, ''), strip });
      continue;
    }
    if (c === '{' && atStart() && /[\s;]|$/.test(src[i + 1] ?? '')) {
      const k = closeBrace(src, i + 1);
      if (k < 0) { unsupported ||= 'unterminated {'; i = src.length; continue; }
      commands.push(...nested(src.slice(i + 1, k)));
      i = k + 1; continue;
    }
    cur().text += c; if (!word.quoted) word.plain += c; i++;
  }
  end();
  return commands;
}

// NAME=value, where NAME= is unquoted (the value may be quoted: FOO="a b").
export const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.plain ?? w.text);
