export const isMacPlatform = platform => /Mac|iPhone|iPad|iPod/i.test(platform || '');
let macPlatform;
export const platformIsMac = () => macPlatform ??= typeof navigator !== 'undefined' && isMacPlatform(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent);
export const shortcutLabel = (keys, mac) => keys.replace(/Mod\+/g, mac ? '⌘ ' : 'Ctrl+').replace(/Shift\+/g, mac ? '⇧ ' : 'Shift+');

// One registry drives the handlers, the help list, tooltips and Settings. A binding is modifiers plus a KeyboardEvent.code
// ("Mod+Shift+KeyZ"); Mod is ⌘ on a Mac and Ctrl elsewhere. Fixed entries are shown but cannot be rebound: the browser owns
// copy, paste and cut, and the rest are part of how dialogs and the fullscreen viewer work.
const entry = (id, label, group, scope, bindings, options = {}) => Object.freeze({ id, label, group, scope, bindings: Object.freeze(bindings), inText: false, repeat: true, fixed: false, ...options });
const tools = 'Canvas tools', editing = 'Editing', layers = 'Layers', navigation = 'Navigation';
export const shortcutRegistry = Object.freeze([
  entry('tool.select', 'Select', tools, 'canvas', ['KeyV']),
  entry('tool.pen', 'Pen', tools, 'canvas', ['KeyP']),
  entry('tool.sticky', 'Sticky note', tools, 'canvas', ['KeyS']),
  entry('tool.stamp', 'Stamp', tools, 'canvas', ['KeyE']),
  entry('tool.rectangle', 'Rectangle', tools, 'canvas', ['KeyR']),
  entry('tool.ellipse', 'Ellipse', tools, 'canvas', ['KeyO']),
  entry('tool.arrow', 'Arrow', tools, 'canvas', ['KeyL', 'KeyX']),
  entry('section.wrap', 'Wrap selection in a section, or choose Section', tools, 'canvas', ['Shift+KeyS'], { repeat: false }),
  // Holding T would otherwise drop a new prompt on every key repeat.
  entry('prompt.add', 'Add text prompt', tools, 'canvas', ['KeyT'], { repeat: false }),
  // Works while typing a prompt, as it always has: the prompt is saved and the selection duplicated.
  entry('edit.duplicate', 'Duplicate selection with connections', editing, 'canvas', ['Mod+KeyD'], { inText: true }),
  entry('drag.duplicate', 'Hold Alt while dragging to duplicate', editing, 'canvas', [], { fixed: true, display: { mac: '⌥ drag', other: 'Alt+drag' } }),
  entry('edit.undo', 'Undo', editing, 'canvas', ['Mod+KeyZ']),
  // Windows and Linux apps also redo with Ctrl+Y.
  entry('edit.redo', 'Redo', editing, 'canvas', ['Mod+Shift+KeyZ'], { pc: ['Mod+KeyY'] }),
  entry('edit.delete', 'Delete selection', editing, 'canvas', ['Delete', 'Backspace'], { repeat: false }),
  entry('group.create', 'Group selected nodes', editing, 'canvas', ['Mod+KeyG'], { repeat: false }),
  entry('group.remove', 'Ungroup selected groups', editing, 'canvas', ['Mod+Shift+KeyG'], { repeat: false }),
  entry('prompt.generate', 'Generate (in a prompt editor)', editing, 'prompt', ['Mod+Enter'], { inText: true, repeat: false }),
  entry('edit.copy', 'Copy selected nodes or image', editing, 'canvas', ['Mod+KeyC'], { fixed: true }),
  entry('copy.ids', 'Copy selected node, group or section IDs', editing, 'canvas', ['Mod+Shift+KeyC'], { repeat: false }),
  entry('edit.paste', 'Paste text, images or copied nodes', editing, 'canvas', ['Mod+KeyV'], { fixed: true }),
  entry('edit.cut', 'Cut', editing, 'canvas', ['Mod+KeyX'], { fixed: true, hidden: true }),
  entry('page.rename', 'Rename page (when its button has focus)', editing, 'canvas', ['F2'], { fixed: true }),
  entry('layer.front', 'Bring to front', layers, 'canvas', ['BracketRight']),
  entry('layer.forward', 'Bring forward', layers, 'canvas', ['Mod+BracketRight']),
  entry('layer.backward', 'Send backward', layers, 'canvas', ['Mod+BracketLeft']),
  entry('layer.back', 'Send to back', layers, 'canvas', ['BracketLeft']),
  entry('escape', 'Return to Select / close dialog', navigation, 'global', ['Escape'], { fixed: true }),
  entry('help', 'Keyboard shortcuts', navigation, 'global', ['Shift+Slash'], { repeat: false }),
  entry('zoom.in', 'Zoom image (fullscreen)', navigation, 'zoom', ['Equal', 'Shift+Equal'], { fixed: true, display: { mac: '+ / −', other: '+ / −' } }),
  entry('zoom.out', 'Zoom out (fullscreen)', navigation, 'zoom', ['Minus', 'Shift+Minus'], { fixed: true, hidden: true }),
  entry('zoom.fit', 'Fit image (fullscreen)', navigation, 'zoom', ['Digit0'], { fixed: true }),
  entry('zoom.actual', 'Real pixels (fullscreen)', navigation, 'zoom', ['Digit1'], { fixed: true }),
  entry('pan.left', 'Pan image (fullscreen)', navigation, 'zoom', ['ArrowLeft'], { fixed: true, display: { mac: '← / → / ↑ / ↓', other: '← / → / ↑ / ↓' } }),
  entry('pan.right', 'Pan image right (fullscreen)', navigation, 'zoom', ['ArrowRight'], { fixed: true, hidden: true }),
  entry('pan.up', 'Pan image up (fullscreen)', navigation, 'zoom', ['ArrowUp'], { fixed: true, hidden: true }),
  entry('pan.down', 'Pan image down (fullscreen)', navigation, 'zoom', ['ArrowDown'], { fixed: true, hidden: true })
]);
const byId = new Map(shortcutRegistry.map(item => [item.id, item]));
export const shortcutEntry = id => byId.get(id);
export const rebindable = id => !!byId.get(id) && !byId.get(id).fixed;
export const defaultBindings = (id, mac) => { const item = byId.get(id); return item ? [...item.bindings, ...(!mac && item.pc || [])] : []; };

// US-layout characters for each code: the printed key on most keyboards and the label shown for it.
const punctuation = { Backquote: ['`', '~'], Minus: ['-', '_'], Equal: ['=', '+'], BracketLeft: ['[', '{'], BracketRight: [']', '}'], Backslash: ['\\', '|'], Semicolon: [';', ':'], Quote: ["'", '"'], Comma: [',', '<'], Period: ['.', '>'], Slash: ['/', '?'] };
const digits = Object.fromEntries([')', '!', '@', '#', '$', '%', '^', '&', '*', '('].map((shifted, digit) => [`Digit${digit}`, [String(digit), shifted]]));
const typed = { ...punctuation, ...digits };
const named = { Enter: 'Enter', Delete: 'Delete', Backspace: 'Backspace', Escape: 'Escape', Tab: 'Tab', Space: ' ', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`])) };
const characters = new Map(Object.entries(typed).flatMap(([code, [plain, shifted]]) => [[plain, { code, shift: false }], [shifted, { code, shift: true }]]));
const modifierOrder = ['Mod', 'Ctrl', 'Alt', 'Shift'];
const isLetter = code => /^Key[A-Z]$/.test(code);
const validCode = code => isLetter(code) || Object.hasOwn(typed, code) || Object.hasOwn(named, code);

export function parseBinding(binding) {
  if (typeof binding !== 'string' || binding.length > 40) return null;
  const parts = binding.split('+'), code = parts.pop(), mods = new Set(parts);
  if (!validCode(code) || mods.size !== parts.length || parts.some(part => !modifierOrder.includes(part))) return null;
  return { mod: mods.has('Mod'), ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift'), code };
}
export const formatBinding = ({ mod, ctrl, alt, shift, code }) => [mod && 'Mod', ctrl && 'Ctrl', alt && 'Alt', shift && 'Shift', code].filter(Boolean).join('+');
export const normalBinding = binding => { const parsed = parseBinding(binding); return parsed ? formatBinding(parsed) : null; };
// Two bindings that fire on the same keys. Away from a Mac, Ctrl is Mod.
export const sameBinding = (a, b, mac) => {
  const x = parseBinding(a), y = parseBinding(b);
  if (!x || !y) return false;
  const fold = value => mac ? value : { ...value, mod: value.mod || value.ctrl, ctrl: false };
  return formatBinding(fold(x)) === formatBinding(fold(y));
};

// The bindings in force: personal overrides on top of the defaults. Fixed entries ignore overrides.
let active = null;
export const setActiveShortcutOverrides = overrides => { active = overrides || null; };
export const activeShortcutOverrides = () => active;
let resolvedCache = { overrides: undefined, mac: undefined, map: null };
export function resolveBindings(overrides = active, mac = platformIsMac()) {
  if (resolvedCache.map && resolvedCache.overrides === overrides && resolvedCache.mac === mac) return resolvedCache.map;
  const custom = overrides?.bindings || {};
  const map = new Map(shortcutRegistry.map(item => [item.id, !item.fixed && Object.hasOwn(custom, item.id) && Array.isArray(custom[item.id]) ? custom[item.id] : defaultBindings(item.id, mac)]));
  resolvedCache = { overrides, mac, map };
  return map;
}
export const currentBindings = (id, overrides = active, mac = platformIsMac()) => resolveBindings(overrides, mac).get(id) || [];

// Duplicate and Generate also run while typing, so a binding for them must not be a key that types or edits text:
// it needs ⌘/Ctrl (macOS Option and AltGr type characters), or a function key.
export const typingSafe = binding => { const parsed = typeof binding === 'string' ? parseBinding(binding) : binding; return !!parsed && (parsed.mod || parsed.ctrl || /^F\d+$/.test(parsed.code)); };

// The wider of the text-field checks the app used: anything a person types into, but not checkboxes, sliders or buttons.
export const textEntrySelector = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="color"]):not([type="file"]),textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
export const isTextEntry = target => !!target?.closest?.(textEntrySelector);

// How well one binding matches a key press: 0 for no match. The typed character wins over the physical key, so AZERTY's
// Z works for Z; when the character is not a Latin letter (Ukrainian, macOS Option, dead keys) the physical key counts,
// as tldraw and Excalidraw do. Punctuation also accepts the physical key, and ignores the Shift or AltGr that typed it.
function bindingScore(binding, event, mac) {
  const { code } = binding, key = String(event.key ?? '');
  let via;
  if (isLetter(code)) via = /^[a-z]$/i.test(key) ? key.toLowerCase() === code.slice(3).toLowerCase() && 'key' : event.code === code && 'code';
  else if (Object.hasOwn(named, code)) via = key === named[code] && 'key';
  else via = key === typed[code][binding.shift ? 1 : 0] ? 'typed' : event.code === code && 'code';
  if (!via) return 0;
  let { shiftKey: shift, altKey: alt, ctrlKey: ctrl, metaKey: meta } = event;
  if (via === 'typed') { shift = binding.shift; if (ctrl && alt) ctrl = alt = false; }
  if (!!shift !== binding.shift || !!alt !== binding.alt) return 0;
  const wantMod = binding.mod || (!mac && binding.ctrl), wantCtrl = mac && binding.ctrl;
  const command = mac ? !!meta : !!ctrl, other = mac ? !!ctrl : !!meta;
  const exact = command === wantMod && other === wantCtrl;
  // ⌘ and Ctrl both stand for Mod, as the canvas has always accepted; an exact match still wins.
  const lenient = !exact && wantMod && !wantCtrl && (meta || ctrl);
  if (!exact && !lenient) return 0;
  return (via === 'code' ? 1 : 3) - (exact ? 0 : .5);
}

// The action a key press triggers, or null. ctx: scopes to consider, an optional list of ids, and whether the press is in a
// text field (worked out from the target when omitted); overrides and platform default to the person's current ones.
export function matchShortcut(event, { scopes = ['canvas', 'global'], ids, editing, overrides = active, mac = platformIsMac() } = {}) {
  const native = event?.nativeEvent || event;
  if (!native || native.isComposing || native.key === 'Process' || native.keyCode === 229) return null;
  const typing = editing ?? isTextEntry(native.target), resolved = resolveBindings(overrides, mac);
  let best = null, bestScore = 0;
  for (const item of shortcutRegistry) {
    if (!scopes.includes(item.scope) || (ids && !ids.includes(item.id)) || (typing && !item.inText) || (native.repeat && !item.repeat)) continue;
    for (const text of resolved.get(item.id)) {
      const binding = parseBinding(text);
      // A stored key that types text never fires from a text field, whatever brought it there.
      if (!binding || (typing && !typingSafe(binding))) continue;
      const score = bindingScore(binding, native, mac);
      if (score > bestScore) { best = item.id; bestScore = score; }
    }
  }
  return best;
}

// Labels use Latin keycaps, as printed on most keyboards: "⌘ ⇧ G" on a Mac, "Ctrl+Shift+G" elsewhere.
const keyNames = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Minus: '−' };
const keyName = code => isLetter(code) ? code.slice(3) : keyNames[code] || (Object.hasOwn(typed, code) ? typed[code][0] : code);
export function bindingLabel(binding, mac) {
  const parsed = parseBinding(binding);
  if (!parsed) return '';
  // Shifted punctuation reads as its character: Shift+Slash is "?".
  const shiftedChar = parsed.shift && Object.hasOwn(punctuation, parsed.code), key = shiftedChar ? punctuation[parsed.code][1] : keyName(parsed.code), shift = parsed.shift && !shiftedChar;
  const mods = mac ? [parsed.mod && '⌘', parsed.ctrl && '⌃', parsed.alt && '⌥', shift && '⇧'] : [(parsed.mod || parsed.ctrl) && 'Ctrl', parsed.alt && 'Alt', shift && 'Shift'];
  return [...mods.filter(Boolean), key].join(mac ? ' ' : '+');
}
export const bindingsLabel = (bindings, mac) => bindings.map(binding => bindingLabel(binding, mac)).filter(Boolean).join(' / ');
export const shortcutHint = (id, overrides = active, mac = platformIsMac()) => bindingLabel(currentBindings(id, overrides, mac)[0], mac);
export const withShortcut = (text, id, overrides = active, mac = platformIsMac()) => { const hint = shortcutHint(id, overrides, mac); return hint ? `${text} · ${hint}` : text; };

// The help list: what each visible entry does and the keys in force.
export const shortcutRows = (overrides = active, mac = platformIsMac()) => shortcutRegistry.filter(item => !item.hidden).map(item => ({
  id: item.id, label: item.label, group: item.group, fixed: item.fixed, display: !!item.display,
  keys: item.display ? item.display[mac ? 'mac' : 'other'] : bindingsLabel(currentBindings(item.id, overrides, mac), mac)
}));
// The defaults in the "Mod+Shift+Z" notation of shortcutLabel, kept for code that still reads that list.
const legacyKey = binding => {
  const parsed = parseBinding(binding), shiftedChar = parsed.shift && Object.hasOwn(punctuation, parsed.code);
  return [parsed.mod && 'Mod', parsed.ctrl && 'Ctrl', parsed.alt && 'Alt', parsed.shift && !shiftedChar && 'Shift', shiftedChar ? punctuation[parsed.code][1] : isLetter(parsed.code) || Object.hasOwn(typed, parsed.code) ? keyName(parsed.code) : parsed.code].filter(Boolean).join('+');
};
export const keyboardShortcuts = shortcutRegistry.filter(item => !item.hidden).map(item => ({ id: item.id, keys: item.display ? item.display.other : item.bindings.map(legacyKey).join(' / '), label: item.label, group: item.group }));

// Conflicts: the prompt editor shares keys with the canvas (Mod+D works in both), the fullscreen viewer has its own, and
// global keys work everywhere. Only bindings that would fire on the same press conflict; on a Mac, Ctrl and ⌘ differ.
const domain = scope => scope === 'prompt' ? 'canvas' : scope;
const overlap = (a, b) => a === 'global' || b === 'global' || domain(a) === domain(b);
export function findShortcutConflict(id, binding, overrides = active, mac = platformIsMac()) {
  const target = byId.get(id);
  if (!target) return null;
  const resolved = resolveBindings(overrides, mac);
  for (const item of shortcutRegistry) {
    if (item.id === id || !overlap(item.scope, target.scope)) continue;
    if (resolved.get(item.id).some(other => sameBinding(other, binding, mac))) return { id: item.id, label: item.label, fixed: item.fixed };
  }
  return null;
}

// Turns a key press in the Settings recorder into a binding. Returns null while only modifiers are held. Given the action's
// id it also refuses, for actions that run while typing, keys that would type into a prompt.
const modifierKeys = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock']);
const blockedCodes = new Set(['Tab', 'Space', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
export function recordBinding(event, mac = platformIsMac(), { id, overrides = active } = {}) {
  const native = event?.nativeEvent || event, key = String(native.key ?? '');
  if (native.isComposing || key === 'Process' || native.keyCode === 229 || modifierKeys.has(key)) return null;
  let { shiftKey: shift, altKey: alt, ctrlKey: ctrl, metaKey: meta } = native, code;
  const char = characters.get(key), altGraph = ctrl && alt;
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (char && Object.hasOwn(typed, native.code) && char.code !== native.code && !altGraph) {
    // A punctuation or digit key that types another US character on this layout (Ukrainian "/" types "."): the key itself
    // is recorded, so the shortcut stays on it after a switch to English. When that character already triggers another
    // action, which would win on this layout, the character is recorded instead and Settings asks about the clash.
    code = native.code;
    const typedBinding = formatBinding({ mod: mac ? !!meta : !!(ctrl || meta), ctrl: mac && !!ctrl, alt: !!alt, shift: char.shift, code: char.code });
    if (id && findShortcutConflict(id, typedBinding, overrides, mac)) { code = char.code; shift = char.shift; }
  }
  // A letter key typing punctuation (AZERTY "?" on M) or AltGr brackets record the character, as they are matched by it.
  else if (char) { code = char.code; shift = char.shift; if (altGraph) ctrl = alt = false; }
  else if (key === ' ') code = 'Space';
  else if (Object.hasOwn(named, key)) code = key;
  else if (validCode(native.code) && !Object.hasOwn(named, native.code)) code = native.code;
  if (!code) return { error: 'unsupported' };
  const binding = formatBinding({ mod: mac ? !!meta : !!(ctrl || meta), ctrl: mac && !!ctrl, alt: !!alt, shift: !!shift, code });
  const parsed = parseBinding(binding);
  if (blockedCodes.has(code) || (code === 'Enter' && !parsed.mod && !parsed.ctrl && !parsed.alt)) return { error: 'blocked', binding };
  // Browsers keep these for tabs, windows and quitting, and never pass them to the page.
  if ((parsed.mod && !parsed.alt && ['KeyW', 'KeyT', 'KeyN'].includes(code)) || (mac && parsed.mod && code === 'KeyQ') || (!mac && parsed.alt && code === 'F4')) return { error: 'reserved', binding };
  if (id && byId.get(id)?.inText && !typingSafe(parsed)) return { error: 'typing', binding };
  return { binding };
}

// Wrappers for the handlers that predate the registry.
export const isHelpShortcut = (event, ctx) => matchShortcut(event, { ...ctx, scopes: ['global'], ids: ['help'] }) === 'help';
const layerIds = { 'layer.front': 'front', 'layer.forward': 'forward', 'layer.backward': 'backward', 'layer.back': 'back' };
export const layerShortcut = (event, ctx) => layerIds[matchShortcut(event, { editing: false, ...ctx, scopes: ['canvas'], ids: Object.keys(layerIds) })] || null;
