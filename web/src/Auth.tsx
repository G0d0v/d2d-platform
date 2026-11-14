import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, GitBranch, ShieldCheck, Users, Waypoints } from 'lucide-react';
import { api, setCsrf } from './api.ts';
import { ErrorBox, Field } from './components.tsx';

export function Auth({ onLogin }: { onLogin: (result: any) => void }) {
  const [mode, setMode] = useState('login'), [setup, setSetup] = useState(false), [registration, setRegistration] = useState('invite');
  const [error, setError] = useState<Error | null>(null), [busy, setBusy] = useState(false);
  async function loadStatus() {
    try { const status = await api('/status'); setSetup(status.setup); setRegistration(status.registration); if (status.setup) setMode('register'); setError(null); }
    catch (err) { setError(err as Error); }
  }
  useEffect(() => { void loadStatus(); }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null);
    try {
      const body = Object.fromEntries([...f.entries()].filter(([, value]) => value !== ''));
      const result = await api(`/auth/${mode}`, 'POST', body); setCsrf(result.csrf); onLogin(result);
    } catch (err) { setError(err as Error); } finally { setBusy(false); }
  }
  return <div className="auth-layout"><section className="auth-story"><a className="brand" href="#"><span className="brand-symbol"><Waypoints size={24}/></span><span>D2D<span className="brand-light"> Platform</span></span></a>
    <div className="story-content"><span className="eyebrow">DEVELOPER TO DEVELOPER</span><h1>Хорошая работа<br/>начинается<br/><em>с общего контекста.</em></h1><p>Проекты, задачи и передача работы.<br/>Всё, что нужно вашей команде, в одном месте.</p>
      <div className="story-flow"><span><GitBranch size={20}/> Взять в работу</span><i/><span><Users size={20}/> Передать контекст</span></div></div>
    <div className="auth-footer"><ShieldCheck size={16}/> Приватное рабочее пространство <span>Локальная альфа · 0.1</span></div></section>
    <section className="auth-form"><div className="auth-form-inner"><span className="eyebrow">ВАША КОМАНДА. ВАШИ ПРОЕКТЫ.</span><h2>{mode === 'register' ? setup ? 'Создайте своё пространство' : 'Присоединиться к команде' : mode === 'recover' ? 'Восстановить доступ' : 'С возвращением'}</h2>
      <p className="muted">{mode === 'register' ? setup ? 'Первый аккаунт станет владельцем платформы.' : 'Введите данные и код приглашения от владельца.' : mode === 'recover' ? 'Используйте резервный код, сохранённый при регистрации.' : 'Войдите, чтобы продолжить работу над проектами.'}</p>
      <form onSubmit={submit}><fieldset disabled={busy}><Field label="Логин"><input name="login" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]+" placeholder="Ваш логин"/></Field>
        {mode === 'register' && <Field label="Ваше имя"><input name="display_name" required maxLength={80} autoComplete="name" placeholder="Как к вам обращаться"/></Field>}
        {mode === 'recover' && <Field label="Резервный код"><input name="recovery_code" required autoComplete="off"/></Field>}
        <Field label={mode === 'recover' ? 'Новый пароль' : 'Пароль'} hint={mode !== 'login' ? 'Не менее 12 символов' : undefined}><input name="password" type="password" required minLength={mode === 'login' ? 1 : 12} maxLength={200} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="Введите пароль"/></Field>
        {mode === 'register' && !setup && registration === 'invite' && <Field label="Код приглашения"><input name="invite" required autoComplete="off"/></Field>}
        <ErrorBox error={error} retry={loadStatus}/><button className="button primary full" disabled={busy}>{busy ? 'Подождите…' : mode === 'register' ? 'Создать аккаунт' : mode === 'recover' ? 'Восстановить доступ' : 'Войти в пространство'}<ArrowRight size={18}/></button>
      </fieldset></form>
      <div className="auth-links">{!setup && <button className="text-button" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setError(null); }}>{mode === 'register' ? 'Уже есть аккаунт? Войти' : 'Создать аккаунт'}</button>}
        <button className="text-button" onClick={() => { setMode(mode === 'recover' ? 'login' : 'recover'); setError(null); }}>{mode === 'recover' ? 'Вернуться ко входу' : 'Забыли пароль?'}</button></div>
      <div className="auth-note"><ShieldCheck size={16}/><span>Без почты и рассылок. Доступ восстанавливается резервным кодом.</span></div>
    </div></section></div>;
}
