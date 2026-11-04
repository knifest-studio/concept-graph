import { validColor } from './annotations.mjs';
import { validPageId } from './pages.mjs';

// Sections are named, coloured background frames on a page, like FigJam's. Each stores only its own rectangle: what it
// holds is worked out from positions when it moves or is deleted, so nothing stores membership and concurrent edits
// never conflict over it.
export const maxSections = 2000, maxSectionSize = 1e6;
export const sectionMinimum = Object.freeze({ width: 200, height: 120 }), sectionDefault = Object.freeze({ width: 640, height: 400 });
// Room around wrapped content; the top leaves space for the title.
export const sectionPadding = Object.freeze({ side: 40, top: 72 });
export const sectionPalette = Object.freeze(['#e9e2ff', '#dceaff', '#dcf3ef', '#e4f2d4', '#fff3cd', '#ffe5d5', '#fbddec', '#e7e9ef']);

const validName = value => typeof value === 'string' && !!value.trim() && value.length <= 80;
const validSize = (value, minimum) => Number.isFinite(value) && value >= minimum && value <= maxSectionSize;

// `taken(id)` is true for the board's node and group IDs: React Flow needs every ID on the canvas to be unique.
export function validateSections(sections, taken = () => false) {
  if (!Array.isArray(sections) || sections.length > maxSections) throw new Error('Invalid sections.');
  const ids = new Set();
  for (const section of sections) {
    if (!section || typeof section !== 'object' || Array.isArray(section) || typeof section.id !== 'string' || !section.id || section.id.length > 120 || ids.has(section.id) || taken(section.id)
      || !validName(section.name) || !Number.isFinite(section.x) || !Number.isFinite(section.y) || !validSize(section.width, sectionMinimum.width) || !validSize(section.height, sectionMinimum.height)
      || (section.color !== undefined && !validColor(section.color)) || (section.page !== undefined && !validPageId(section.page))) throw new Error('Invalid section.');
    ids.add(section.id);
  }
  return sections;
}

export const cleanSections = (sections = []) => sections.map(({ id, name, x, y, width, height, color, page }) => ({ id, name, x, y, width, height, ...(color === undefined ? {} : { color }), ...(page === undefined ? {} : { page }) }));

export function nextSectionName(sections) {
  const names = new Set(sections.map(section => section.name));
  let number = 1; while (names.has(`Section ${number}`)) number++;
  return `Section ${number}`;
}

// A section written by another replica is shown even when a value is out of range, so one bad field cannot hide it.
export function readSection(id, value) {
  if (typeof id !== 'string' || !id || id.length > 120 || !value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)) return null;
  const name = validName(value.name) ? value.name : (typeof value.name === 'string' && value.name.trim().slice(0, 80).trim()) || 'Section';
  const size = (number, minimum) => Math.min(maxSectionSize, Math.max(minimum, number));
  return { id, name, x: value.x, y: value.y, width: size(value.width, sectionMinimum.width), height: size(value.height, sectionMinimum.height),
    ...(validColor(value.color) ? { color: value.color } : {}), ...(validPageId(value.page) ? { page: value.page } : {}) };
}

const fields = ['name', 'x', 'y', 'width', 'height', 'color', 'page'];
// Accept sections another editor added or changed without undoing local edits or deletions.
export function mergeSections(local, remote, base) {
  const known = new Map(base.map(section => [section.id, section])), incoming = new Map(remote.map(section => [section.id, section])), mine = new Set(local.map(section => section.id));
  const result = local.map(section => {
    const before = known.get(section.id), theirs = incoming.get(section.id);
    if (!before || !theirs) return section;
    let next = section;
    for (const key of fields) {
      if (section[key] !== before[key] || theirs[key] === before[key]) continue;
      if (next === section) next = { ...section };
      if (theirs[key] === undefined) delete next[key]; else next[key] = theirs[key];
    }
    return next;
  });
  for (const section of remote) if (!known.has(section.id) && !mine.has(section.id)) result.push(section);
  return result;
}
