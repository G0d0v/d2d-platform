import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDiff} from '../web/src/git-diff.ts';

test('diff keeps independent old/new line numbers through additions, removals and hunks', () => {
  const [file] = parseDiff('diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,3 +5,4 @@\n same\n-old\n+new\n+extra\n end\n@@ -20 +21 @@\n-last\n+next\n');
  assert.equal(file.name, 'src/a.ts');
  assert.equal(file.added, 3); assert.equal(file.removed, 2);
  const content = file.lines.filter(line => ['context', 'add', 'remove'].includes(line.kind));
  assert.deepEqual(content.map(line => [line.kind, line.old, line.next]), [
    ['context',5,5],['remove',6,undefined],['add',undefined,6],['add',undefined,7],['context',7,8],['remove',20,undefined],['add',undefined,21],
  ]);
});

test('diff distinguishes deleted/new file headers and content beginning with +++ or ---', () => {
  const files = parseDiff('diff --git a/old.txt b/old.txt\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n---literal\ndiff --git a/new.txt b/new.txt\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+++literal\n');
  assert.deepEqual(files.map(file => [file.name,file.added,file.removed]), [['old.txt',0,1],['new.txt',1,0]]);
  assert.equal(files[1].lines.at(-1)?.text, '+++literal');
  assert.deepEqual(parseDiff(''), []);
});

test('diff decodes quoted UTF-8 paths from Git without interpreting file contents', () => {
  const [file] = parseDiff('diff --git "a/\\320\\272\\320\\276\\320\\264.txt" "b/\\320\\272\\320\\276\\320\\264.txt"\n--- "a/\\320\\272\\320\\276\\320\\264.txt"\n+++ "b/\\320\\272\\320\\276\\320\\264.txt"\n@@ -0,0 +1 @@\n+<script>alert(1)</script>');
  assert.equal(file.name, 'код.txt');
  assert.equal(file.lines.at(-1)?.text, '+<script>alert(1)</script>');
});
