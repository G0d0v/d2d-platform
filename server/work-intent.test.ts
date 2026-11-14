import {test} from 'node:test';import assert from 'node:assert/strict';
import {captureWork,requireWorkIntent} from '../web/src/work-intent.ts';
import type {Work} from './contracts.ts';
test('открытая форма сохраняет исходное поколение и не переключается на новую сессию',()=>{
  const old={id:'old',project_id:'project',generation:1} as Work;const intent=captureWork(old);
  assert.equal(requireWorkIntent(intent,old).id,'old');
  assert.throws(()=>requireWorkIntent(intent,{...old,id:'new',generation:2}),/изменилась/);
  assert.throws(()=>requireWorkIntent(intent,{...old,generation:2}),/изменилась/);
  assert.throws(()=>requireWorkIntent(intent,null),/изменилась/);
  assert.throws(()=>requireWorkIntent(intent,{...old,project_id:'other'}),/изменилась/);
});
