export interface DiffLine { text: string; kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'; old?: number; next?: number; }
export interface DiffFile { name: string; lines: DiffLine[]; added: number; removed: number; }

function pathName(value: string) {
  return value.replace(/^"|"$/g, '').replace(/(?:\\[0-7]{3})+/g, group => new TextDecoder().decode(Uint8Array.from([...group.matchAll(/\\([0-7]{3})/g)].map(m => parseInt(m[1], 8))))).replace(/\\(["\\])/g, '$1').replace(/^[ab]\//, '');
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined, old = 0, next = 0, inHunk = false;
  for (const textLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (textLine.startsWith('diff --git ')) {
      current = {name: pathName(textLine.match(/ ("b\/.*")$/)?.[1] ?? textLine.replace(/^diff --git .* b\//, '')), lines: [], added: 0, removed: 0};
      files.push(current); inHunk = false; continue;
    }
    if (!current) {
      if (!textLine) continue;
      current = {name: 'Изменения', lines: [], added: 0, removed: 0}; files.push(current);
    }
    if (!inHunk && /^\+\+\+ ("?b\/)/.test(textLine)) current.name = pathName(textLine.slice(4));
    if (!inHunk && /^--- ("?a\/)/.test(textLine)) current.name = pathName(textLine.slice(4));
    const hunk = textLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true; current.lines.push({text: textLine, kind: 'hunk'}); }
    else if (inHunk && textLine.startsWith('+')) { current.added++; current.lines.push({text: textLine, kind: 'add', next: next++}); }
    else if (inHunk && textLine.startsWith('-')) { current.removed++; current.lines.push({text: textLine, kind: 'remove', old: old++}); }
    else if (inHunk && textLine.startsWith(' ')) current.lines.push({text: textLine, kind: 'context', old: old++, next: next++});
    else if (textLine) current.lines.push({text: textLine, kind: 'meta'});
  }
  return files;
}
