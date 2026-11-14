import type { Work } from '../../server/contracts.ts';
export type WorkIntent=Pick<Work,'id'|'project_id'|'generation'>;
export function captureWork(work:Work|null):WorkIntent|null {return work?{id:work.id,project_id:work.project_id,generation:work.generation}:null;}
export function requireWorkIntent(intent:WorkIntent|null,current:Work|null):WorkIntent {
  if(!intent||!current||intent.id!==current.id||intent.project_id!==current.project_id||intent.generation!==current.generation) throw new Error('Рабочая сессия изменилась. Черновик сохранён. Закройте окно и откройте действие для актуальной работы.');
  return intent;
}
