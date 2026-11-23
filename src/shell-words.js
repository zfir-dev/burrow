// A small, safe reader for POSIX sh command lines, for checks such as `burrow doctor`. It
// never runs anything: it splits a script into simple commands (at ;, &, &&, ||, | and
// newlines) and each command into words, honouring '…', "…" and backslash escapes, and
// skipping redirections. Constructs it doesn't model ($(…), backticks, subshells, braces,
// here-documents, if/for/while/case) are reported so the caller can leave them unchecked.

const OPERATORS = ['&&', '||', ';;', ';', '&', '|', '\n'];
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', '!']);

// -> [{ words: [{ text, plain, quoted, expands }], unsupported: '<reason>' | null }]
// (plain: the word's unquoted leading part, used to spot NAME=value)
export function parseCommands(script) {
  const src = String(script ?? '');
  const commands = [];
  let words = [];
  let unsupported = null;
  let word = null; // { text, quoted, expands }
  const flush = () => { if (word) { words.push(word); word = null; } };
  const end = () => { flush(); if (words.length || unsupported) commands.push({ words, unsupported }); words = []; unsupported = null; };
  const cur = () => (word ||= { text: '', plain: '', quoted: false, expands: false });
  let i = 0;
  while (i < src.length) {
    const c = src[i];
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
      let j = i + 1; let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { text += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' || src[j] === '`') { cur().expands = true; if (src[j] === '`' || src[j + 1] === '(') unsupported ||= 'command substitution'; }
        text += src[j++];
      }
      if (j >= src.length) { unsupported ||= 'unterminated quote'; i = src.length; continue; }
      cur().text += text; word.quoted = true; i = j + 1; continue;
    }
    if (c === '$') {
      if (src[i + 1] === '(') unsupported ||= 'command substitution';
      cur().expands = true; cur().text += c; if (!word.quoted) word.plain += c; i++; continue;
    }
    if (c === '`') { unsupported ||= 'command substitution'; cur().text += c; i++; continue; }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op && !(op === '&' && /[<>]$/.test(word?.text || ''))) { end(); i += op.length; continue; }
    if (c === '(' || c === ')') { unsupported ||= 'subshell'; flush(); i++; continue; }
    if (c === '<' || c === '>') {
      // A redirection: optional fd digits already in `word`, the operator, then its target.
      if (word && /^\d+$/.test(word.text) && !word.quoted) word = null; else flush();
      if (src.startsWith('<<', i) && src[i + 2] !== '<') unsupported ||= 'here-document';
      while (src[i] === '<' || src[i] === '>' || src[i] === '&' || src[i] === '|') i++;
      while (src[i] === ' ' || src[i] === '\t') i++;
      // skip the target word (simple form)
      if (/^\d|-/.test(src[i] || '') && src[i - 1] === '&') { while (i < src.length && /[\d-]/.test(src[i])) i++; continue; }
      const start = i;
      while (i < src.length && !/[\s;&|<>()]/.test(src[i])) {
        if (src[i] === "'" || src[i] === '"') { const q = src[i]; const j = src.indexOf(q, i + 1); i = j < 0 ? src.length : j + 1; } else i++;
      }
      if (i === start) unsupported ||= 'redirection without a target';
      continue;
    }
    if ((c === '{' || c === '}') && !word && /[\s;]|$/.test(src[i + 1] ?? '')) { unsupported ||= 'command group'; i++; continue; }
    cur().text += c; if (!word.quoted) word.plain += c; i++;
  }
  end();
  for (const cmd of commands) {
    const first = cmd.words.find((w) => !isAssignment(w));
    if (first && !first.quoted && KEYWORDS.has(first.text)) cmd.unsupported ||= `"${first.text}" block`;
  }
  return commands;
}

// NAME=value, where NAME= is unquoted (the value may be quoted: FOO="a b").
export const isAssignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.plain ?? w.text);
