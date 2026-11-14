import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../web/src/Markdown.tsx';

test('repository Markdown escapes HTML and rejects executable link targets', () => {
  const html = renderToStaticMarkup(createElement(Markdown, {text:'# README\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n```html\n<img src=x onerror=alert(1)>\n```'}));
  assert.match(html, /<h2[^>]*>README<\/h2>/);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
});
