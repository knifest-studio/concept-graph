// Pages split one board document into separate canvases; storage, history and limits stay board-wide.
export const defaultPageId = 'page-1';
export const maxPages = 100;
export const defaultPages = () => [{ id: defaultPageId, name: 'Page 1' }];
export const boardPages = graph => Array.isArray(graph?.pages) && graph.pages.length ? graph.pages : defaultPages();
export const validPageId = value => typeof value === 'string' && value.length > 0 && value.length <= 120;

export function pageName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new Error('Page names must contain 1–80 characters.');
  return value.trim();
}

export function validatePages(pages) {
  if (!Array.isArray(pages) || !pages.length || pages.length > maxPages) throw new Error('Invalid pages.');
  const ids = new Set();
  for (const page of pages) {
    if (!page || typeof page !== 'object' || Array.isArray(page) || !validPageId(page.id) || ids.has(page.id) || Object.keys(page).some(key => !['id', 'name'].includes(key))
      || typeof page.name !== 'string' || !page.name || page.name !== page.name.trim() || page.name.length > 80) throw new Error('Invalid page.');
    ids.add(page.id);
  }
  return pages;
}

// A missing page means the reserved first page; a page deleted concurrently shows its nodes on the first page.
export function pageResolver(pages) {
  const ids = new Set(pages.map(page => page.id)), first = pages[0].id;
  return value => ids.has(value ?? defaultPageId) ? value ?? defaultPageId : first;
}
export const resolvePage = (pages, pageId) => pageResolver(pages)(pageId);
export const nodePage = (node, pages) => pageResolver(pages)(node?.page);
export const pageField = pageId => pageId === defaultPageId ? {} : { page: pageId };
export function assignPage(node, pageId) {
  const { page, ...rest } = node;
  return { ...rest, ...pageField(pageId) };
}

export function pageContent(graph, pageId, pages = boardPages(graph)) {
  const resolve = pageResolver(pages), nodes = graph.nodes.filter(node => resolve(node.page) === pageId), ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)), groups: (graph.groups || []).filter(group => group.nodeIds.some(id => ids.has(id))),
    ...(graph.sections ? { sections: graph.sections.filter(section => resolve(section.page) === pageId) } : {}) };
}

export function samePage(graph, a, b) {
  const resolve = pageResolver(boardPages(graph));
  return !!a && !!b && resolve(a.page) === resolve(b.page);
}

export function nextPageName(pages) {
  const names = new Set(pages.map(page => page.name));
  let number = pages.length + 1;
  while (names.has(`Page ${number}`)) number++;
  return `Page ${number}`;
}

// Untouched single-page boards store no page list, so older apps can still open them.
export const storedPages = (pages, saved) => saved === undefined && JSON.stringify(pages) === JSON.stringify(defaultPages()) ? undefined : pages;
export const hasPageData = graph => graph.pages !== undefined || graph.nodes.some(node => node.page !== undefined) || (graph.runs || []).some(run => run.page !== undefined) || (graph.sections || []).some(section => section.page !== undefined);

// Accept pages another editor added or renamed without undoing local deletions or renames.
export function mergePages(local, remote, base) {
  const known = new Map(base.map(page => [page.id, page])), incoming = new Map(remote.map(page => [page.id, page])), mine = new Set(local.map(page => page.id));
  const result = local.map(page => {
    const before = known.get(page.id), theirs = incoming.get(page.id);
    return before && theirs && page.name === before.name && theirs.name !== before.name ? { ...page, name: theirs.name } : page;
  });
  for (const page of remote) if (!known.has(page.id) && !mine.has(page.id)) result.push(page);
  return result;
}

// Agents name the page for unanchored creation on multi-page boards; existing nodes imply theirs.
export function targetPage(graph, pageId, nodeIds = []) {
  const pages = boardPages(graph), resolve = pageResolver(pages), byId = new Map(graph.nodes.map(node => [node.id, node]));
  const list = pages.map(page => `${page.id} (${page.name})`).join(', ');
  if (pageId !== undefined && !pages.some(page => page.id === pageId)) throw new Error(`Page not found: ${pageId}. Pages: ${list}.`);
  const found = [...new Set(nodeIds.filter(id => byId.has(id)).map(id => resolve(byId.get(id).page)))];
  if (found.length > 1) throw new Error('These nodes are on different pages.');
  if (found.length) {
    if (pageId !== undefined && pageId !== found[0]) throw new Error(`The nodes are on page ${found[0]}, not ${pageId}.`);
    return found[0];
  }
  if (pageId !== undefined) return pageId;
  if (pages.length > 1) throw new Error(`This board has ${pages.length} pages; pass pageId. Pages: ${list}.`);
  return pages[0].id;
}

// Each person keeps their own page and per-page viewport; storage failures fall back to the first page.
export function readPagePreference(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || 'null'), viewports = {};
    for (const [id, view] of Object.entries(value?.viewports || {}).slice(0, maxPages)) {
      if (validPageId(id) && ['x', 'y', 'zoom'].every(name => Number.isFinite(view?.[name])) && view.zoom > 0) viewports[id] = { x: view.x, y: view.y, zoom: view.zoom };
    }
    return { page: validPageId(value?.page) ? value.page : defaultPageId, viewports };
  } catch { return { page: defaultPageId, viewports: {} }; }
}

export function writePagePreference(storage, key, { page, viewports }, pages) {
  const ids = new Set(pages.map(item => item.id));
  try { storage.setItem(key, JSON.stringify({ page, viewports: Object.fromEntries(Object.entries(viewports).filter(([id]) => ids.has(id))) })); } catch {}
}

export const peersOnPage = (peers, pages, pageId) => peers.filter(peer => resolvePage(pages, peer.page) === pageId);
