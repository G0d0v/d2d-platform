import { test } from 'node:test';
import assert from 'node:assert/strict';
import { droppedFiles, mergeUploadFiles, uploadPaths } from '../web/src/upload-selection.ts';

const item = (path: string, body = path) => ({ path, file: new File([body], path.split('/').at(-1)!) });

test('upload queue adds batches, replaces duplicates, preserves nested paths and reports secrets', () => {
  const old = item('docs/readme.md', 'old'), updated = item('docs/readme.md', 'new');
  const result = mergeUploadFiles([old], [updated, item('assets/photo.png'), item('.env'), item('.d2d/token'), item('node_modules/a.js'), item('.env.example')]);
  assert.deepEqual(result.files.map(f => f.path), ['docs/readme.md', 'assets/photo.png', '.env.example']);
  assert.equal(result.files[0].file, updated.file);
  assert.deepEqual(result.skipped, ['.env', '.d2d/token', 'node_modules/a.js']);
  assert.throws(() => mergeUploadFiles([], [item('../escape')]));
  assert.throws(() => mergeUploadFiles([], [item('docs'), item('docs/file.md')]));
});

test('flattening removes only a shared outer folder and never drops a filename', () => {
  assert.deepEqual(uploadPaths([item('project/docs/a.md'), item('project/app.js')], true).map(f => f.path), ['docs/a.md', 'app.js']);
  assert.deepEqual(uploadPaths([item('a.md')], true).map(f => f.path), ['a.md']);
  assert.deepEqual(uploadPaths([item('one/a.md'), item('two/b.md')], true).map(f => f.path), ['one/a.md', 'two/b.md']);
});

test('dropping a folder reads every directory batch, preserves nesting and skips private folders', async () => {
  const entry = (name: string) => ({ name, isFile: true, isDirectory: false, file: (done: (f: File) => void) => done(new File([name], name)) });
  const batches = [Array.from({ length: 100 }, (_, i) => entry(`${i}.txt`)), [entry('last.txt')], []];
  const folder = { name: 'photos', isFile: false, isDirectory: true, createReader: () => ({ readEntries: (done: (entries: unknown[]) => void) => done(batches.shift()!) }) };
  let secretRead = false;
  const secret = { name: '.git', isFile: false, isDirectory: true, createReader: () => { secretRead = true; throw new Error('must not traverse private directory'); } };
  const transfer = { items: [folder, secret].map(value => ({ kind: 'file', webkitGetAsEntry: () => value, getAsFile: () => null })) } as unknown as DataTransfer;
  const result = mergeUploadFiles([], await droppedFiles(transfer));
  assert.equal(result.files.length, 101);
  assert.equal(result.files.at(-1)?.path, 'photos/last.txt');
  assert.equal(secretRead, false);
  assert.deepEqual(result.skipped, ['.git']);
});
