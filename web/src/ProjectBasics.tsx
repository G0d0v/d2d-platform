import { useState } from 'react';
import { Field } from './components.tsx';

function suggestedSlug(name: string): string {
  const letters: Record<string, string> = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  const slug = [...name.toLowerCase()].map(char => letters[char] ?? char).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/g, '');
  return slug.length === 1 ? slug + '-project' : slug;
}

export function ProjectBasics() {
  const [name, setName] = useState(''), [slug, setSlug] = useState(''), [edited, setEdited] = useState(false);
  return <>
    <Field label="Название проекта"><input name="name" required maxLength={100} placeholder="Например, панель управления" autoFocus value={name} onChange={event => { setName(event.target.value); if (!edited) setSlug(suggestedSlug(event.target.value)); }}/></Field>
    <Field label="Адрес проекта" hint="Заполняется по названию. Можно изменить: латинские буквы, цифры и дефис."><input name="slug" required pattern="[a-z0-9][a-z0-9-]+" minLength={2} maxLength={60} placeholder="control-panel" value={slug} onChange={event => { setSlug(event.target.value); setEdited(true); }}/></Field>
    <Field label="Описание · необязательно"><textarea name="description" maxLength={2000} placeholder="Для чего нужен проект и что важно знать команде"/></Field>
  </>;
}
