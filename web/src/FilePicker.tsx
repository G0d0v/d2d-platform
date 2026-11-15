import { useRef, useState } from 'react';
import { Upload, FolderUp, FileArchive, File, X, Search } from 'lucide-react';
import { ErrorBox } from './components.tsx';
import { droppedFiles, emptySelection, fileSize, mergeUploadFiles, type UploadFile, type UploadSelection } from './upload-selection.ts';

export function FilePicker({ value, onChange, disabled = false, single = false, onReading }: {
  value: UploadSelection; onChange: (value: UploadSelection) => void; disabled?: boolean; single?: boolean; onReading?: (reading: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null), zip = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false), [reading, setReading] = useState(false), [error, setError] = useState<Error | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]), [query, setQuery] = useState('');
  const blocked = disabled || reading;
  function add(files: UploadFile[]) {
    try {
      if (single && files.length !== 1) throw new Error('Для замены выберите один файл.');
      const result = mergeUploadFiles(single ? [] : value.files, files);
      setSkipped(result.skipped); setError(null);
      if (result.files.length) onChange({ files: result.files });
    } catch (e) { setError(e as Error); }
  }
  function pick(kind: 'files' | 'folder' | 'zip') {
    const control = { files: input, folder, zip }[kind].current;
    if (control) { control.value = ''; control.click(); }
  }
  const listed = value.zip ? [{ file: value.zip, path: value.zip.name }] : value.files;
  const filtered = listed.filter(item => item.path.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="file-picker" data-dirty={listed.length ? 'true' : undefined}>
    <div className={`file-dropzone ${dragging ? 'is-dragging' : ''}`} aria-busy={reading}
      onDragOver={event => { if (!blocked && event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={async event => {
        event.preventDefault(); setDragging(false); if (blocked) return;
        setReading(true); onReading?.(true); setError(null);
        try { add(await droppedFiles(event.dataTransfer)); } catch (e) { setError(e as Error); } finally { setReading(false); onReading?.(false); }
      }}>
      <Upload size={24} strokeWidth={1.5}/>
      <strong>{reading ? 'Читаем содержимое папки…' : single ? 'Перетащите новый файл сюда' : 'Перетащите файлы или папку сюда'}</strong>
      <p>{single ? 'Новый файл заменит выбранный файл проекта' : 'Папки и вложенные файлы сохранят свою структуру'}</p>
      <div className="file-picker-actions">
        <button className="button" type="button" disabled={blocked} onClick={() => pick('files')}><File size={16}/>{single ? 'Выбрать файл' : 'Выбрать файлы'}</button>
        {!single && <><button className="button" type="button" disabled={blocked} onClick={() => pick('folder')}><FolderUp size={16}/>Выбрать папку</button><button className="text-button" type="button" disabled={blocked} onClick={() => pick('zip')}><FileArchive size={16}/>Загрузить ZIP</button></>}
      </div>
    </div>
    <input hidden ref={input} type="file" multiple={!single} aria-label="Выбрать файлы для загрузки" onChange={event => add(Array.from(event.target.files ?? []).map(file => ({ file, path: file.name })))}/>
    <input hidden ref={folder} type="file" multiple {...{ webkitdirectory: '', directory: '' }} aria-label="Выбрать папку для загрузки" onChange={event => add(Array.from(event.target.files ?? []).map(file => ({ file, path: file.webkitRelativePath || file.name })))}/>
    <input hidden ref={zip} type="file" accept=".zip,application/zip" aria-label="Выбрать ZIP для распаковки" onChange={event => { const file = event.target.files?.[0]; if (file) { onChange({ files: [], zip: file }); setError(null); setSkipped([]); } }}/>
    {listed.length > 0 && <section className="upload-queue" aria-label="Выбранные файлы">
      <div className="upload-queue-heading"><span role="status">{value.zip ? 'ZIP будет распакован' : `Выбрано файлов: ${listed.length}`} <span className="muted">· {fileSize(listed.reduce((size, item) => size + item.file.size, 0))}</span></span><button type="button" className="text-button" disabled={blocked} onClick={() => { onChange(emptySelection()); setQuery(''); }}>Очистить</button></div>
      {listed.length > 8 && <label className="upload-search"><Search size={16}/><input aria-label="Поиск среди выбранных файлов" value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти выбранный файл"/></label>}
      <ul>{filtered.slice(0, 100).map(item => <li key={item.path}><File size={16}/><span title={item.path}>{item.path}</span><small>{fileSize(item.file.size)}</small><button type="button" className="icon-button" aria-label={`Убрать ${item.path}`} disabled={blocked} onClick={() => onChange(value.zip ? emptySelection() : { files: value.files.filter(file => file.path !== item.path) })}><X size={16}/></button></li>)}</ul>
      {filtered.length > 100 && <p className="panel-note muted">Показано 100 из {filtered.length}. Поиск поможет найти остальные файлы.</p>}
    </section>}
    {skipped.length > 0 && <details className="upload-excluded"><summary>Не добавлены служебные файлы и секреты: {skipped.length}</summary><p>.git, .d2d, node_modules, .env и приватные ключи не загружаются. Пример настроек .env.example можно добавить.</p><ul>{skipped.slice(0, 30).map(path => <li key={path}><code>{path}</code></li>)}</ul></details>}
    <ErrorBox error={error}/>
  </div>;
}
