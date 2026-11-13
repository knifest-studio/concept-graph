import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import uk from '../src/locales/uk.mjs';
import { stripUserContent, errorMessage, privateControlLabel, privateTextSelector, privateReplayEvent, privateAttributes, referrerOrigin } from '../src/analytics-privacy.mjs';
import { controlName, sanitizeEvent } from '../src/analytics-core.mjs';
import { elementName, elementArea } from '../src/analytics.mjs';

const secret = 'PRIVATE-Жираф-customer@example.com';
test('quoted values and named English/Ukrainian UI templates cannot escape in event names', () => {
  assert.equal(stripUserContent('Contact жираф@example.com'), 'Contact …');
  assert.equal(stripUserContent(`Delete “${secret}”?`), 'Delete “…”?');
  assert.equal(stripUserContent(`Delete «${secret}»`), 'Delete «…»');
  assert.equal(stripUserContent(`Failed on "${secret}"`), 'Failed on "…"');
  for (const [value, fixed] of [
    [`Open board ${secret}`, 'Open board'], [`Show prompt: ${secret}`, 'Show prompt:'],
    [`Dismiss error for ${secret}`, 'Dismiss error for'], [`View instructions and references for ${secret}`, 'View instructions and references for'],
    [`Nano Banana for ${secret}`, 'Nano Banana for'], [`Nano Banana and GPT Image for ${secret}`, 'Nano Banana and GPT Image for'],
    [`Admin rights for ${secret}`, 'Admin rights for'], [`Role for ${secret}`, 'Role for'],
    [`Using ${secret}’s Codex`, 'Using …’s Codex'], [`Call ${secret} here`, 'Call … here']
  ]) assert.equal(stripUserContent(value), fixed);
  for (const [key, translated] of Object.entries(uk)) {
    if (!/\{(?:name|label|email|owner|names|domain|page)\}/.test(key)) continue;
    for (const template of [key, ...[translated].flat()]) {
      const input = template.replace(/\{\w+\}/g, secret), stripped = stripUserContent(input);
      assert.ok(!stripped.includes('PRIVATE') && !stripped.includes('Жираф') && !stripped.includes('customer'), template);
      assert.equal(stripUserContent(stripped), stripped, template);
    }
  }
});
test('error messages keep known fixed context and hide unstructured provider text before any truncation', () => {
  const input = `The mask on “${secret.repeat(200)}” no longer matches the image. Paint it again.`;
  assert.equal(errorMessage(input), 'The mask on “…” no longer matches the image. Paint it again.');
  assert.equal(errorMessage('Failed to fetch'), 'Failed to fetch');
  assert.equal(errorMessage(`Provider refused this prompt: ${secret}`), 'Error (details hidden)');
  const id = '12345678-1234-1234-1234-123456789abc';
  const result = sanitizeEvent({ seq: 1, kind: 'click', time: Date.now(), name: `Show prompt: ${secret.repeat(200)}`, area: 'dialog:Share', board: id,
    details: { message: input, page: id, run: id, nodeType: 'text', referrer: `https://example.com/${secret}?prompt=${secret}#${secret}`, text: secret, email: secret } });
  assert.equal(result.name, 'Show prompt:'); assert.equal(result.board, id); assert.equal(result.details.page, id); assert.equal(result.details.run, id);
  assert.equal(result.details.message, 'The mask on “…” no longer matches the image. Paint it again.');
  assert.equal(result.details.referrer, 'https://example.com'); assert.equal(result.details.nodeType, 'text');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('private controls never use content, raw people names, tooltips, dynamic IDs or private dialog headings', () => {
  const element = (attributes = {}, hidden = true) => ({ tagName: 'BUTTON', textContent: secret, id: secret, dataset: { tooltip: attributes.tooltip },
    getAttribute: key => attributes[key] || null, closest: selector => selector === privateTextSelector && hidden ? {} : null });
  assert.equal(elementName(element()), 'button');
  assert.equal(elementName(element({ 'aria-label': secret, tooltip: secret })), 'button');
  assert.equal(elementName(element({ 'aria-label': 'Generate image' })), 'Generate image');
  assert.equal(elementName(element({ 'aria-label': `Open board ${secret}` })), 'Open board');
  assert.equal(controlName({ private: true, text: secret, id: secret, tag: 'a', role: 'tab' }), 'a[role=tab]');
  assert.equal(privateControlLabel(secret), '');
  assert.equal(privateControlLabel('Cancel'), 'Cancel');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => ({ textContent: secret }) } });
  try {
    const dialog = { getAttribute: key => key === 'aria-labelledby' ? 'private-heading' : null, closest: () => ({}) };
    assert.equal(elementArea({ closest: selector => selector === '[role="dialog"]' ? dialog : null }), 'dialog:dialog');
  } finally { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; }
});
test('replay scrubs text-bearing attributes and URLs in initial snapshots and incremental mutations without changing the mirror', () => {
  const attributes = { class: 'board-page', title: secret, 'aria-label': secret, 'data-tooltip': secret, href: `https://example.com/${secret}`, value: secret,
    'data-page-id': secret, 'data-user': secret, style: 'width:20px', width: '20', 'aria-expanded': 'true', id: secret };
  const before = { type: 2, data: { node: { id: 1, type: 2, attributes: { id: 'root' }, childNodes: [{ id: 2, type: 2, attributes, childNodes: [{ type: 3, textContent: '******' }] }] } } };
  const result = privateReplayEvent(before);
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.equal(before.data.node.childNodes[0].attributes.title, secret);
  const clean = result.data.node.childNodes[0].attributes;
  assert.equal(clean.class, 'board-page'); assert.equal(clean.style, 'width:20px'); assert.equal(clean.href, undefined);
  assert.equal(clean.title.length, secret.length); assert.equal(result.data.node.attributes.id, 'root');
  const mutation = privateReplayEvent({ type: 3, data: { source: 0, adds: [{ parentId: 1, node: before.data.node.childNodes[0] }], attributes: [{ id: 1, attributes }] } });
  assert.ok(!JSON.stringify(mutation).includes('PRIVATE')); assert.equal(privateAttributes({ src: secret }).src, undefined);
  assert.equal(privateReplayEvent({ type: 4, data: { href: `https://example.com/?board=${secret}` } }).data.href, 'https://example.com');
  assert.equal(referrerOrigin(`data:text/plain,${secret}`), '');
});
test('private portal containers and reusable avatars are explicitly marked', async () => {
  for (const file of ['BoardPresence.jsx', 'BoardPages.jsx', 'CloudWorkspace.jsx']) {
    assert.ok((await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')).includes('data-analytics-private'), file);
  }
});
