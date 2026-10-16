export function validateGraph(value) {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error('Invalid canvas.');
  if (value.nodes.length > 2000 || value.edges.length > 10000) throw new Error('Canvas is too large.');
  const ids = new Set();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || node.id.length > 120 || ids.has(node.id)) throw new Error('Invalid or duplicate node.');
    ids.add(node.id);
    if (!['text', 'image'].includes(node.type) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y)) throw new Error('Invalid node.');
    if (node.type === 'text' && (typeof node.data?.text !== 'string' || node.data.text.length > 100000)) throw new Error('Invalid text.');
    if (node.type === 'image' && !/^[\da-f-]{36}\.(png|jpg|webp|gif)$/.test(node.data?.asset || '')) throw new Error('Invalid image asset.');
  }
  const edgeIds = new Set();
  for (const edge of value.edges) {
    if (!edge || typeof edge.id !== 'string' || edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target) throw new Error('Invalid connection.');
    edgeIds.add(edge.id);
  }
  if (value.groups !== undefined) {
    if (!Array.isArray(value.groups) || value.groups.length > value.nodes.length) throw new Error('Invalid groups.');
    const groupIds = new Set(), members = new Set();
    for (const group of value.groups) {
      if (!group || typeof group.id !== 'string' || !group.id || group.id.length > 120 || ids.has(group.id) || groupIds.has(group.id)
        || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80 || typeof group.collapsed !== 'boolean'
        || !Array.isArray(group.nodeIds) || !group.nodeIds.length) throw new Error('Invalid group.');
      groupIds.add(group.id);
      for (const id of group.nodeIds) {
        if (!ids.has(id) || members.has(id)) throw new Error('A node can belong to only one group.');
        members.add(id);
      }
    }
  }
  if (value.viewport && !['x', 'y', 'zoom'].every(key => Number.isFinite(value.viewport[key]))) throw new Error('Invalid viewport.');
  // Every connection must remain acyclic, including image provenance.
  const incoming = new Map(value.nodes.map(n => [n.id, []]));
  value.edges.forEach(edge => incoming.get(edge.target).push(edge.source));
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Connections cannot form a loop.');
    if (visited.has(id)) return;
    visiting.add(id);
    incoming.get(id).forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  value.nodes.forEach(node => visit(node.id));
  return value;
}

export function collectInputs(graph, nodeId) {
  validateGraph(graph);
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const target = nodes.get(nodeId);
  if (target?.type !== 'text' || !target.data.text.trim()) throw new Error('Write an image prompt first.');
  const ordered = [], seen = new Set();
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const edge of graph.edges.filter(e => e.target === id)) walk(edge.source);
    ordered.push(nodes.get(id));
  }
  walk(nodeId);
  const images = ordered.filter(node => node.type === 'image');
  if (images.length > 10) throw new Error('Use at most 10 connected reference images per run.');
  const context = ordered.filter(node => node.type === 'text' && node.id !== nodeId && node.data.text.trim());
  const prompt = [
    'Generate images for the final request. Earlier text is context, not additional jobs. The final request takes priority over older instructions.',
    ...context.map((node, i) => `Earlier context ${i + 1}:\n${node.data.text}`),
    images.length ? 'Attached images, in order:\n' + images.map((node, i) => `Image ${i + 1}: ${node.data.label || 'Reference image'}`).join('\n') : '',
    `FINAL REQUEST:\n${target.data.text}`,
    'Return actual images with the built-in image tool. If multiple images are requested, generate each separately. Do not use a paid API fallback.',
  ].filter(Boolean).join('\n\n');
  if (prompt.length > 150000) throw new Error('Connected text is too long. Disconnect some context.');
  return { prompt, images: images.map(n => n.data.asset), snapshot: structuredClone(ordered), target: structuredClone(target) };
}

export function imageNode(run, asset, index) {
  return {
    id: crypto.randomUUID(), type: 'image',
    position: { x: run.target.position.x + 390, y: run.target.position.y + index * 340 },
    data: { asset, label: `Result ${index + 1}`, runId: run.id, createdAt: new Date().toISOString() },
  };
}

export function imageFormat(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('Use a PNG, JPEG, WebP or GIF image.');
}
