// What an agent connected over MCP may do. It acts as the person who connected it, with that person's role on each
// board. Board tools run inside the board's room (BoardRoom.mcp), so every edit reaches the people on the board at once.
import { alignNodes, captureSections, detachArrows, estimatedSize, moveCaptured, moveGroup, pruneGroups, sectionContents, wrapBounds } from '../src/canvas.mjs';
import { arrowPalette, boardAuthor, canAttachArrow, canAttachStamp, drawingFromStroke, penPalette, penWidths, reconcileArrows, shapeDefault, shapeKinds, shapePalette, shiftArrow, stamps, stickyPalette, arrowPosition } from '../src/annotations.mjs';
import { describeTask, duplicateNodes, generators, imageSize, maxUpscaleImages, maxVariants, reconcileStampGraph, templatePalette, templateSnapshot, upscalers, upscaleTask, validateGraph, imageName, uniqueImageName } from '../graph.mjs';
import { boardPages, defaultPages, maxPages, nextPageName, nodePage, pageContent, pageField, pageName, targetPage } from '../src/pages.mjs';
import { maxSections, nextSectionName, sectionDefault, sectionMinimum, sectionPalette } from '../src/sections.mjs';
import { maxLayer, nextLayer } from '../src/layers.mjs';
import { switchNodeTemplate } from '../src/node-template.mjs';
import { upscaleSettings } from './upscale.mjs';

// Expected failures carry `expected`: the agent sees the message, and nothing is logged as a fault.
export const fail = message => { throw Object.assign(new Error(message), { expected: true }); };
const text = (description, extra = {}) => ({ type: 'string', description, ...extra });
const number = (description, extra = {}) => ({ type: 'number', description, ...extra });
const integer = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const boolean = description => ({ type: 'boolean', description });
const array = (description, items, extra = {}) => ({ type: 'array', description, items, ...extra });
const object = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const choice = (description, values) => text(description, { enum: values });
const uuid = '^[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}$';

const boardId = text('Board ID from list_boards', { pattern: uuid });
const itemId = text('Node, connection, group or section ID from get_board', { minLength: 1, maxLength: 120 });
const assetId = text('Image asset ID, as in image nodes or from upload_image', { pattern: '^[\\da-f-]{36}\\.(png|jpg|webp|gif)$' });
const runId = text('Run ID from list_runs', { pattern: uuid });
const templateId = text('Custom node ID from list_templates', { pattern: uuid });
const position = object({ x: number('Canvas x'), y: number('Canvas y') }, ['x', 'y']);
const at = object({ x: number('Canvas x'), y: number('Canvas y') }, ['x', 'y'], { description: 'Top-left corner on the canvas. Omitted, it goes to the right of what the page holds' });
const pageId = text('Page ID from get_board. Needed for new items on boards with several pages; otherwise checked against the nodes', { minLength: 1, maxLength: 120 });
const ids = (description, minItems = 1) => array(description, itemId, { minItems, maxItems: 2000, uniqueItems: true });
const hex = (description, palette) => text(`${description} as #rrggbb${palette ? `; the board's own: ${palette.join(', ')}` : ''}`, { pattern: '^#[0-9a-fA-F]{6}$' });
const layer = number('Layer order on its page; higher draws in front', { minimum: -maxLayer, maximum: maxLayer });
const generator = choice('Who makes the images: codex (the person\'s own Codex, through their open board) or nano-banana (the team\'s Gemini key)', ['codex', generators.nanoBanana]);
const variants = integer(`How many images one run makes, 1–${maxVariants}`, { minimum: 1, maximum: maxVariants });
const end = object({ x: number('Canvas x of a free end'), y: number('Canvas y of a free end'), nodeId: text('Node this end holds on to: a prompt, image, sticky or shape', { minLength: 1, maxLength: 120 }) }, [], { description: 'An arrow end: a node to hold on to, or a point' });
const templateFields = { name: text('Custom node name', { minLength: 1, maxLength: 80 }), instructions: text('Instructions added to every prompt made from it', { maxLength: 100000 }),
  assets: array('Reference image asset IDs, in order', assetId, { maxItems: 10 }), color: hex('Tag colour', templatePalette) };
const graphNode = { ...object({ id: itemId, type: text('text, image, drawing, sticky, stamp, shape or arrow'), position, page: pageId, z: layer, data: { type: 'object', properties: {}, additionalProperties: true } }, ['id', 'type', 'position', 'data']), additionalProperties: true };
const graphEdge = { ...object({ id: itemId, source: itemId, target: itemId }, ['id', 'source', 'target']), additionalProperties: true };
const graphGroup = { ...object({ id: itemId, name: text('Group name', { minLength: 1, maxLength: 80 }), nodeIds: ids('Member node IDs'), collapsed: boolean('Folded'), slideshow: boolean('Folded, shows one image at a time'), slide: text('Image the folded slideshow shows', { minLength: 1, maxLength: 120 }) }, ['id', 'name', 'nodeIds', 'collapsed']), additionalProperties: true };
const graphSection = object({ id: itemId, name: text('Section name', { minLength: 1, maxLength: 80 }), x: number('Left edge'), y: number('Top edge'), width: number('Width', { minimum: sectionMinimum.width }), height: number('Height', { minimum: sectionMinimum.height }), color: hex('Background', sectionPalette), page: pageId }, ['id', 'name', 'x', 'y', 'width', 'height']);
const graphPage = object({ id: text('Page ID', { minLength: 1, maxLength: 120 }), name: text('Page name', { minLength: 1, maxLength: 80 }) }, ['id', 'name']);

export const tools = [];
// `access` is the role a board tool needs: view or edit; account tools are answered by the Worker (cloud/mcp.mjs).
function define(name, description, properties, required, { access = 'edit', account = false, run, prepare, destructive = false } = {}) {
  const board = !account;
  tools.push({ name, description, inputSchema: object(board ? { boardId, ...properties } : properties, board ? ['boardId', ...required] : required),
    annotations: { readOnlyHint: access === 'view', destructiveHint: destructive, idempotentHint: access === 'view', openWorldHint: false }, access, account, run, prepare });
}
export const toolByName = new Map();

export function checkArgs(value, schema, label = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
    for (const key of schema.required || []) if (!(key in value)) fail(`${label}.${key} is required.`);
    for (const [key, item] of Object.entries(value)) {
      if (!(key in schema.properties)) { if (!schema.additionalProperties) fail(`${label}.${key} is not supported.`); continue; }
      checkArgs(item, schema.properties[key], `${label}.${key}`);
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength)
      || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value))) fail(`${label} is invalid.`);
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value)) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) fail(`${label} must be a valid number.`);
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(`${label} must be true or false.`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems) || (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length)) fail(`${label} is invalid.`);
    value.forEach((item, index) => checkArgs(item, schema.items, `${label}[${index}]`));
  }
}

const ensure = (items, wanted, label) => {
  const map = new Map(items.map(item => [item.id, item]));
  for (const id of wanted) if (!map.has(id)) fail(`${label} not found: ${id}`);
  return map;
};
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const sizeOf = node => estimatedSize(node);

// New things go to the right of what the page already holds, unless the agent says where.
function freeSpot(graph, page) {
  const nodes = pageContent(graph, page).nodes;
  if (!nodes.length) return { x: 0, y: 0 };
  let right = -Infinity, top = Infinity;
  for (const node of nodes) { right = Math.max(right, node.position.x + sizeOf(node).width); top = Math.min(top, node.position.y); }
  return { x: Math.round(right + 80), y: Math.round(top) };
}
function addNode(ctx, type, data, page, where, { author = true } = {}) {
  const nodeId = id(), by = author && boardAuthor(ctx.user);
  ctx.graph.nodes.push({ id: nodeId, type, position: where || freeSpot(ctx.graph, page), z: nextLayer(ctx.graph.nodes), data: { ...data, createdAt: now(), ...(by ? { author: by } : {}) }, ...pageField(page) });
  return { nodeId, pageId: page };
}
const node = (ctx, nodeId) => ensure(ctx.graph.nodes, [nodeId], 'Node').get(nodeId);
const centre = item => { const { width, height } = sizeOf(item); return { x: item.position.x + width / 2, y: item.position.y + height / 2 }; };
function setGenerator(data, value) { if (value === generators.nanoBanana) data.generator = value; else delete data.generator; }
function setVariants(data, value) { if (value > 1) data.variants = value; else delete data.variants; }
// What the agent reads: every item with its page, and nodes with the size the canvas gives them before measuring.
const shownNode = (item, pages) => ({ ...item, page: nodePage(item, pages), size: sizeOf(item) });
const runBrief = ({ snapshot, prompt, images, target, diagnostics, ...run }) => run;
const onPage = ({ page, ...item }) => ({ ...item, ...(page === undefined ? {} : pageField(page)) });

// Deleted nodes take their attached stamps along; arrows that held on to them keep that end where it was.
function removeNodes(graph, doomed) {
  for (const item of graph.nodes) if (item.type === 'stamp' && doomed.has(item.data.attachedTo)) doomed.add(item.id);
  const before = graph.nodes;
  graph.nodes = detachArrows(before, before.filter(item => !doomed.has(item.id)));
  graph.edges = graph.edges.filter(edge => !doomed.has(edge.source) && !doomed.has(edge.target));
  graph.groups = pruneGroups(graph.groups || [], graph.nodes);
}

// The image's shape and pixel size, read from the start of its file.
async function imageShape(env, asset) {
  const object = await env.FILES.get(`assets/${asset}`, { range: { offset: 0, length: 256 * 1024 } });
  if (!object) fail(`Image not found: ${asset}. Upload it with upload_image first.`);
  const size = imageSize(new Uint8Array(await object.arrayBuffer()));
  return size?.width && size?.height ? { aspect: Math.min(10, Math.max(0.1, size.height / size.width)), pixels: { width: size.width, height: size.height } } : {};
}
async function assetsExist(env, assets = []) {
  for (const asset of assets) if (!await env.FILES.head(`assets/${asset}`)) fail(`Image not found: ${asset}. Upload it with upload_image first.`);
}
const templateOf = (ctx, value) => ctx.templates.find(item => item.id === value) || fail('Custom node not found. Use list_templates.');

define('whoami', 'Show who this agent is signed in as and whether they may use Nano Banana, with what is left today.', {}, [], { access: 'view', account: true });
define('list_boards', 'List the cloud boards this person can open, newest first, with their role on each (owner, edit or view).', {}, [], { access: 'view', account: true });
define('create_board', 'Create an empty private board owned by this person.', { name: text('Board name', { minLength: 1, maxLength: 80 }) }, ['name'], { account: true });
define('rename_board', 'Rename a board. Only its owner can.', { boardId, name: text('New board name', { minLength: 1, maxLength: 80 }) }, ['boardId', 'name'], { account: true });
define('delete_board', 'Delete a board for everyone. It stays in its owner’s Recently deleted for 30 days, where they can restore it, and is then erased. Only its owner can, and only by repeating its exact current name. Ask the user first.', { boardId, confirmName: text('The board’s exact current name', { minLength: 1, maxLength: 80 }) }, ['boardId', 'confirmName'], { account: true, destructive: true });
define('upload_image', 'Upload a PNG, JPEG, WebP or GIF (at most 20 MB) and get its asset ID for add_image_node or a custom node.', { data: text('The image file, base64-encoded', { minLength: 8, maxLength: 28 * 1024 * 1024 }) }, ['data'], { account: true });
define('get_image', 'Look at images: returns each as image content. Uses the board preview (at most 1024 px) when one exists; pass original for full size.', { assets: array('Image asset IDs from image nodes', assetId, { minItems: 1, maxItems: 6, uniqueItems: true }), original: boolean('Return the original files instead of previews') }, ['assets'], { access: 'view', account: true });

define('get_board', 'Read a board as it is now: pages, nodes (each with its page and estimated size on the canvas), connections, groups, sections, custom nodes and recent generations, plus the revision apply_graph needs. Prompts are text nodes; images are image nodes whose asset get_image shows. A section holds whatever lies inside it and stores no member list.',
  { pageId: text('Only this page', { minLength: 1, maxLength: 120 }), runs: integer('How many recent generations to include (default 20)', { minimum: 0, maximum: 500 }) }, [], { access: 'view', run: ctx => {
    const { graph, args } = ctx, pages = boardPages(graph);
    if (args.pageId !== undefined && !pages.some(page => page.id === args.pageId)) fail(`Page not found: ${args.pageId}.`);
    const nodes = graph.nodes.map(item => shownNode(item, pages)).filter(item => args.pageId === undefined || item.page === args.pageId), kept = new Set(nodes.map(item => item.id));
    return { revision: ctx.revision, pages, nodes, edges: graph.edges.filter(edge => kept.has(edge.source)), groups: (graph.groups || []).filter(group => group.nodeIds.some(item => kept.has(item))),
      sections: (graph.sections || []).map(section => ({ ...section, page: nodePage(section, pages) })).filter(section => args.pageId === undefined || section.page === args.pageId),
      templates: ctx.templates.map(({ id: templateId, name, color }) => ({ id: templateId, name, color })), runCount: graph.runs.length, runs: graph.runs.slice(-(args.runs ?? 20)).map(runBrief) };
  } });
define('list_runs', 'List recent generations with their status, newest last.', { limit: integer('How many (1–200, default 50)', { minimum: 1, maximum: 200 }) }, [], { access: 'view', run: ({ graph, args }) => ({ total: graph.runs.length, runs: graph.runs.slice(-(args.limit || 50)).map(runBrief) }) });
define('get_run', 'Get one generation in full: its prompt, input images, settings, outputs and errors.', { runId }, ['runId'], { access: 'view', run: ({ graph, args }) => graph.runs.find(run => run.id === args.runId) || fail('Generation not found.') });
define('list_templates', 'List the board’s custom nodes: reusable prompts with instructions and reference images.', {}, [], { access: 'view', run: ctx => ({ templates: ctx.templates }) });

define('add_text_node', 'Add a prompt. Connect images or other prompts into it with connect_nodes, then generate with start_run. With describe, it writes a description of the images connected to it instead.',
  { text: text('Prompt text; for a describe node, an optional focus', { maxLength: 100000 }), position: at, pageId, generator, variants, describe: boolean('Make a describe (image-to-text) node') }, ['text'], { run: ctx => {
    const { args } = ctx, data = { text: args.text, ...(args.describe ? { task: describeTask } : {}) };
    setGenerator(data, args.generator); setVariants(data, args.variants);
    return addNode(ctx, 'text', data, targetPage(ctx.graph, args.pageId), args.position, { author: false });
  } });
define('add_upscale_node', 'Add an upscale node fed by images on the board, then run it with start_run: each image comes back larger, beside the node, labelled with its new size. nano-banana redraws it at 2K or 4K (about $0.05 or $0.11); when the site has them on, topaz keeps the image as it is (about $0.08 an image, as in Krea) and seedvr restores detail (about $0.02). scale is 2 or 4 (for nano-banana, 2K or 4K). It runs on the team’s keys within the person’s daily images.',
  { imageIds: array('Images to upscale, on one page', itemId, { minItems: 1, maxItems: maxUpscaleImages, uniqueItems: true }), upscaler: choice('Who upscales', Object.values(upscalers)), scale: integer('2 or 4', { enum: [2, 4], minimum: 2, maximum: 4 }), position: at }, ['imageIds'], { prepare: async (args, env) => ({ fal: upscaleSettings(env).fal }), run: ctx => {
    const { args, graph } = ctx, found = ensure(graph.nodes, args.imageIds, 'Node'), upscaler = args.upscaler || (ctx.prepared.fal ? upscalers.topaz : upscalers.nanoBanana);
    if (upscaler !== upscalers.nanoBanana && !ctx.prepared.fal) fail('Topaz and SeedVR2 are off on this site for now. Use nano-banana.');
    if (args.imageIds.some(nodeId => found.get(nodeId).type !== 'image')) fail('Upscale images only.');
    const page = targetPage(graph, undefined, args.imageIds), source = found.get(args.imageIds[0]);
    const where = args.position || { x: Math.round(source.position.x + sizeOf(source).width + 90), y: Math.round(source.position.y) };
    const added = addNode(ctx, 'text', { text: '', task: upscaleTask, upscaler, scale: args.scale || 2 }, page, where, { author: false });
    for (const nodeId of args.imageIds) graph.edges.push({ id: id(), source: nodeId, target: added.nodeId });
    return added;
  } });
define('add_image_node', 'Put an uploaded image on the board, e.g. as a reference to connect into a prompt.', { asset: assetId, caption: text('Visible image name used to refer to it in prompts', { maxLength: 120 }), label: text('Original file name. Used to derive a name when caption is omitted', { maxLength: 100000 }), position: at, pageId }, ['asset'],
  { prepare: (args, env) => imageShape(env, args.asset), run: ctx => {
    const { args } = ctx, { aspect, pixels } = ctx.prepared;
    return addNode(ctx, 'image', { asset: args.asset, label: args.label || 'Reference image', caption: uniqueImageName(ctx.graph.nodes, args.caption?.trim() || imageName({ data: { label: args.label } })), ...(aspect ? { aspect } : {}), ...(pixels ? { pixels } : {}) }, targetPage(ctx.graph, args.pageId), args.position);
  } });
define('add_template_node', 'Add a prompt made from one of the board’s custom nodes, optionally with extra text.', { templateId, text: text('Extra prompt text', { maxLength: 100000 }), position: at, pageId, generator }, ['templateId'], { run: ctx => {
  const { args } = ctx, data = { text: args.text || '', template: templateSnapshot(templateOf(ctx, args.templateId)) };
  setGenerator(data, args.generator);
  return addNode(ctx, 'text', data, targetPage(ctx.graph, args.pageId), args.position, { author: false });
} });
define('add_sticky', 'Add a sticky note.', { text: text('Note text', { maxLength: 10000 }), color: hex('Colour', stickyPalette), position: at, pageId }, ['text'],
  { run: ctx => addNode(ctx, 'sticky', { text: ctx.args.text, color: ctx.args.color || stickyPalette[0] }, targetPage(ctx.graph, ctx.args.pageId), ctx.args.position) });
define('add_shape', 'Add a shape, optionally with text inside.', { shape: choice('Shape', shapeKinds), text: text('Text inside', { maxLength: 10000 }), width: number('Width, 20–4000', { minimum: 20, maximum: 4000 }), height: number('Height, 20–4000', { minimum: 20, maximum: 4000 }), color: hex('Fill', shapePalette), position: at, pageId }, ['shape'],
  { run: ctx => { const { args } = ctx; return addNode(ctx, 'shape', { shape: args.shape, width: args.width ?? shapeDefault.width, height: args.height ?? shapeDefault.height, color: args.color || shapePalette[0], ...(args.text ? { text: args.text } : {}) }, targetPage(ctx.graph, args.pageId), args.position); } });
define('add_arrow', 'Draw an arrow between two nodes or points. An end that holds on to a node follows it when it moves.', { from: end, to: end, color: hex('Colour', arrowPalette), dashed: boolean('Dashed line'), startArrow: boolean('Arrowhead at the start'), endArrow: boolean('Arrowhead at the end (default true)'), pageId }, ['from', 'to'], { run: ctx => {
  const { args, graph } = ctx, held = [args.from.nodeId, args.to.nodeId].filter(Boolean), page = targetPage(graph, args.pageId, held), byId = ensure(graph.nodes, held, 'Node');
  const point = value => {
    if (value.nodeId !== undefined) { const target = byId.get(value.nodeId); if (!canAttachArrow(target)) fail('Arrows can hold on to prompts, images, stickies and shapes.'); return { node: target.id, ...centre(target) }; }
    if (value.x === undefined || value.y === undefined) fail('Give each arrow end a nodeId or both x and y.');
    return { x: value.x, y: value.y };
  };
  const from = point(args.from), to = point(args.to);
  return addNode(ctx, 'arrow', { from, to, color: args.color || arrowPalette[0], ...(args.dashed ? { dashed: true } : {}), ...(args.startArrow ? { startArrow: true } : {}), ...(args.endArrow === false ? { endArrow: false } : {}) }, page, arrowPosition(from, to));
} });
define('add_stamp', `Put a reaction stamp on a node (it follows the node) or at a point. Kinds: ${Object.entries(stamps).map(([kind, emoji]) => `${kind} ${emoji}`).join(', ')}.`, { kind: choice('Stamp', Object.keys(stamps)), nodeId: text('Node to stamp: a prompt, image, sticky or shape', { minLength: 1, maxLength: 120 }), position: at, pageId }, ['kind'], { run: ctx => {
  const { args, graph } = ctx;
  if (args.nodeId === undefined) return addNode(ctx, 'stamp', { kind: args.kind }, targetPage(graph, args.pageId), args.position);
  const target = node(ctx, args.nodeId);
  if (!canAttachStamp(target)) fail('Stamps can go on prompts, images, stickies and shapes.');
  const { width } = sizeOf(target);
  return addNode(ctx, 'stamp', { kind: args.kind, attachedTo: target.id }, targetPage(graph, args.pageId, [target.id]), args.position || { x: target.position.x + width - 30, y: target.position.y - 18 });
} });
define('add_drawing', 'Draw a freehand line through points on the canvas.', { points: array('Points in canvas coordinates, in drawing order', array('[x, y]', number('Coordinate'), { minItems: 2, maxItems: 2 }), { minItems: 1, maxItems: 5000 }), color: hex('Pen colour', penPalette), width: number(`Line width, 1–24; the board's own: ${penWidths.join(', ')}`, { minimum: 1, maximum: 24 }), pageId }, ['points'], { run: ctx => {
  const { args } = ctx;
  let drawing;
  try { drawing = drawingFromStroke(args.points, args.color || penPalette[0], args.width || penWidths[1]); }
  catch { fail('That drawing is too large or has invalid points.'); }
  return addNode(ctx, 'drawing', drawing.data, targetPage(ctx.graph, args.pageId), drawing.position, { author: false });
} });

define('update_node', 'Change a node: move it, restack it, fold it, or edit what its type has (prompt text, generator and variants; image caption and label; sticky, shape and arrow text, colour and style; stamp kind).',
  { nodeId: itemId, pageId, position, z: layer, collapsed: boolean('Folded'), text: text('Prompt, sticky or shape text', { maxLength: 100000 }), generator, variants, describe: boolean('Prompt describes its images instead of making new ones'),
    caption: text('Image caption; empty clears it', { maxLength: 120 }), label: text('Image label', { maxLength: 100000 }), color: hex('Sticky, shape, arrow or drawing colour'), shape: choice('Shape', shapeKinds),
    width: number('Shape width', { minimum: 20, maximum: 4000 }), height: number('Shape height', { minimum: 20, maximum: 4000 }), dashed: boolean('Dashed arrow'), startArrow: boolean('Arrowhead at the start'), endArrow: boolean('Arrowhead at the end'), kind: choice('Stamp', Object.keys(stamps)) }, ['nodeId'], { run: ctx => {
    const { args, graph } = ctx, item = node(ctx, args.nodeId), data = item.data, type = item.type;
    targetPage(graph, args.pageId, [item.id]);
    const only = (key, types) => { if (args[key] !== undefined && !types.includes(type)) fail(`${key} does not apply to a ${type} node.`); return args[key] !== undefined; };
    if (args.position) {
      if (type === 'arrow') item.data = shiftArrow(data, args.position.x - item.position.x, args.position.y - item.position.y);
      item.position = args.position;
    }
    if (args.z !== undefined) item.z = args.z;
    if (args.collapsed !== undefined) item.data.collapsed = args.collapsed;
    if (only('text', ['text', 'sticky', 'shape'])) { if (type === 'shape' && !args.text) delete item.data.text; else item.data.text = args.text; }
    if (only('generator', ['text'])) setGenerator(item.data, args.generator);
    if (only('variants', ['text'])) setVariants(item.data, args.variants);
    if (only('describe', ['text'])) { if (args.describe) item.data.task = describeTask; else delete item.data.task; }
    if (only('caption', ['image'])) { if (args.caption) item.data.caption = args.caption; else delete item.data.caption; }
    if (only('label', ['image'])) item.data.label = args.label;
    if (only('color', ['sticky', 'shape', 'arrow', 'drawing'])) item.data.color = args.color;
    if (only('shape', ['shape'])) item.data.shape = args.shape;
    if (only('width', ['shape'])) item.data.width = args.width;
    if (only('height', ['shape'])) item.data.height = args.height;
    for (const key of ['dashed', 'startArrow']) if (only(key, ['arrow'])) { if (args[key]) item.data[key] = true; else delete item.data[key]; }
    if (only('endArrow', ['arrow'])) { if (args.endArrow) delete item.data.endArrow; else item.data.endArrow = false; }
    if (only('kind', ['stamp'])) item.data.kind = args.kind;
    return { nodeId: item.id };
  } });
define('delete_nodes', 'Delete nodes with their connections and attached stamps. Images stay in storage and generation history.', { nodeIds: ids('Node IDs'), pageId }, ['nodeIds'], { destructive: true, run: ctx => {
  const { args, graph } = ctx;
  ensure(graph.nodes, args.nodeIds, 'Node');
  if (args.pageId !== undefined) targetPage(graph, args.pageId, args.nodeIds);
  removeNodes(graph, new Set(args.nodeIds));
  return { deleted: args.nodeIds.length };
} });
define('duplicate_nodes', 'Copy nodes from one page with their connections between them and from their inputs; the copies get new IDs and stay on that page.', { nodeIds: ids('Node IDs'), offset: position, pageId }, ['nodeIds'], { run: ctx => {
  const { args, graph } = ctx;
  ensure(graph.nodes, args.nodeIds, 'Node'); targetPage(graph, args.pageId, args.nodeIds);
  const newIds = new Map(args.nodeIds.map(item => [item, id()])), copies = duplicateNodes(graph, args.nodeIds, { offset: args.offset, ids: newIds, createdAt: now() });
  let z = nextLayer(graph.nodes);
  graph.nodes.push(...copies.nodes.map(copy => ({ ...copy, z: z++ }))); graph.edges.push(...copies.edges);
  return { nodeIds: Object.fromEntries(newIds), edgeIds: copies.edges.map(edge => edge.id) };
} });
define('connect_nodes', 'Connect a prompt or image into a prompt on the same page, so the target uses it when it generates. Loops are refused.', { source: itemId, target: itemId }, ['source', 'target'], { run: ctx => {
  const { args, graph } = ctx, found = ensure(graph.nodes, [args.source, args.target], 'Node');
  targetPage(graph, undefined, [args.source, args.target]);
  if (!['text', 'image'].includes(found.get(args.source).type) || found.get(args.target).type !== 'text') fail('Connect a prompt or image into a prompt.');
  if (graph.edges.some(edge => edge.source === args.source && edge.target === args.target)) fail('That connection already exists.');
  const edgeId = id();
  graph.edges.push({ id: edgeId, source: args.source, target: args.target });
  return { edgeId };
} });
define('delete_edges', 'Delete connections.', { edgeIds: ids('Connection IDs') }, ['edgeIds'], { destructive: true, run: ({ args, graph }) => {
  ensure(graph.edges, args.edgeIds, 'Connection');
  const doomed = new Set(args.edgeIds);
  graph.edges = graph.edges.filter(edge => !doomed.has(edge.id));
  return { deleted: args.edgeIds.length };
} });
define('create_group', 'Group two or more nodes on one page. A node belongs to one group at most.', { name: text('Group name', { minLength: 1, maxLength: 80 }), nodeIds: ids('Node IDs', 2), collapsed: boolean('Fold it'), slideshow: boolean('Folded, show one image at a time') }, ['name', 'nodeIds'], { run: ({ args, graph }) => {
  ensure(graph.nodes, args.nodeIds, 'Node'); targetPage(graph, undefined, args.nodeIds);
  const groupId = id();
  (graph.groups ||= []).push({ id: groupId, name: args.name.trim(), nodeIds: args.nodeIds, collapsed: !!args.collapsed, ...(args.slideshow ? { slideshow: true } : {}) });
  return { groupId };
} });
define('update_group', 'Rename, fold, unfold or move a group, make it a slideshow or not, or pick the image its folded slideshow shows.', { groupId: itemId, name: text('Group name', { minLength: 1, maxLength: 80 }), collapsed: boolean('Folded'), slideshow: boolean('Folded, show one image at a time'), slide: text('Image in this group for the folded slideshow', { minLength: 1, maxLength: 120 }), position: object({ x: number('Canvas x'), y: number('Canvas y') }, ['x', 'y'], { description: 'New top-left corner of the group' }) }, ['groupId'], { run: ({ args, graph }) => {
  const group = ensure(graph.groups || [], [args.groupId], 'Group').get(args.groupId);
  if (args.slide !== undefined && (!group.nodeIds.includes(args.slide) || graph.nodes.find(item => item.id === args.slide)?.type !== 'image')) fail('Pick an image from this group.');
  if (args.position) graph.nodes = reconcileArrows(graph.nodes, moveGroup(graph.nodes, group, args.position));
  if (args.name !== undefined) group.name = args.name.trim();
  if (args.collapsed !== undefined) group.collapsed = args.collapsed;
  if (args.slideshow !== undefined) { if (args.slideshow) group.slideshow = true; else { delete group.slideshow; delete group.slide; } }
  if (args.slide !== undefined) group.slide = args.slide;
  return { groupId: group.id };
} });
define('ungroup', 'Remove a group, keeping its nodes.', { groupId: itemId }, ['groupId'], { run: ({ args, graph }) => {
  ensure(graph.groups || [], [args.groupId], 'Group');
  graph.groups = graph.groups.filter(group => group.id !== args.groupId);
  return { groupId: args.groupId };
} });
define('align_board', 'Arrange one page left to right by its connections. Sizes are estimated, so check the result with get_board.', { pageId }, [], { run: ({ args, graph }) => {
  const page = targetPage(graph, args.pageId), scoped = pageContent(graph, page), aligned = new Map(alignNodes(scoped.nodes, scoped.edges, scoped.groups).map(item => [item.id, item]));
  graph.nodes = graph.nodes.map(item => aligned.get(item.id) || item);
  return { nodes: scoped.nodes.length, pageId: page };
} });

define('add_page', 'Add a page to the board. Pages are separate canvases on one board.', { name: text('Page name', { minLength: 1, maxLength: 80 }) }, [], { run: ({ args, graph }) => {
  const pages = boardPages(graph);
  if (pages.length >= maxPages) fail(`A board can have at most ${maxPages} pages.`);
  const page = { id: id(), name: args.name === undefined ? nextPageName(pages) : pageName(args.name) };
  graph.pages = [...(graph.pages || defaultPages()), page];
  return { pageId: page.id, name: page.name };
} });
define('rename_page', 'Rename a page.', { pageId: text('Page ID', { minLength: 1, maxLength: 120 }), name: text('Page name', { minLength: 1, maxLength: 80 }) }, ['pageId', 'name'], { run: ({ args, graph }) => {
  const pages = boardPages(graph);
  if (!pages.some(page => page.id === args.pageId)) fail(`Page not found: ${args.pageId}.`);
  graph.pages = pages.map(page => page.id === args.pageId ? { ...page, name: pageName(args.name) } : page);
  return { pageId: args.pageId };
} });
define('delete_page', 'Delete a page with everything on it. A board keeps at least one page. Ask the user first.', { pageId: text('Page ID', { minLength: 1, maxLength: 120 }) }, ['pageId'], { destructive: true, run: ({ args, graph }) => {
  const pages = boardPages(graph);
  if (!pages.some(page => page.id === args.pageId)) fail(`Page not found: ${args.pageId}.`);
  if (pages.length === 1) fail('A board needs at least one page.');
  const content = pageContent(graph, args.pageId, pages), doomed = new Set(content.nodes.map(item => item.id));
  removeNodes(graph, doomed);
  if (graph.sections) graph.sections = graph.sections.filter(section => nodePage(section, pages) !== args.pageId);
  graph.pages = pages.filter(page => page.id !== args.pageId);
  return { pageId: args.pageId, deletedNodes: doomed.size };
} });

define('create_section', 'Add a section: a named background frame. Give its rectangle, or nodes, groups and sections to put inside it. Whatever lies inside a section moves with it.',
  { name: text('Section name', { minLength: 1, maxLength: 80 }), around: ids('Node, group or section IDs to wrap'), x: number('Left edge'), y: number('Top edge'), width: number('Width', { minimum: sectionMinimum.width }), height: number('Height', { minimum: sectionMinimum.height }), color: hex('Background', sectionPalette), pageId }, [], { run: ({ args, graph }) => {
    const sections = graph.sections || [];
    if (sections.length >= maxSections) fail(`A board can have at most ${maxSections} sections.`);
    let page, rect;
    if (args.around) {
      const known = new Set([...graph.nodes, ...(graph.groups || []), ...sections].map(item => item.id)), missing = args.around.find(item => !known.has(item));
      if (missing) fail(`Not found: ${missing}`);
      const members = graph.nodes.filter(item => args.around.includes(item.id) || (graph.groups || []).some(group => args.around.includes(group.id) && group.nodeIds.includes(item.id)));
      page = targetPage(graph, args.pageId, members.map(item => item.id));
      rect = wrapBounds(pageContent(graph, page), new Set(args.around));
    } else {
      page = targetPage(graph, args.pageId);
      const spot = args.x === undefined || args.y === undefined ? freeSpot(graph, page) : { x: args.x, y: args.y };
      rect = { x: spot.x, y: spot.y, width: args.width ?? sectionDefault.width, height: args.height ?? sectionDefault.height };
    }
    if (!rect) fail('Nothing to wrap.');
    const section = { id: id(), name: args.name?.trim() || nextSectionName(sections), ...rect, ...(args.color ? { color: args.color } : {}), ...pageField(page) };
    graph.sections = [...sections, section];
    return { sectionId: section.id, pageId: page, x: section.x, y: section.y, width: section.width, height: section.height };
  } });
define('update_section', 'Rename, recolour, resize or move a section. Moving it moves what lies inside it.', { sectionId: itemId, name: text('Section name', { minLength: 1, maxLength: 80 }), color: text('Background as #rrggbb; empty for the neutral default', { pattern: '^(#[0-9a-fA-F]{6})?$' }), position: object({ x: number('Left edge'), y: number('Top edge') }, ['x', 'y'], { description: 'New top-left corner' }), width: number('Width', { minimum: sectionMinimum.width }), height: number('Height', { minimum: sectionMinimum.height }) }, ['sectionId'], { run: ({ args, graph }) => {
  const section = ensure(graph.sections || [], [args.sectionId], 'Section').get(args.sectionId), pages = boardPages(graph);
  if (args.position) {
    const capture = captureSections(pageContent(graph, nodePage(section, pages), pages), new Set([section.id]));
    const moved = moveCaptured({ nodes: graph.nodes, sections: graph.sections }, capture, { x: args.position.x - section.x, y: args.position.y - section.y });
    graph.nodes = reconcileArrows(graph.nodes, moved.nodes); graph.sections = moved.sections;
  }
  const current = graph.sections.find(item => item.id === section.id);
  if (args.name !== undefined) current.name = args.name.trim();
  if (args.color !== undefined) { if (args.color) current.color = args.color; else delete current.color; }
  if (args.width !== undefined) current.width = args.width;
  if (args.height !== undefined) current.height = args.height;
  return { sectionId: section.id };
} });
define('delete_section', 'Delete a section. What lies inside it stays, unless withContents is true.', { sectionId: itemId, withContents: boolean('Also delete the nodes and sections inside it') }, ['sectionId'], { destructive: true, run: ({ args, graph }) => {
  const section = ensure(graph.sections || [], [args.sectionId], 'Section').get(args.sectionId), pages = boardPages(graph);
  let doomed = new Set([section.id]), nodes = 0;
  if (args.withContents) {
    const contents = sectionContents(pageContent(graph, nodePage(section, pages), pages), new Set([section.id]));
    doomed = contents.sectionIds; nodes = contents.nodeIds.size;
    removeNodes(graph, new Set(contents.nodeIds));
  }
  graph.sections = graph.sections.filter(item => !doomed.has(item.id));
  return { deletedSections: doomed.size, deletedNodes: nodes };
} });

define('apply_graph', 'Replace the board’s nodes, connections and groups in one step, for large rearrangements. First call get_board and pass its revision; if anyone changed the board since, nothing is applied. Everything left out is deleted. Pass pages or sections to replace those lists too; leave them out to keep them. Generation history stays.',
  { revision: text('Revision from a fresh get_board', { minLength: 1, maxLength: 64 }), nodes: array('Every node', graphNode, { maxItems: 20000 }), edges: array('Every connection', graphEdge, { maxItems: 50000 }), groups: array('Every group', graphGroup, { maxItems: 20000 }),
    pages: array('Every page, in order', graphPage, { minItems: 1, maxItems: maxPages }), sections: array('Every section', graphSection, { maxItems: maxSections }) }, ['revision', 'nodes', 'edges', 'groups'], { destructive: true, run: ctx => {
    const { args, graph } = ctx;
    if (args.revision !== ctx.revision) fail('The board changed since that get_board. Read it again before replacing it.');
    graph.nodes = args.nodes.map(({ size, ...item }) => onPage(item));
    graph.edges = args.edges; graph.groups = args.groups;
    if (args.pages) graph.pages = args.pages.map(page => ({ id: page.id, name: pageName(page.name) }));
    if (args.sections) graph.sections = args.sections.map(onPage);
    return { applied: true };
  } });

define('create_template', 'Save a custom node on this board: instructions and reference images that every prompt made from it carries.', templateFields, ['name', 'instructions', 'assets'],
  { prepare: (args, env) => assetsExist(env, args.assets), run: ctx => ({ template: ctx.saveTemplate({ name: ctx.args.name, instructions: ctx.args.instructions, assets: ctx.args.assets, ...(ctx.args.color ? { color: ctx.args.color } : {}) }) }) });
define('update_template', 'Change a custom node. Prompts already made from it keep their own copy.', { templateId, ...templateFields }, ['templateId'], { prepare: (args, env) => assetsExist(env, args.assets), run: ctx => {
  const existing = templateOf(ctx, ctx.args.templateId), { templateId: _, ...changes } = ctx.args;
  return { template: ctx.saveTemplate({ name: existing.name, instructions: existing.instructions, assets: existing.assets, color: existing.color, ...changes }, existing) };
} });
define('delete_template', 'Delete a custom node. Prompts already made from it keep their own copy.', { templateId }, ['templateId'], { destructive: true, run: ctx => { templateOf(ctx, ctx.args.templateId); ctx.deleteTemplate(ctx.args.templateId); return { deleted: ctx.args.templateId }; } });
define('set_node_template', 'Turn a prompt into one made from a custom node, keeping its text, place and connections.', { nodeId: itemId, templateId }, ['nodeId', 'templateId'], { run: ctx => {
  const item = node(ctx, ctx.args.nodeId), template = templateOf(ctx, ctx.args.templateId);
  if (item.type !== 'text') fail('Only prompts can use a custom node.');
  ctx.graph.nodes = ctx.graph.nodes.map(value => value.id === item.id ? switchNodeTemplate(value, template) : value);
  return { nodeId: item.id };
} });
define('clear_node_template', 'Turn a prompt made from a custom node back into a plain prompt, keeping its text, place and connections.', { nodeId: itemId }, ['nodeId'], { run: ctx => {
  const item = node(ctx, ctx.args.nodeId);
  if (item.type !== 'text') fail('Only prompts can use a custom node.');
  ctx.graph.nodes = ctx.graph.nodes.map(value => value.id === item.id ? switchNodeTemplate(value, null) : value);
  return { nodeId: item.id };
} });
define('start_run', 'Generate from a prompt, as the person’s Generate button would. Nano Banana runs on the team’s Gemini key within their daily allowance. Codex runs on the person’s own computer: the board must be open in their browser with the helper connected (and their Codex, or a teammate’s they were granted, ready); that tab starts it. The images (or, for a describe node, the description) appear beside the prompt; poll get_run for the status.', { nodeId: itemId }, ['nodeId']);
define('list_versions', 'List the board’s saved versions, newest first: a copy every ten minutes while it changes, one kept just before any large deletion or restore, and a daily backup. Each says when, why, how many nodes and images it held, and who edited.', { limit: integer('How many (1–500, default 50)', { minimum: 1, maximum: 500 }) }, [], { access: 'view' });
define('restore_version', 'Put the whole board back as it was in a saved version, for everyone. The board as it is now is saved first, so this can be undone by restoring that copy. Generation history is kept. Ask the user first.', { versionId: text('Version ID from list_versions', { minLength: 1, maxLength: 64 }) }, ['versionId'], { destructive: true });
define('cancel_run', 'Stop a generation this person started. A Codex run is stopped through their open board. Images that already arrived stay.', { runId }, ['runId'], { destructive: true });
for (const tool of tools) toolByName.set(tool.name, tool);

export const listedTools = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));

// A board changes on every edit anywhere; apply_graph compares this to refuse a replacement built from an older read.
export function revisionOf(stateVector) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of stateVector) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

// One tool on one board, all at once: the graph is read, changed and checked in the same turn, so nobody's edit lands
// in between. `ctx` comes from the room: graph, templates, revision and the template writers.
export function runBoardTool(tool, ctx) {
  if (tool.access === 'view') return { result: tool.run(ctx) };
  const before = ctx.graph;
  ctx.graph = structuredClone(before);
  const result = tool.run(ctx);
  const graph = reconcileStampGraph(before, ctx.graph);
  try { validateGraph(graph); }
  catch (cause) { fail(`That would leave the board invalid: ${cause.message}`); }
  return { result, graph };
}
