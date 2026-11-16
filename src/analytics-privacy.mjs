import uk from './locales/uk.mjs';

// Use the same boundary for replay text and event labels. Portals need their own container.
export const privateTextSelector = [
  // Names and content only: the labels of the interface around them stay readable in recordings.
  '[data-analytics-private]', '.react-flow', '.board-picker', '.board-page-name', '.board-page-input', '.board-page-people', '.cloud-board-section',
  '.canvas-top > span', '.history-list', '.generation-tray', '.run-diagnostics',
  '.board-modal:not(:has(.theme-button))', '.custom-nodes', '.template-editor', '.template-details', '.lightbox', '.image-editor',
  '.board-chat-panel', '.voice-panel', '.cloud-presence', '.cloud-cursor', '.account-menu',
  '.attention-card', '.codex-share', '.codex-share-panel', '.codex-requests', '.codex-teammates',
  '.board-author', '.toast', '[role="alert"]', '[role="tooltip"]', 'head title'
].join(',');
// Blocked nodes are recorded as same-size empty boxes and their later changes are dropped (rrweb). Teammates' cursors and
// call pings move many times a second, so every tab recorded every other person's pointer: replay grew with people².
export const blockedMediaSelector = 'img,video,canvas,model-viewer,.drawing-node,.stroke-preview,.cloud-cursor,.attention-ping';
// A control's own text without what sits in a private container inside it, e.g. a page tab without its name and people.
export function publicText(element) {
  if (!element || element.closest?.(privateTextSelector)) return '';
  const visit = node => node.nodeType === 3 ? node.data : node.nodeType !== 1 || node.matches(privateTextSelector) ? '' : [...node.childNodes].map(visit).join('');
  return visit(element);
}

const userSlot = /\{(?:name|label|email|owner|names|domain|prompt|text|message|error|file|filename|path|caption|page)\}/;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = Object.entries(uk).flatMap(([english, translation]) => [english, ...[translation].flat()]);
const patternFor = value => new RegExp('^' + value.split(/(\{\w+\})/).map(part => /^\{\w+\}$/.test(part) ? '[\\s\\S]+?' : escape(part)).join('') + '$');
const fixedPart = value => value.replace(/\{\w+\}$/, '').replace(/\{\w+\}/g, '…').trim();
const templates = phrases.filter(value => userSlot.test(value)).map(value => ({
  pattern: patternFor(value),
  fixed: fixedPart(value),
  weight: value.replace(/\{\w+\}/g, '').length
})).sort((a, b) => b.weight - a.weight);
const quotes = value => value.replace(/“[^”]*”|«[^»]*»|"(?:\\.|[^"\\])*"/g, match => match[0] + '…' + match.at(-1));
const fixedLabels = new Set(templates.map(template => quotes(template.fixed)));
export function stripUserContent(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  if (fixedLabels.has(normalized)) return normalized;
  const template = templates.find(template => template.pattern.test(normalized));
  return quotes(template ? template.fixed : normalized)
    .replace(/[\p{L}\p{N}.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}.-]+/gu, '…')
    .replace(/(?:https?:\/\/|blob:|data:)[^\s<>]+/gi, '…');
}
const uiLabels = new Set(phrases.filter(value => !/\{\w+\}/.test(value)));
const uiTemplates = phrases.filter(value => /\{\w+\}/.test(value)).map(value => ({ pattern: patternFor(value), fixed: fixedPart(value), weight: value.replace(/\{\w+\}/g, '').length })).sort((a, b) => b.weight - a.weight);
export function privateControlLabel(value) {
  if (typeof value !== 'string') return '';
  const label = value.trim();
  if (uiLabels.has(label)) return stripUserContent(label);
  const template = uiTemplates.find(template => template.pattern.test(label));
  return template ? stripUserContent(template.fixed) : '';
}
const fixedMessages = new Set([...phrases, 'Failed', 'Error', 'Failed to fetch', 'TypeError: Failed to fetch', 'Load failed',
  'NetworkError when attempting to fetch resource.', 'Unknown rejection', 'Resource failed to load', 'Script error.'].map(stripUserContent));
export function errorMessage(value) {
  const clean = stripUserContent(value);
  // A provider or arbitrary exception can echo an unquoted prompt; only known UI message structure is safe.
  return fixedMessages.has(clean) ? clean : 'Error (details hidden)';
}
// Error facts that carry no content: the error's type, where in our own scripts it was thrown (file name, line and column
// only) and known noise. Message and stack text never leave the browser.
const extensionUrl = /^(?:[a-z]+-)*extension:|^webkit-masked-url:/i; // Safari masks extension script URLs as webkit-masked-url://hidden/
export const ownScript = /^[\w.-]{1,100}\.(?:m?js|jsx|tsx?):\d{1,9}:\d{1,9}$/;
export function scriptLocation(url, line, column, origin = globalThis.location?.origin) {
  if (typeof url !== 'string' || !url) return '';
  if (extensionUrl.test(url)) return 'extension';
  let parsed; try { parsed = new URL(url, origin); } catch { return ''; }
  if (parsed.origin !== origin) return 'external';
  const where = `${parsed.pathname.split('/').pop()}:${Math.max(0, line | 0)}:${Math.max(0, column | 0)}`;
  return ownScript.test(where) ? where : 'inline';
}
// The first frame in our own scripts, else what the top frame is. Chrome's stack starts with the message, so only its
// "at" lines are read; Firefox and Safari write name@url:line:col.
export function stackLocation(stack, origin = globalThis.location?.origin) {
  const lines = String(stack || '').split('\n'), chrome = lines.some(line => /^\s+at\s/.test(line));
  let top = '';
  for (const line of lines.filter(line => chrome ? /^\s+at\s/.test(line) : line.includes('@')).slice(0, 50)) {
    const frame = chrome ? line.match(/^\s*at (?:.*? \()?(\S+?):(\d+):(\d+)\)?$/) : line.match(/@(\S+?):(\d+):(\d+)$/), where = frame ? scriptLocation(frame[1], +frame[2], +frame[3], origin) : '';
    if (ownScript.test(where)) return where;
    top ||= where;
  }
  return top;
}
// Built-in and DOMException names (TypeError, AbortError) or what was thrown instead of an Error.
const errorName = /^(?:[A-Z][A-Za-z]{0,40})?Error$/, thrownTypes = new Set(['string', 'number', 'bigint', 'boolean', 'symbol', 'undefined', 'object', 'function', 'null']);
export const validErrorType = value => typeof value === 'string' && (errorName.test(value) || thrownTypes.has(value));
export function errorType(value) {
  if (value === null) return 'null';
  if (typeof value?.name === 'string' && errorName.test(value.name) && (value instanceof Error || 'message' in value)) return value.name;
  return value instanceof Error ? 'Error' : typeof value;
}
export function windowErrorFacts({ message, error, filename, lineno, colno } = {}, origin = globalThis.location?.origin) {
  const where = scriptLocation(filename, lineno, colno, origin) || (typeof error?.stack === 'string' ? stackLocation(error.stack, origin) : ''), text = String(message || '');
  // Browsers report a cross-origin script's error only as "Script error."; the ResizeObserver one is a skipped layout frame.
  const noise = /ResizeObserver loop/.test(text) ? 'resize_observer' : where === 'extension' ? 'extension' : /^Script error\.?$/.test(text) ? 'cross_origin' : undefined;
  return { errorType: error ? errorType(error) : undefined, location: where || undefined, noise };
}
export function rejectionFacts(reason, origin = globalThis.location?.origin) {
  const where = typeof reason?.stack === 'string' ? stackLocation(reason.stack, origin) : '';
  return { errorType: errorType(reason), location: where || undefined, noise: where === 'extension' ? 'extension' : undefined };
}
export function referrerOrigin(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.origin : ''; } catch { return ''; } }

// rrweb's text/input masks do not mask attributes (titles, tooltips, option values or chat links).
const layoutAttributes = new Set(('class style role type tabindex disabled hidden checked selected multiple readonly required maxlength minlength min max step size rows cols contenteditable dir lang width height viewBox xmlns fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity d cx cy r rx ry x x1 x2 y y1 y2 points pathLength preserveAspectRatio transform offset stop-color stop-opacity gradientUnits gradientTransform marker-end marker-start aria-expanded aria-pressed aria-checked aria-selected aria-disabled aria-hidden aria-modal aria-current aria-valuenow aria-valuemin aria-valuemax aria-orientation aria-haspopup data-theme data-cloud data-view-only data-board-tool data-moving data-pannable data-on').split(' '));
const mask = value => typeof value === 'string' ? value.replace(/\S/g, '*') : value;
export function privateAttributes(attributes) {
  const result = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (/^(?:src|srcset|href|xlink:href|action|formaction|poster|rr_src|rr_dataURL)$/i.test(key) || /^on/i.test(key)) continue;
    if (key === 'id' && value === 'root' || key === '_cssText' || /^rr_(?:width|height|scrollLeft|scrollTop|open_mode)$/.test(key) || layoutAttributes.has(key)) result[key] = value;
    else result[key] = mask(value);
  }
  return result;
}
export function privateReplayEvent(event) {
  const node = value => ({ ...value, ...(value.attributes ? { attributes: privateAttributes(value.attributes) } : {}),
    ...(value.childNodes ? { childNodes: value.childNodes.map(node) } : {}) });
  if (event.type === 2 && event.data?.node) return { ...event, data: { ...event.data, node: node(event.data.node) } };
  if (event.type === 3 && event.data?.source === 0) return { ...event, data: { ...event.data,
    adds: (event.data.adds || []).map(added => ({ ...added, node: node(added.node) })),
    attributes: (event.data.attributes || []).map(changed => ({ ...changed, attributes: privateAttributes(changed.attributes) }))
  } };
  if (event.type === 4 && event.data) return { ...event, data: { ...event.data, href: referrerOrigin(event.data.href) } };
  return event;
}
