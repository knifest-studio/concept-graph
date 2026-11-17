import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import uk from '../src/locales/uk.mjs';
import { stripUserContent, errorMessage, privateControlLabel, privateTextSelector, blockedMediaSelector, privateReplayEvent, privateAttributes, referrerOrigin, scriptLocation, stackLocation, windowErrorFacts, rejectionFacts } from '../src/analytics-privacy.mjs';
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

// A tiny DOM for the private-selector boundary: class and attribute parts of the real selector list are matched.
const simpleParts = privateTextSelector.split(',').filter(part => /^(?:\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])$/.test(part));
function fake(tag, attributes = {}, children = []) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), parentElement: null, attributes, dataset: attributes.dataset || {}, id: attributes.id || '',
    childNodes: children.map(child => typeof child === 'string' ? { nodeType: 3, data: child } : child),
    getAttribute: key => attributes[key] ?? null,
    matches: selector => selector.split(',').some(part => (selector === privateTextSelector ? simpleParts.includes(part) : true) && (part.startsWith('.') ? (attributes.class || '').split(' ').includes(part.slice(1))
      : /^\[([\w-]+)(?:="([^"]*)")?\]$/.test(part) && (([, key, value]) => key in attributes && (value === undefined || attributes[key] === value))(part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/)))),
    closest: selector => { for (let at = node; at; at = at.parentElement) if (at.matches(selector)) return at; return null; },
    get textContent() { return node.childNodes.map(child => child.nodeType === 3 ? child.data : child.textContent).join(''); } };
  for (const child of node.childNodes) child.parentElement = node;
  return node;
}
test('a public control never takes its name from text inside private children, such as a page tab’s name and people', () => {
  assert.ok(simpleParts.includes('.board-page-name') && simpleParts.includes('.board-page-people'));
  const tab = (attributes = {}) => fake('button', { class: 'board-page', ...attributes }, [fake('svg', { 'aria-hidden': 'true' }),
    fake('span', { class: 'board-page-name' }, ['Launch plan ', secret]), fake('span', { class: 'board-page-people', 'aria-label': `2 people here: ${secret}` }, [fake('span', { class: 'board-page-person' }, ['ОК']), fake('span', { class: 'board-page-person' }, ['YB'])])]);
  const sidebar = fake('section', { class: 'board-pages' }, [tab()]), name = elementName(sidebar.childNodes[0]);
  assert.equal(name, 'button'); assert.ok(!/Launch|PRIVATE|ОК|YB/.test(name));
  assert.equal(elementName(tab({ dataset: { analyticsName: 'Page tab' } })), 'Page tab');
  assert.equal(elementName(fake('button', {}, ['Done', fake('b', { 'data-analytics-private': '' }, [secret])])), 'Done');
  assert.equal(elementName(fake('button', {}, ['Share ', fake('span', { role: 'alert' }, [secret])])), 'Share');
  // A dialog heading with a private part keeps only its fixed words.
  const heading = fake('h2', {}, ['Share ', fake('span', { 'data-analytics-private': '' }, [secret])]), saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => heading } });
  try {
    const dialog = fake('div', { role: 'dialog', 'aria-labelledby': 'h' }, [fake('button', {}, ['Copy link'])]);
    assert.equal(elementArea(dialog.childNodes[0]), 'dialog:Share');
  } finally { if (saved) Object.defineProperty(globalThis, 'document', saved); else delete globalThis.document; }
});
test('the page tab names itself and teammates’ calls are marked as notices, not errors', async () => {
  const pages = await readFile(new URL('../src/BoardPages.jsx', import.meta.url), 'utf8'), call = await readFile(new URL('../src/AttentionCall.jsx', import.meta.url), 'utf8');
  assert.match(pages, /data-page-id=\{page\.id\} data-analytics-name="Page tab"/);
  assert.match(call, /className="attention-card" role="alert" data-analytics-notice="attention_call"/);
});
test('remote cursors and call pings are blocked from replay, not only text-masked', async () => {
  const blocked = blockedMediaSelector.split(','), workspace = await readFile(new URL('../src/CloudWorkspace.jsx', import.meta.url), 'utf8'), call = await readFile(new URL('../src/AttentionCall.jsx', import.meta.url), 'utf8');
  for (const selector of ['img', 'video', 'canvas', '.cloud-cursor', '.attention-ping']) assert.ok(blocked.includes(selector), selector);
  assert.match(workspace, /<div className="cloud-cursor"/); assert.match(call, /<div key=\{ping\.id\} className="attention-ping"/);
});
test('error facts give the type and own-script location, flag known noise and never carry message, stack or path text', () => {
  const origin = 'https://concept.test', own = `${origin}/static/index-B3k_9x.js?board=${encodeURIComponent(secret)}#${secret}`;
  assert.equal(scriptLocation(own, 1, 4567, origin), 'index-B3k_9x.js:1:4567');
  assert.equal(scriptLocation(`${origin}/src/main.jsx?t=1`, 12, 3, origin), 'main.jsx:12:3');
  assert.equal(scriptLocation(`${origin}/board/${secret}`, 1, 1, origin), 'inline');
  assert.equal(scriptLocation(`https://accounts.example.com/${secret}.js`, 1, 1, origin), 'external');
  for (const url of ['chrome-extension://abc/content.js', 'moz-extension://abc/x.js', 'safari-web-extension://abc/x.js', 'webkit-masked-url://hidden/']) assert.equal(scriptLocation(url, 1, 1, origin), 'extension', url);
  assert.equal(scriptLocation('', 0, 0, origin), '');
  const chrome = `TypeError: Cannot read properties of undefined (reading '${secret}') at ${origin}/static/fake.js:9:9\n    at Object.run (chrome-extension://abc/inject.js:1:2)\n    at render (${own}:2:345)\n    at ${origin}/static/vendor-x.js:1:1`;
  assert.equal(stackLocation(chrome, origin), 'index-B3k_9x.js:2:345');
  assert.equal(stackLocation(`run@${origin}/static/app-1.js:5:6\n@${origin}/static/vendor.js:1:1`, origin), 'app-1.js:5:6');
  assert.equal(stackLocation(`wrap@moz-extension://abc/x.js:1:2\nrun@${own}:5:6`, origin), 'index-B3k_9x.js:5:6');
  assert.equal(stackLocation('@webkit-masked-url://hidden/:2:1234\n', origin), 'extension');
  assert.equal(stackLocation(`Error: ${secret}`, origin), '');
  const typeError = new TypeError(secret);
  assert.deepEqual(windowErrorFacts({ message: `Uncaught TypeError: ${secret}`, error: typeError, filename: own, lineno: 1, colno: 77 }, origin), { errorType: 'TypeError', location: 'index-B3k_9x.js:1:77', noise: undefined });
  assert.equal(windowErrorFacts({ message: 'ResizeObserver loop completed with undelivered notifications.', error: null, filename: '', lineno: 0, colno: 0 }, origin).noise, 'resize_observer');
  assert.deepEqual(windowErrorFacts({ message: 'Script error.', error: null, filename: '', lineno: 0, colno: 0 }, origin), { errorType: undefined, location: undefined, noise: 'cross_origin' });
  assert.equal(windowErrorFacts({ message: secret, error: new Error(secret), filename: 'chrome-extension://abc/x.js', lineno: 1, colno: 1 }, origin).noise, 'extension');
  const aborted = Object.assign(new Error(secret), { name: 'AbortError', stack: `AbortError: ${secret}\n    at fetchBoard (${origin}/static/index-a.js:1:99)` });
  assert.deepEqual(rejectionFacts(aborted, origin), { errorType: 'AbortError', location: 'index-a.js:1:99', noise: undefined });
  assert.deepEqual(rejectionFacts(secret, origin), { errorType: 'string', location: undefined, noise: undefined });
  assert.equal(rejectionFacts({ name: secret, message: secret }, origin).errorType, 'object');
  assert.equal(rejectionFacts(Object.assign(new Error(), { name: secret }), origin).errorType, 'Error');
  assert.equal(rejectionFacts(null, origin).errorType, 'null');
  // The boundary accepts only those shapes, so a modified client cannot put text in them either.
  const clean = sanitizeEvent({ seq: 1, kind: 'error', time: Date.now(), name: 'window_error', details: { message: secret, errorType: 'TypeError', location: 'index-a.js:1:99', noise: 'extension' } });
  assert.deepEqual(clean.details, { message: 'Error (details hidden)', errorType: 'TypeError', location: 'index-a.js:1:99', noise: 'extension' });
  for (const bad of [{ errorType: secret }, { errorType: 'Жираф' }, { location: own }, { location: `${secret}.js:1:2` }, { location: 'a.js' }, { noise: secret }]) {
    assert.deepEqual(sanitizeEvent({ seq: 1, kind: 'error', time: Date.now(), name: 'window_error', details: bad }).details, {}, JSON.stringify(bad));
  }
});


test('new private-control names remain useful in English and Ukrainian without any user text', async () => {
  for (const label of ['Done', 'Add', 'Account', 'Team access', 'Product analytics', 'Sign out', 'Switch board', 'Board menu', 'Rename section', 'Rename group', 'Brush', 'Eraser', 'Clear mask', 'Undo', 'Redo', 'Reset crop', 'Apply', 'Resize', 'Connect MCP', 'Keyboard shortcuts', 'Generation', 'Teammate menu', 'Go to teammate', 'Call teammate here', 'Allow', 'Decline', 'Revoke', 'Ask to use', 'Stop using their Codex', 'Cancel request']) {
    for (const ariaLabel of [label, uk[label]]) {
      assert.ok(ariaLabel, label);
      const name = controlName({ ariaLabel, text: secret, tooltip: secret, private: true, tag: 'button', type: 'button' });
      assert.ok(name && !name.startsWith('button[') && !name.includes(secret), ariaLabel);
    }
  }
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8'), help = await readFile(new URL('../src/HelpMenu.jsx', import.meta.url), 'utf8');
  assert.match(main, /role="dialog" aria-label=\{t\('Connect MCP'\)\}/);
  assert.match(help, /role="dialog" aria-label=\{t\(title\)\}/);
  assert.match(main, /className="helper-browser-warning" role="alert" data-analytics-notice="helper_browser_compatibility"/);
  assert.equal(errorMessage('Open this page in ChromeSafari and in-app browsers such as Telegram’s block websites from reaching the helper on your computer, so pairing cannot work here.'), 'Open');
});
