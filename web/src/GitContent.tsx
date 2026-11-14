import {useEffect, useMemo, useState} from 'react';
import {BookOpen, Check, Copy, Download, FileCode2, Search} from 'lucide-react';
import {ErrorBox} from './components.tsx';
import {Markdown} from './Markdown.tsx';
import {parseDiff} from './git-diff.ts';

function useGitText(url: string) {
  const [state, setState] = useState({code: '', loading: true, binary: false, error: null as Error | null});
  useEffect(() => {
    const controller = new AbortController();
    setState({code: '', loading: true, binary: false, error: null});
    void fetch(url, {signal: controller.signal, credentials: 'same-origin'}).then(async response => {
      if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message ?? 'Не удалось прочитать файл'); }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!controller.signal.aborted) setState({code: new TextDecoder().decode(bytes), binary: bytes.slice(0, 8192).includes(0), loading: false, error: null});
    }).catch(error => { if (!controller.signal.aborted) setState({code: '', binary: false, loading: false, error}); });
    return () => controller.abort();
  }, [url]);
  return state;
}

export function GitText({url, title, readme = false}: {url: string; title: string; readme?: boolean}) {
  const {code, loading, binary, error} = useGitText(url);
  const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState<Error | null>(null);
  useEffect(() => { setCopied(false); setCopyError(null); }, [url]);
  return <section className={`git-file-panel ${readme ? 'readme-panel' : ''}`}>
    <div className="source-code-heading"><span>{readme ? <BookOpen size={16}/> : <FileCode2 size={16}/>}<strong>{title}</strong>{!readme && !loading && !binary && <small>{code.split('\n').length} строк</small>}</span><div className="heading-actions">
      {!readme && <button className="icon-button" disabled={loading || binary || !!error} aria-label="Копировать код" onClick={async () => { try { await navigator.clipboard.writeText(code); setCopied(true); setCopyError(null); } catch { setCopyError(new Error('Не удалось скопировать. Выделите код и скопируйте вручную.')); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button>}
      <a href={url} className="button small" target="_blank" rel="noreferrer"><Download size={14}/>Исходный файл</a></div></div>
    <ErrorBox error={error || copyError}/>{loading ? <p className="panel-note muted" role="status">Загрузка файла…</p> : !error && (binary ? <p className="panel-note muted">Двоичный файл. Откройте исходный файл, чтобы скачать его.</p> : readme ? <Markdown text={code}/> : <pre className="code-lines">{code.split('\n').map((line, i) => <div className="code-line" key={i}><span className="line-number" aria-hidden="true">{i + 1}</span><code>{line || ' '}</code></div>)}</pre>)}
  </section>;
}

export function GitDiff({url}: {url: string}) {
  const {code, loading, error} = useGitText(url), files = useMemo(() => parseDiff(code), [code]);
  const [filter, setFilter] = useState('');
  const visible = files.map((file, index) => ({file, index})).filter(({file}) => file.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className="diff-view"><ErrorBox error={error}/>{loading ? <p className="panel-note muted" role="status">Загрузка изменений…</p> : !error && <>
    <div className="diff-summary"><strong>Изменено файлов: {files.length}</strong><span><b className="diff-added">+{files.reduce((n, f) => n + f.added, 0)}</b> <b className="diff-removed">−{files.reduce((n, f) => n + f.removed, 0)}</b></span><a className="button small" href={url} target="_blank" rel="noreferrer">Исходный diff</a></div>
    <div className="diff-layout"><aside className="diff-index"><label className="repo-search"><Search size={15}/><input aria-label="Фильтр изменённых файлов" placeholder="Найти файл…" value={filter} onChange={e => setFilter(e.target.value)}/></label><nav aria-label="Изменённые файлы">{visible.map(({file, index}) => <a key={index} href={`#diff-file-${index}`} onClick={e => { e.preventDefault(); document.getElementById(`diff-file-${index}`)?.scrollIntoView({block: 'start'}); }}><FileCode2 size={15}/>{file.name}</a>)}</nav></aside>
      <div className="diff-files">{visible.length ? visible.map(({file, index}) => <section className="diff-file" id={`diff-file-${index}`} key={index}><header><FileCode2 size={16}/><strong>{file.name}</strong><span><b className="diff-added">+{file.added}</b> <b className="diff-removed">−{file.removed}</b></span></header><pre>{file.lines.map((line, i) => <div className={`diff-line ${line.kind}`} key={i}><span className="diff-number" aria-hidden="true">{line.old}</span><span className="diff-number" aria-hidden="true">{line.next}</span><code>{line.text || ' '}</code></div>)}</pre></section>) : <p className="panel-note muted">{files.length ? 'Файлы не найдены.' : 'Текстовых изменений нет.'}</p>}</div>
    </div></>}
  </div>;
}
