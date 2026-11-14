import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Loader2, X } from 'lucide-react';
import { ApiError } from './api.ts';

export function ErrorBox({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  return <div className="error-box" role="alert"><AlertCircle size={18}/><div>{error.message}
    {error instanceof ApiError && error.requestId && <small>ID обращения: {error.requestId}</small>}</div>
    {retry && <button type="button" className="button small" onClick={retry}>Обновить</button>}</div>;
}
const ModalClose = createContext<(() => void) | null>(null);
export function Modal({ title, children, close, trackChanges = true }: { title: string; children: ReactNode; close: () => void; trackChanges?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const dirty = useRef(false);
  const [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => { const node = ref.current!, previous = document.activeElement as HTMLElement | null; node.showModal(); node.querySelector<HTMLElement>('input,textarea,select')?.focus(); return () => { node.close(); previous?.focus(); }; }, []);
  useEffect(() => { dirty.current = false;if(ref.current)delete ref.current.dataset.dirty; setConfirmClose(false); }, [title]);
  function requestClose() {
    if (ref.current?.querySelector('fieldset')?.disabled) return;
    if (dirty.current) setConfirmClose(true); else close();
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  return <dialog ref={ref} onInputCapture={() => { if(trackChanges){dirty.current = true;if(ref.current)ref.current.dataset.dirty='true';} }} onCancel={e => { e.preventDefault(); requestClose(); }} onClick={e => { if (e.target === ref.current) requestClose(); }} aria-labelledby="dialog-title">
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" aria-label="Закрыть окно" onClick={requestClose}><X size={20}/></button></div>
    {confirmClose && <div className="discard-draft" role="alert"><p>В форме есть несохранённые изменения. Закрыть её и потерять черновик?</p><div className="dialog-actions"><button className="button" onClick={() => setConfirmClose(false)}>Вернуться к форме</button><button className="button primary" onClick={close}>Закрыть без сохранения</button></div></div>}
    <div hidden={confirmClose}><ModalClose.Provider value={requestClose}>{children}</ModalClose.Provider></div>
  </dialog>;
}
export function ActionForm({ children, submit, label, close,submitDisabled=false }: { children: ReactNode; submit: (data: FormData) => Promise<void>; label: string; close: () => void;submitDisabled?:boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null);
  const requestClose = useContext(ModalClose) ?? close;
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (busy||submitDisabled) return; const form = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    try { await submit(form); } catch (err) { setError(err as Error); } finally { setBusy(false); }
  }
  return <form onSubmit={onSubmit}><fieldset disabled={busy}>{children}</fieldset><ErrorBox error={error}/><div className="dialog-actions">
    <button type="button" className="button" disabled={busy} onClick={requestClose}>Отмена</button><button className="button primary" disabled={busy||submitDisabled}>{busy ? <Loader2 className="spin" size={16}/> : null}{label}</button>
  </div></form>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Secret({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="secret"><p>{label}</p><code>{value}</code><button className="button" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); } catch { setCopied(false); } }}>{copied ? <Check size={16}/> : <Copy size={16}/>}{copied ? 'Скопировано' : 'Копировать'}</button></div>;
}
export function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{children}</div>;
}
export const date = (n: number) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(Number(n));
export const initials = (s: string) => s.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase();
export function Avatar({ name, small = false }: { name: string; small?: boolean }) { return <span className={`avatar ${small ? 'tiny' : ''}`} aria-label={name}>{initials(name)}</span>; }
