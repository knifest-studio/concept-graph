import { nextTemplateColor, validateTemplate } from '../graph.mjs';

// In cloud mode a board's custom nodes live in its document, one plain value per template (the last write wins), so they
// sync live and follow the board's access. The desktop app keeps its own library.
export const maxBoardTemplates = 500;
const compare = new Intl.Collator().compare;
const templates = doc => doc.getMap('templates');

// Values another replica wrote that are not valid templates are skipped.
export function readBoardTemplates(doc) {
  const list = [];
  for (const [id, value] of templates(doc)) {
    try { list.push({ id, ...validateTemplate(value), createdAt: typeof value.createdAt === 'string' ? value.createdAt : '' }); } catch {}
  }
  return list.sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
}

export function saveBoardTemplate(doc, value, existing, origin) {
  const current = readBoardTemplates(doc), clean = validateTemplate(value);
  if (!existing && current.length >= maxBoardTemplates) throw new Error(`A board can have at most ${maxBoardTemplates} custom nodes.`);
  const template = existing ? { id: existing.id, ...clean, color: clean.color || existing.color, createdAt: existing.createdAt }
    : { id: crypto.randomUUID(), ...clean, color: clean.color || nextTemplateColor(current), createdAt: new Date().toISOString() };
  doc.transact(() => templates(doc).set(template.id, template), origin);
  return template;
}

export function deleteBoardTemplate(doc, id, origin) {
  doc.transact(() => templates(doc).delete(id), origin);
}

export function importBoardTemplates(doc, values, origin) {
  const current = readBoardTemplates(doc), clean = values.map(validateTemplate);
  if (current.length + clean.length > maxBoardTemplates) throw new Error(`A board can have at most ${maxBoardTemplates} custom nodes.`);
  const copies = clean.map(value => {
    const template = { ...value, id: crypto.randomUUID(), color: value.color || nextTemplateColor(current), createdAt: new Date().toISOString() };
    current.push(template);
    return template;
  });
  doc.transact(() => { for (const template of copies) templates(doc).set(template.id, template); }, origin);
  return copies;
}

export const libraryCopied = doc => doc.getMap('meta').get('libraryCopied') === true;

// A board made before custom nodes belonged to boards copies the old team library once; the mark stays in the board.
export function copyLibrary(doc, library, origin) {
  if (libraryCopied(doc)) return false;
  doc.transact(() => {
    for (const template of library) if (typeof template?.id === 'string' && !templates(doc).has(template.id)) templates(doc).set(template.id, template);
    doc.getMap('meta').set('libraryCopied', true);
  }, origin);
  return true;
}
