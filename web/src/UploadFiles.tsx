import { useEffect, useRef, useState } from 'react';
import { Folder, GitBranch, Upload } from 'lucide-react';
import { api, uploadGitFiles } from './api.ts';
import { ErrorBox, Field, Modal } from './components.tsx';
import { FilePicker } from './FilePicker.tsx';
import { emptySelection, uploadPaths } from './upload-selection.ts';
import { captureWork, requireWorkIntent } from './work-intent.ts';
import type { Work } from '../../server/contracts.ts';

export function UploadFiles({ projectId, directory, refName, branches, empty, work, close, committed, replacePath }: {
  projectId: string; directory: string; refName: string; branches: any[]; empty: boolean; work: Work | null;
  close: () => void; committed: (branch: string) => Promise<void>; replacePath?: string;
}) {
  const [selection, setSelection] = useState(emptySelection), [strip, setStrip] = useState(false), [stripZip, setStripZip] = useState(true);
  const [branch, setBranch] = useState(branches.some(b => b.name === refName) ? refName : work?.branch ?? 'main');
  const [newBranch, setNewBranch] = useState(!empty && !branches.some(b => b.name === refName)), [from, setFrom] = useState(refName);
  const originalDirectory = replacePath ? replacePath.split('/').slice(0, -1).join('/') : directory;
  const [path, setPath] = useState(originalDirectory), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null);
  const [knownPaths, setKnownPaths] = useState<Set<string> | null>(empty ? new Set() : null), [checking, setChecking] = useState(false), [previewError, setPreviewError] = useState<Error | null>(null);
  const [confirmed, setConfirmed] = useState(false), [sent, setSent] = useState<number | null>(null), [reading, setReading] = useState(false);
  const intent = useRef(captureWork(work)), heads = useRef(Object.fromEntries(branches.map(b => [b.name, b.commit.id ?? b.commit.sha])));
  const source = newBranch ? from : branch, head = heads.current[source] ?? source;
  const files = replacePath ? selection.files.map(item => ({ ...item, path: replacePath.split('/').at(-1)! })) : uploadPaths(selection.files, strip);
  const destination = replacePath ? originalDirectory : path.replace(/\/$/, '');
  const fullPaths = files.map(item => (destination ? destination + '/' : '') + item.path);
  const replacements = fullPaths.filter(name => knownPaths?.has(name));
  const needsConfirmation = !!replacePath || replacements.length > 0 || (!empty && (!!selection.zip || !knownPaths));
  const selected = !!selection.zip || files.length > 0;

  useEffect(() => {
    if (empty) return;
    let active = true; setChecking(true); setKnownPaths(null); setPreviewError(null);
    const timer=setTimeout(()=>{ void api(`/projects/${projectId}/git/paths?ref=${encodeURIComponent(head)}`).then(result => {
      if (active) setKnownPaths(new Set(result.paths));
    }).catch(e => { if (active) setPreviewError(e as Error); }).finally(() => { if (active) setChecking(false); }); },300);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, head, empty]);
  useEffect(() => { setConfirmed(false); }, [selection, destination, strip, stripZip, head]);

  return <Modal title={replacePath ? 'Заменить файл' : 'Добавить файлы'} close={busy ? () => {} : close}>
    <form className="upload-form" onSubmit={async event => {
      event.preventDefault(); setError(null);
      if (reading || !selected || (needsConfirmation && !confirmed)) return;
      setBusy(true); setSent(0);
      try {
        const captured = requireWorkIntent(intent.current, work);
        const commit = empty ? '' : heads.current[source] ?? (await api(`/projects/${projectId}/git/commits?ref=${encodeURIComponent(source)}`)).commits[0]?.sha;
        if (!empty && !commit) throw new Error('Ветка не найдена. Выберите существующую ветку или создайте новую.');
        const description = message.trim() || (replacePath ? `Замена файла ${replacePath}` : selection.zip ? `Загрузка ${selection.zip.name}` : `Загрузка файлов${destination ? ' в ' + destination : ''}`);
        const result = await uploadGitFiles(projectId, files, { branch, from: commit ?? '', expected_head: commit ?? '', new_branch: String(newBranch), path: destination, message: description, strip_root: String(stripZip) }, captured.generation, selection.zip, setSent);
        await committed(result.branch); close();
      } catch (e) { setError(e as Error); } finally { setBusy(false); setSent(null); }
    }}>
      <div className="upload-destination"><Folder size={18}/><div><span className="muted small-text">{replacePath ? 'Файл в проекте' : 'Куда добавляем'}</span><strong>{replacePath || destination || 'Корень проекта'}</strong></div><span className="upload-branch"><GitBranch size={14}/>{branch || 'Новая ветка'}</span></div>
      <FilePicker value={selection} onChange={setSelection} disabled={busy} single={!!replacePath} onReading={setReading}/>
      {replacePath && selection.files.length > 0 && <p className="upload-note">Файл <strong>{selection.files[0].file.name}</strong> будет сохранён как <code>{replacePath}</code>. Имя и расположение в проекте сохранятся.</p>}
      {!replacePath && selection.files.some(item => item.path.includes('/')) && <label className="checkbox-field"><input type="checkbox" checked={strip} disabled={busy} onChange={event => setStrip(event.target.checked)}/>Загрузить содержимое без внешней папки</label>}
      {selection.zip && <label className="checkbox-field"><input type="checkbox" checked={stripZip} disabled={busy} onChange={event => setStripZip(event.target.checked)}/>Убрать общую внешнюю папку ZIP</label>}
      {selected && <section className="upload-plan" aria-label="Что изменится">
        <h3>Что изменится</h3>
        {checking ? <p role="status" className="muted">Проверяем файлы в выбранной ветке…</p> : selection.zip ? <p>Архив распакуется в выбранную папку. Совпадающие файлы заменятся.</p> : knownPaths ? <p><span>Новых файлов: <strong>{fullPaths.length - replacements.length}</strong></span><span>Заменится: <strong>{replacements.length}</strong></span></p> : <p>Файлы с совпадающими путями заменятся. Список существующих файлов сейчас недоступен.</p>}
        {needsConfirmation && <label className="checkbox-field"><input type="checkbox" checked={confirmed} disabled={busy || checking} onChange={event => setConfirmed(event.target.checked)}/>{replacePath ? 'Заменить этот файл новой версией' : 'Разрешить замену совпадающих файлов'}</label>}
        {!selection.zip && <details className="upload-paths"><summary>Пути файлов в проекте</summary><ul>{fullPaths.slice(0, 30).map(name => <li key={name}><code>{name}</code><span>{knownPaths ? knownPaths.has(name) ? 'Замена' : 'Новый' : 'Добавить / заменить'}</span></li>)}</ul></details>}
        {fullPaths.length > 30 && <p className="muted small-text">И ещё {fullPaths.length - 30} файлов из выбранного списка</p>}
        <p className="muted small-text">Остальные файлы проекта сохранятся. Предыдущие версии останутся в истории.</p>
        {previewError && <p className="muted small-text">{previewError.message}</p>}

      </section>}
      <Field label="Что изменилось" hint="Короткая заметка для команды. Можно оставить пустым."><input value={message} onChange={event => setMessage(event.target.value)} maxLength={500} disabled={busy} placeholder={replacePath ? 'Например: исправлена ошибка входа' : 'Например: добавлены фотографии и обновлена инструкция'}/></Field>
      <details className="upload-options" open={newBranch || undefined}><summary>Папка и ветка</summary>
        {!replacePath && <Field label="Папка назначения" hint="Можно указать новую папку, например docs/images. Пустое поле — корень проекта."><input value={path} onChange={event => setPath(event.target.value)} disabled={busy} maxLength={1000} placeholder="Корень проекта"/></Field>}
        <label className="checkbox-field"><input type="checkbox" checked={newBranch} disabled={busy} onChange={event => { setNewBranch(event.target.checked); setBranch(event.target.checked ? '' : branches.some(b => b.name === refName) ? refName : branches[0]?.name ?? 'main'); }}/>Сохранить в новой ветке</label>
        {newBranch ? <><Field label="Имя новой ветки"><input value={branch} onChange={event => setBranch(event.target.value)} required maxLength={200} disabled={busy} placeholder="Например, update/photos"/></Field>{!empty && <Field label="На основе ветки или версии"><input value={from} onChange={event => setFrom(event.target.value)} required maxLength={200} disabled={busy}/></Field>}</> : <Field label="Ветка"><select value={branch} onChange={event => setBranch(event.target.value)} disabled={busy}>{empty ? <option value={branch}>{branch}</option> : branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}</select></Field>}
      </details>
      {busy && <div className="upload-progress" role="status"><progress max={100} {...(sent !== null && sent < 100 ? { value: sent } : {})}/><span>{sent !== null && sent < 100 ? `Загружаем файлы: ${sent}%` : 'Файлы переданы. Сохраняем изменения в истории…'}</span></div>}
      <ErrorBox error={error}/>
      <div className="modal-actions">{selected&&needsConfirmation&&!confirmed&&<span className="muted small-text">Подтвердите замену выше</span>}<button className="button" type="button" disabled={busy} onClick={close}>Отмена</button><button className="button primary" disabled={busy || reading || checking || !selected || !branch || (needsConfirmation && !confirmed)}><Upload size={16}/>{busy ? 'Сохраняем…' : replacePath ? 'Заменить файл' : 'Сохранить файлы'}</button></div>
    </form>
  </Modal>;
}
