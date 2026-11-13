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
export const blockedMediaSelector = 'img,video,canvas,.drawing-node,.stroke-preview';

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
