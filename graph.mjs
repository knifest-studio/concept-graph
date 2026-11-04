import { isAnnotation, validColor, validateAnnotation, validateAuthor, boardAuthor, annotationSize, canAttachStamp, detachMissingStampTargets, reconcileStampAttachments } from './src/annotations.mjs';
import { boardPages, defaultPageId, pageContent, pageResolver, resolvePage, validatePages, validPageId } from './src/pages.mjs';
import { layerIndex, maxLayer, nextLayer, topLayer, validLayer } from './src/layers.mjs';

const assetPattern = /^[\da-f-]{36}\.(png|jpg|webp|gif)$/;
export const generationSettings = Object.freeze({ model: 'gpt-6-luna', effort: 'low' });
export const templatePalette = Object.freeze(['#7c3aed', '#2563eb', '#0f766e', '#b45309', '#be185d', '#b91c1c', '#4d7c0f', '#4338ca', '#0369a1', '#9a3412']);

export function templateColor(template) {
  if (templatePalette.includes(template?.color)) return template.color;
  let hash = 0;
  for (const letter of template?.name || template?.id || '') hash = (hash * 31 + letter.codePointAt(0)) >>> 0;
  return templatePalette[hash % templatePalette.length];
}

export function nextTemplateColor(templates) {
  const counts = templatePalette.map(color => templates.filter(template => templateColor(template) === color).length);
  return templatePalette[counts.indexOf(Math.min(...counts))];
}

export function templateSnapshot(template) {
  return { name: template.name, instructions: template.instructions, assets: [...template.assets], color: templateColor(template) };
}

export function validateTemplate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80
    || typeof value.instructions !== 'string' || value.instructions.length > 100000
    || !Array.isArray(value.assets) || value.assets.length > 10 || !value.assets.every(asset => typeof asset === 'string' && assetPattern.test(asset))
    || (value.labelOutputs !== undefined && typeof value.labelOutputs !== 'boolean')
    || (value.color !== undefined && !templatePalette.includes(value.color))) {
    throw new Error('Invalid custom node template.');
  }
  return { name: value.name.trim(), instructions: value.instructions, assets: [...value.assets], ...(value.labelOutputs === true ? { labelOutputs: true } : {}), ...(value.color === undefined ? {} : { color: value.color }) };
}

// Large team boards hold tens of thousands of images; these bounds only stop runaway or hostile documents.
export const maxNodes = 250000, maxEdges = 500000;
export function validateGraph(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('Invalid canvas.');
  if (value.nodes.length > maxNodes || value.edges.length > maxEdges) throw new Error('Canvas is too large.');
  if (value.pages !== undefined) validatePages(value.pages);
  const ids = new Set(), page = pageResolver(boardPages(value));
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length > 120 || ids.has(node.id)) throw new Error('Invalid or duplicate node.');
    ids.add(node.id);
    if (!['text', 'image', 'drawing', 'sticky', 'stamp'].includes(node.type) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)
      || !node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error('Invalid node.');
    if (node.page !== undefined && !validPageId(node.page)) throw new Error('Invalid node page.');
    if (node.z !== undefined && !validLayer(node.z)) throw new Error('Invalid node layer.');
    if (isAnnotation(node)) validateAnnotation(node);
    if (node.data.author !== undefined) validateAuthor(node.data.author);
    if (node.data?.collapsed !== undefined && typeof node.data.collapsed !== 'boolean') throw new Error('Invalid node collapse state.');
    if (node.data?.createdAt !== undefined && (typeof node.data.createdAt !== 'string' || !Number.isFinite(Date.parse(node.data.createdAt)))) throw new Error('Invalid node creation time.');
    if (node.type === 'text' && (typeof node.data?.text !== 'string' || node.data.text.length > 100000)) throw new Error('Invalid text.');
    if (node.type === 'text' && node.data.model !== undefined && (typeof node.data.model !== 'string' || !/^[\w.\/:+-]{1,128}$/.test(node.data.model))) throw new Error('Invalid model.');
    if (node.type === 'text' && node.data.effort !== undefined && (typeof node.data.effort !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(node.data.effort))) throw new Error('Invalid reasoning effort.');
    if (node.type === 'text' && node.data.template !== undefined) validateTemplate(node.data.template);
    if (node.type === 'text' && node.data.labelOutputs !== undefined && typeof node.data.labelOutputs !== 'boolean') throw new Error('Invalid image caption setting.');
    if (node.type === 'image' && !assetPattern.test(node.data?.asset || '')) throw new Error('Invalid image asset.');
    if (node.type === 'image' && node.data.caption !== undefined && (typeof node.data.caption !== 'string' || node.data.caption.length > 120)) throw new Error('Invalid image caption.');
    if (node.type === 'image' && node.data.aspect !== undefined && (!Number.isFinite(node.data.aspect) || node.data.aspect < 0.1 || node.data.aspect > 10)) throw new Error('Invalid image aspect.');
  }
  const edgeIds = new Set(), byId = new Map(value.nodes.map(node => [node.id, node]));
  for (const node of value.nodes) {
    const parent = node.type === 'stamp' && node.data.attachedTo !== undefined && byId.get(node.data.attachedTo);
    if (parent !== false && (!canAttachStamp(parent) || page(parent.page) !== page(node.page))) throw new Error('Invalid stamp attachment target.');
  }
  for (const edge of value.edges) {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error('Invalid connection.');
    if (isAnnotation(byId.get(edge.source)) || isAnnotation(byId.get(edge.target))) throw new Error('Annotations cannot have connections.');
    if (page(byId.get(edge.source).page) !== page(byId.get(edge.target).page)) throw new Error('Connections cannot span pages.');
    edgeIds.add(edge.id);
  }
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > value.nodes.length) throw new Error('Invalid groups.');
    const groupIds = new Set(), members = new Set();
    for (const group of value.groups) {
      if (!group || typeof group.id !== 'string' || !group.id || group.id.length > 120 || ids.has(group.id) || groupIds.has(group.id)
        || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || typeof group.collapsed !== 'boolean'
        || (group.color !== undefined && !validColor(group.color))
        || !Array.isArray(group.nodeIds) || !group.nodeIds.length) throw new Error('Invalid group.');
      groupIds.add(group.id);
      for (const id of group.nodeIds) {
        if (!ids.has(id) || members.has(id)) throw new Error('A node can belong to only one group.');
        if (page(byId.get(id).page) !== page(byId.get(group.nodeIds[0]).page)) throw new Error('Groups cannot span pages.');
        members.add(id);
      }
    }
  }
  if (value.viewport && !['x', 'y', 'zoom'].every(key => Number.isFinite(value.viewport[key]))) throw new Error('Invalid viewport.');
  // Every connection must remain acyclic, including image provenance.
  const incoming = new Map(value.nodes.map(n => [n.id, []]));
  value.edges.forEach(edge => incoming.get(edge.target).push(edge.source));
  // Iterative, so a chain of thousands of generations cannot overflow the call stack.
  const state = new Map();
  for (const node of value.nodes) {
    if (state.has(node.id)) continue;
    const stack = [[node.id, 0]]; state.set(node.id, 'visiting');
    while (stack.length) {
      const top = stack.at(-1), sources = incoming.get(top[0]);
      if (top[1] === sources.length) { state.set(top[0], 'done'); stack.pop(); continue; }
      const source = sources[top[1]++];
      if (state.get(source) === 'visiting') throw new Error('Connections cannot form a loop.');
      if (!state.has(source)) { state.set(source, 'visiting'); stack.push([source, 0]); }
    }
  }
  return value;
}

export function duplicateNodes(graph, nodeIds, { offset = { x: 40, y: 40 }, ids = new Map(nodeIds.map(id => [id, crypto.randomUUID()])), edgeIds = new Map(), createdAt = new Date().toISOString() } = {}) {
  const originals = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodeIds.some(id => !originals.has(id))) throw new Error('Node not found.');
  // Copies go on top of the board in their original stacking order.
  const top = topLayer(graph.nodes), rank = layerIndex(nodeIds.map(id => originals.get(id)));
  const nodes = nodeIds.map(id => {
    const node = originals.get(id);
    const data = { ...structuredClone(node.data), createdAt };
    if (node.type === 'stamp' && data.attachedTo !== undefined) {
      if (ids.has(data.attachedTo)) data.attachedTo = ids.get(data.attachedTo);
      else delete data.attachedTo;
    }
    return { id: ids.get(id), type: node.type, position: { x: node.position.x + offset.x, y: node.position.y + offset.y }, data, ...(node.page === undefined ? {} : { page: node.page }), z: Math.min(maxLayer, top + rank.get(id)) };
  });
  const edges = graph.edges.filter(edge => ids.has(edge.target)).map(edge => {
    if (!edgeIds.has(edge.id)) edgeIds.set(edge.id, crypto.randomUUID());
    return { id: edgeIds.get(edge.id), source: ids.get(edge.source) || edge.source, target: ids.get(edge.target) };
  });
  validateGraph(graph);
  if (nodes.some(node => originals.has(node.id))) throw new Error('Invalid or duplicate node.');
  // A clipboard source is not the destination board; validate copies with their external parents.
  validateGraph({ pages: graph.pages, nodes: detachMissingStampTargets([...graph.nodes.filter(node => !ids.has(node.id)), ...nodes]), edges });
  return { nodes, edges };
}

export function collectInputs(graph, nodeId) {
  validateGraph(graph);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const target = nodes.get(nodeId);
  if (target?.type !== 'text' || (!target.data.text.trim() && !target.data.template?.instructions.trim())) throw new Error('Write an image prompt first.');
  // Only directly connected nodes are sent; their own ancestors are not, to keep runs small.
  const ordered = [...new Set(graph.edges.filter(edge => edge.target === nodeId).map(edge => edge.source))].map(id => nodes.get(id)).concat(target);
  const images = ordered.flatMap(node => node.type === 'image' ? [{ asset: node.data.asset, label: node.data.caption || node.data.label || 'Reference image' }]
    : (node.data.template?.assets || []).map(asset => ({ asset, label: `${node.data.template.name} reference` })));
  if (images.length > 10) throw new Error('Use at most 10 connected reference images per run.');
  const context = ordered.filter(node => node.type === 'text' && node.id !== nodeId && (node.data.text.trim() || node.data.template?.instructions.trim()));
  const textFor = node => [node.data.template?.instructions.trim() ? `Custom node instructions:\n${node.data.template.instructions}` : '', node.data.text.trim() ? node.data.text : ''].filter(Boolean).join('\n\n');
  const prompt = [
    'Generate images for the final request. Earlier text is context, not additional jobs. The final request takes priority over older instructions.',
    ...context.map((node, i) => `Earlier context ${i + 1}:\n${textFor(node)}`),
    images.length ? 'Attached images, in order:\n' + images.map((image, i) => `Image ${i + 1}: ${image.label}`).join('\n') : '',
    `FINAL REQUEST:\n${textFor(target)}`,
    'Return actual images with the built-in image tool. If multiple images are requested, generate each separately. Do not use a paid API fallback.',
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new Error('Connected text is too long. Disconnect some context.');
  return { prompt, images: images.map(image => image.asset), snapshot: structuredClone(ordered), target: structuredClone(target) };
}

export function imageNode(run, asset, index, dimensions) {
  const aspect = dimensions && dimensions.height / dimensions.width;
  const author = boardAuthor(run.by);
  return {
    id: crypto.randomUUID(), type: 'image',
    position: { x: run.target.position.x + 390, y: run.target.position.y + index * 340 },
    data: { asset, label: `Result ${index + 1}`, runId: run.id, createdAt: new Date().toISOString(), ...(author ? { author } : {}), ...(aspect >= 0.1 && aspect <= 10 ? { aspect } : {}) },
  };
}

export async function commitGraph(graph, next, persist) {
  const previous = { nodes: graph.nodes, edges: graph.edges, groups: graph.groups, pages: graph.pages, viewport: graph.viewport, revision: graph.revision };
  const revision = graph.revision + 1;
  const assign = value => { Object.assign(graph, value); if (graph.pages === undefined) delete graph.pages; };
  assign({ nodes: next.nodes, edges: next.edges, groups: next.groups, pages: next.pages, viewport: next.viewport || graph.viewport, revision });
  try { await persist(); } catch (error) { assign(previous); throw error; }
  return revision;
}

export function reconcileStampGraph(before, next) {
  const nodes = reconcileStampAttachments(before.nodes, next.nodes), retained = new Set(nodes.map(node => node.id));
  const removed = new Set(next.nodes.filter(node => !retained.has(node.id)).map(node => node.id));
  const groups = removed.size && Array.isArray(next.groups) ? next.groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => !removed.has(id)) })).filter(group => group.nodeIds.length) : next.groups;
  return { ...next, nodes, ...(groups === undefined ? {} : { groups }) };
}

export function groupRunOutputs(graph, run, newOutputId) {
  const grouped = new Set((graph.groups || []).flatMap(group => group.nodeIds)), page = runOutputPage(graph, run), resolve = pageResolver(boardPages(graph));
  // A run whose page was deleted continues on the first page; a group never spans both.
  const existing = new Set(graph.nodes.filter(node => node.type === 'image' && resolve(node.page) === page).map(node => node.id));
  // Once the user removes this group, never recreate it during the same run.
  if (run.autoGroupId) {
    const group = (graph.groups || []).find(item => item.id === run.autoGroupId);
    if (!group || !newOutputId || !run.outputIds.includes(newOutputId) || !existing.has(newOutputId) || grouped.has(newOutputId)) return false;
    group.nodeIds.push(newOutputId);
    graph.revision++;
    return true;
  }
  const outputs = [...new Set(run.outputIds.filter(id => existing.has(id) && !grouped.has(id)))];
  if (outputs.length < 2) return false;
  const groups = graph.groups ||= [];
  const names = new Set(groups.map(group => group.name));
  let number = 1; while (names.has(`Group ${number}`)) number++;
  const id = crypto.randomUUID();
  groups.push({ id, name: `Group ${number}`, nodeIds: outputs, collapsed: false });
  run.autoGroupId = id;
  graph.revision++;
  return true;
}

export const captionHeight = node => node.type === 'image' && !node.data?.collapsed && node.data?.caption?.trim() ? 24 : 0;
export const nodeSize = node => isAnnotation(node) ? annotationSize(node) : node.data?.collapsed === true ? { width: 72, height: 72 }
  : { width: node.measured?.width || 310, height: node.measured?.height || (node.type === 'text' ? 80 : 310 * (node.data?.aspect || 1)) };

// Outputs stay on the page frozen when the run was submitted, or the first page if it is gone.
export const runOutputPage = (graph, run) => resolvePage(boardPages(graph), run.page ?? defaultPageId);
export function positionRunOutput(node, graph, run) {
  const page = runOutputPage(graph, run), scoped = { ...graph, ...pageContent(graph, page) };
  if (page === defaultPageId) delete node.page; else node.page = page;
  // Each new result appears above everything already on the board.
  node.z = nextLayer(graph.nodes);
  const nodes = new Map(scoped.nodes.map(item => [item.id, item]));
  const previous = run.outputIds.map(id => nodes.get(id)).filter(Boolean);
  if (!previous.length) return positionFirstOutput(node, scoped);
  node.position = { x: previous[0].position.x, y: Math.max(...previous.map(item => item.position.y + nodeSize(item).height)) + 30 + captionHeight(node) };
}

// Leave room for the first result and its frame without jumping past distant content.
export function positionFirstOutput(node, graph) {
  const bounds = graph.nodes.map(item => ({ id: item.id, x: item.position.x, y: item.position.y - captionHeight(item), width: nodeSize(item).width, height: nodeSize(item).height + captionHeight(item) }));
  const byId = new Map(bounds.map(item => [item.id, item]));
  for (const group of graph.groups || []) {
    const members = group.nodeIds.map(id => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const x = Math.min(...members.map(item => item.x)) - 24, y = Math.min(...members.map(item => item.y)) - 72;
    bounds.push({ x, y, width: Math.max(...members.map(item => item.x + item.width)) - x + 24, height: Math.max(...members.map(item => item.y + item.height)) - y + 24 });
  }
  const obstacles = bounds.filter(box => box.x < node.position.x + 334 && box.x + box.width > node.position.x - 24).sort((a, b) => a.y - b.y);
  for (const box of obstacles) {
    if (box.y < node.position.y + nodeSize(node).height + 24 && box.y + box.height > node.position.y - 72) node.position.y = box.y + box.height + 72;
  }
}

// Read only image headers; usable with both browser Uint8Arrays and Node Buffers.
export function imageSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset, text) => offset + text.length <= bytes.length && [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const dimensions = (width, height) => width > 0 && height > 0 ? { width, height } : undefined;
  if (bytes.length >= 24 && tag(0, '\x89PNG\r\n\x1a\n') && tag(12, 'IHDR')) return dimensions(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && (tag(0, 'GIF87a') || tag(0, 'GIF89a'))) return dimensions(view.getUint16(6, true), view.getUint16(8, true));
  if (tag(0, 'RIFF') && tag(8, 'WEBP')) {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length > bytes.length) return;
      const uint24 = at => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      if (tag(offset, 'VP8X') && length >= 10) return dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
      if (tag(offset, 'VP8 ') && length >= 10 && tag(start + 3, '\x9d\x01\x2a')) return dimensions(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff);
      if (tag(offset, 'VP8L') && length >= 5 && bytes[start] === 0x2f) {
        const bits = view.getUint32(start + 1, true);
        return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      offset = start + length + (length % 2);
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) return dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      offset += length;
    }
  }
}

export function imageFormat(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Use a PNG, JPEG, WebP or GIF image.');
}
