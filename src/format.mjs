// Makes a message safe for the app's markdown: paths and shell commands become inline code, so a `~` in `~/Library/...`
// never pairs with a later `~` and strikes the text through. Code the writer already marked (fenced blocks, `spans`) and
// URLs are left alone; any other `~` is escaped.
const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g;
const COMMAND_LINE = /^(\s*)\$ (.+)$/gm;
const PATH = /(?<![\w`/.:~-])(?:~(?:\/[\w.@+-]+)*\/?(?![\w.@+-])|\.{1,2}\/[\w.@+-]+(?:\/[\w.@+-]+)*\/?|\/[\w.@+-]+(?:\/[\w.@+-]+)*\/?)/g;
const TRAILING = /[.,;:)]+$/;

// The stretches of `text` outside protected code, run through `fn`; protected stretches pass through as they are.
function outside(text, fn) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(PROTECTED)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

const commands = (s) => s.replace(COMMAND_LINE, (_m, indent, command) => `${indent}\`${command.replace(/`/g, "'")}\``);

const paths = (s) => s.replace(PATH, (hit) => {
  const tail = hit.match(TRAILING)?.[0] ?? '';
  const path = tail ? hit.slice(0, -tail.length) : hit;
  return path.length > 1 || path === '~' ? `\`${path}\`${tail}` : hit;
});

const tildes = (s) => s.replace(/(?<!\\)~/g, '\\~');

export const formatForApp = (text) => [commands, paths, tildes].reduce((t, step) => outside(t, step), String(text));
