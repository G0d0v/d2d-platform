import {Fragment, useId, type ReactNode} from 'react';

// Markdown is rendered as React elements: repository HTML is always plain text.
function linkTarget(value: string): string | undefined {
  try {
    const url = new URL(value, location.href);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function renderInline(text: string, prefix: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|!?\[[^\]]+\]\([^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^(!?)\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      if(link[3].startsWith('#')) return <a key={i} href={link[3]} onClick={event=>{
        event.preventDefault();
        try { document.getElementById(prefix+decodeURIComponent(link[3].slice(1)))?.scrollIntoView({block:'start'}); }
        catch { /* Invalid anchor is inert. */ }
      }}>{link[2]}</a>;
      // Relative repository links need a repository context; don't send them to the app root.
      const href = /^https?:\/\//i.test(link[3]) ? linkTarget(link[3]) : undefined;
      return href ? <a key={i} href={href} target="_blank" rel="noreferrer">{link[2]}</a> : <Fragment key={i}>{link[2]}</Fragment>;
    }
    return part;
  });
}

export function Markdown({text}: {text: string}) {
  const prefix=useId();
  const inline=(value:string)=>renderInline(value,prefix);
  const lines = text.replace(/\r\n/g, '\n').split('\n'), nodes: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i], key = i;
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3); const body: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      nodes.push(<pre key={key} aria-label={language ? `Код: ${language}` : 'Код'}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      const content = inline(heading[2]);
      const id=prefix+heading[2].toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu,'').trim().replace(/\s+/g,'-');
      nodes.push(heading[1].length === 1 ? <h2 id={id} key={key}>{content}</h2> : heading[1].length === 2 ? <h3 id={id} key={key}>{content}</h3> : <h4 id={id} key={key}>{content}</h4>);
      i++; continue;
    }
    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { nodes.push(<hr key={key}/>); i++; continue; }
    if (/^>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      nodes.push(<blockquote key={key}>{inline(body.join('\n'))}</blockquote>); continue;
    }
    if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+] |\d+\. )/.test(lines[i])) {
        items.push(<li key={i}>{inline(lines[i++].replace(/^\s*([-*+] |\d+\. )/, ''))}</li>);
      }
      nodes.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    if (line.includes('|') && /^\s*\|?\s*:?-+/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|');
      const headers = cells(line), rows: string[][] = []; i += 2;
      while (i < lines.length && lines[i].includes('|')) rows.push(cells(lines[i++]));
      nodes.push(<div className="markdown-table" key={key}><table><thead><tr>{headers.map((v, n) => <th key={n}>{inline(v)}</th>)}</tr></thead><tbody>{rows.map((row, n) => <tr key={n}>{row.map((v, c) => <td key={c}>{inline(v)}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const body = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|>|\s*([-*+] |\d+\. ))/.test(lines[i])) body.push(lines[i++]);
    nodes.push(<p key={key}>{inline(body.join('\n'))}</p>);
  }
  return <div className="markdown-body">{nodes}</div>;
}
