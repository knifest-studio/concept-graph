import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { exportBoardArchive, importBoardArchive } from '../board-archive.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=', 'base64');
const current = '11111111-1111-1111-1111-111111111111.png', historical = '22222222-2222-2222-2222-222222222222.png';
const unused = '33333333-3333-3333-3333-333333333333.png';
const text = { id: 'prompt', type: 'text', position: { x: -20, y: 75 }, data: { text: 'The exact original request' } };
const input = { id: 'reference', type: 'image', position: { x: -400, y: 10 }, data: { asset: current, label: 'Current reference' } };
const removed = { id: 'removed-reference', type: 'image', position: { x: 10, y: -50 }, data: { asset: historical, label: 'Historical reference' } };
const board = { id: 'original-board', name: 'My saved board', createdAt: '2026-10-15T12:00:00.000Z', graph: {
  revision: 81, nodes: [input, text, { id: 'output', type: 'image', position: { x: 370, y: 75 }, data: { asset: current, label: 'Result 1', runId: 'completed-run' } }],
  edges: [{ id: 'input-edge', source: 'reference', target: 'prompt' }, { id: 'output-edge', source: 'prompt', target: 'output' }],
  groups: [{ id: 'group', name: 'Folded ideas', nodeIds: ['reference', 'prompt'], collapsed: true }], viewport: { x: -10, y: 45, zoom: .72 },
  runs: [{ id: 'completed-run', nodeId: 'prompt', status: 'completed', createdAt: '2026-10-15T12:00:00.000Z', finishedAt: '2026-10-15T12:01:00.000Z',
    outputIds: ['output'], images: [current, historical], snapshot: [input, removed, text], target: text, prompt: 'Immutable full instructions', label: 'Original request' }],
} };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-archive-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source'), destination = path.join(directory, 'destination');
  await mkdir(source); await mkdir(destination);
  await writeFile(path.join(source, current), png);
  await writeFile(path.join(source, historical), Buffer.concat([png, Buffer.from('historical-original-bytes')]));
  await writeFile(path.join(source, unused), png);
  return { directory, source, destination };
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); }
async function unpack(bytes) {
  const zip = await yauzl.fromBufferPromise(bytes);
  const files = new Map();
  for await (const entry of zip.eachEntry()) files.set(entry.fileName, await collect(await zip.openReadStreamPromise(entry)));
  return files;
}
async function pack(files, options = {}) {
  const zip = new yazl.ZipFile();
  for (const [name, bytes] of files) zip.addBuffer(bytes, name, options);
  zip.end(); return collect(zip.outputStream);
}

test('format 4 round trips annotations, group fills and author metadata; older versions cannot silently carry them', async t => {
  const { source, destination } = await fixture(t), saved = structuredClone(board);
  saved.graph.groups[0].color = '#e9e2ff';
  const author = { name: 'Artist', color: '#2563eb' }; saved.graph.nodes[2].data.author = author;
  const annotations = [
    { id: 'drawing', type: 'drawing', position: { x: 0, y: 0 }, data: { points: [[4, 4], [40, 30]], color: '#2563eb', width: 4 } },
    { id: 'sticky', type: 'sticky', position: { x: 50, y: 50 }, z: 3, data: { text: 'A note', color: '#fff3ad', author } },
    { id: 'stamp', type: 'stamp', position: { x: 100, y: 200 }, z: -2, data: { kind: 'heart', author, attachedTo: 'sticky' } },
  ];
  saved.graph.nodes.push(...annotations);
  const archive = await collect(await exportBoardArchive(saved, source)), files = await unpack(archive), manifest = JSON.parse(files.get('board.json'));
  assert.equal(manifest.version, 4);
  const imported = await importBoardArchive(archive, destination);
  assert.deepEqual(imported.graph.nodes.slice(-3), annotations); assert.deepEqual(imported.graph.nodes[2].data.author, author);
  assert.deepEqual(imported.graph.groups, saved.graph.groups);
  manifest.version = 3; files.set('board.json', Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(importBoardArchive(await pack(files), destination), /annotations or author/);
});

test('portable board round trip retains graph/history/groups and original images without overwriting destination assets', async t => {
  const { directory, source, destination } = await fixture(t), before = structuredClone(board);
  const existing = Buffer.concat([png, Buffer.from('another board owns this filename')]);
  await writeFile(path.join(destination, current), existing);
  const archive = await collect(await exportBoardArchive(board, source)), files = await unpack(archive);
  assert.deepEqual([...files.keys()].sort(), ['board.json', `assets/${current}`, `assets/${historical}`].sort());
  const manifest = JSON.parse(files.get('board.json'));
  assert.equal(manifest.version, 1); assert.equal(manifest.format, 'concept-graph-board');
  assert.deepEqual(manifest.board.graph, board.graph);
  const imported = await importBoardArchive(archive, destination);
  const remap = new Map([[current, imported.graph.nodes[0].data.asset], [historical, imported.graph.runs[0].images[1]]]);
  assert.equal(imported.name, board.name); assert.equal(imported.graph.revision, 0);
  assert.equal(imported.assets.length, 2); assert.equal(new Set(imported.assets).size, 2);
  for (const [oldName, newName] of remap) {
    assert.notEqual(newName, oldName);
    assert.deepEqual(await readFile(path.join(destination, newName)), await readFile(path.join(source, oldName)));
  }
  assert.deepEqual(await readFile(path.join(destination, current)), existing);
  const normalized = structuredClone(imported.graph), reverse = new Map([...remap].map(([a, b]) => [b, a]));
  for (const node of [...normalized.nodes, ...normalized.runs[0].snapshot]) if (node.type === 'image') node.data.asset = reverse.get(node.data.asset);
  normalized.runs[0].images = normalized.runs[0].images.map(asset => reverse.get(asset)); normalized.revision = 81;
  assert.deepEqual(normalized, board.graph); assert.deepEqual(board, before);
  assert.deepEqual((await readdir(directory)).sort(), ['destination', 'source']);
});

test('empty boards round trip and unfinished imported jobs never resume', async t => {
  const { source, destination } = await fixture(t);
  const empty = { ...board, graph: { revision: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, runs: [] } };
  assert.deepEqual((await importBoardArchive(await collect(await exportBoardArchive(empty, source)), destination)).graph, empty.graph);
  const pending = structuredClone(board); pending.graph.runs[0].status = 'running'; delete pending.graph.runs[0].finishedAt;
  const imported = await importBoardArchive(await collect(await exportBoardArchive(pending, source)), destination);
  assert.equal(imported.graph.runs[0].status, 'cancelled');
  assert.match(imported.graph.runs[0].message, /unfinished/);
  assert.equal(pending.graph.runs[0].status, 'running');
});

test('invalid archives, missing/history images, checksums and malformed history leave existing data intact', async t => {
  const { directory, source, destination } = await fixture(t);
  await writeFile(path.join(destination, current), png);
  const originalFiles = await unpack(await collect(await exportBoardArchive(board, source)));
  await assert.rejects(importBoardArchive(Buffer.from('not a zip'), destination), /damaged/);
  const invalid = [Buffer.from('not a zip'), Buffer.from('PK')];
  const version = new Map(originalFiles), future = JSON.parse(version.get('board.json')); future.version = 6;
  version.set('board.json', Buffer.from(JSON.stringify(future))); invalid.push(await pack(version));
  const missing = new Map(originalFiles); missing.delete(`assets/${historical}`); invalid.push(await pack(missing));
  const corrupt = new Map(originalFiles); corrupt.set(`assets/${historical}`, Buffer.alloc(corrupt.get(`assets/${historical}`).length)); invalid.push(await pack(corrupt));
  const badHistory = new Map(originalFiles), bad = JSON.parse(badHistory.get('board.json')); bad.board.graph.runs[0].snapshot[1].data.asset = '../../outside.png';
  badHistory.set('board.json', Buffer.from(JSON.stringify(bad))); invalid.push(await pack(badHistory));
  const extra = new Map(originalFiles); extra.set('credentials.json', Buffer.from('{}')); invalid.push(await pack(extra));
  invalid.push(await pack([...originalFiles, ['board.json', originalFiles.get('board.json')]]));
  for (const bytes of invalid) {
    await assert.rejects(importBoardArchive(bytes, destination));
    assert.deepEqual(await readdir(destination), [current]);
    assert.deepEqual(await readFile(path.join(destination, current)), png);
    assert.deepEqual((await readdir(directory)).sort(), ['destination', 'source']);
  }
});

test('caption-aware board archives preserve labels and opt-ins in live nodes and run snapshots', async t => {
  const { source, destination } = await fixture(t), labeled = structuredClone(board);
  labeled.graph.nodes[1].data.labelOutputs = true;
  labeled.graph.nodes[2].data.caption = 'Front view';
  labeled.graph.runs[0].snapshot[1].data.caption = 'Back view';
  labeled.graph.runs[0].target.data.labelOutputs = true;
  const bytes = await collect(await exportBoardArchive(labeled, source)), files = await unpack(bytes);
  const manifest = JSON.parse(files.get('board.json'));
  assert.equal(manifest.version, 3);
  const imported = await importBoardArchive(bytes, destination);
  assert.equal(imported.graph.nodes[1].data.labelOutputs, true);
  assert.equal(imported.graph.nodes[2].data.caption, 'Front view');
  assert.equal(imported.graph.runs[0].snapshot[1].data.caption, 'Back view');
  assert.equal(imported.graph.runs[0].target.data.labelOutputs, true);
  for (const version of [1, 2]) {
    manifest.version = version; files.set('board.json', Buffer.from(JSON.stringify(manifest)));
    await assert.rejects(importBoardArchive(await pack(files), destination), /image captions.*newer board format/);
  }
  const disabled = structuredClone(board);
  disabled.graph.nodes[1].data.labelOutputs = false;
  disabled.graph.nodes[2].data.caption = '';
  assert.equal(JSON.parse((await unpack(await collect(await exportBoardArchive(disabled, source)))).get('board.json')).version, 1);
  for (const configure of [
    graph => { graph.runs[0].snapshot[1].data.caption = 'Historical only'; },
    graph => { graph.runs[0].target.data.labelOutputs = true; },
    graph => { graph.runs[0].target.data.template = { name: 'Views', instructions: '', assets: [], labelOutputs: true }; },
  ]) {
    const historyOnly = structuredClone(board);
    historyOnly.graph.runs[0].target = structuredClone(historyOnly.graph.runs[0].target);
    historyOnly.graph.runs[0].snapshot = structuredClone(historyOnly.graph.runs[0].snapshot);
    configure(historyOnly.graph);
    assert.equal(JSON.parse((await unpack(await collect(await exportBoardArchive(historyOnly, source)))).get('board.json')).version, 3);
  }
});

test('custom node archives preserve hidden references in live nodes and historical snapshots', async t => {
  const { source, destination } = await fixture(t), custom = structuredClone(board);
  custom.graph.nodes[1] = structuredClone(custom.graph.nodes[1]);
  custom.graph.runs[0].snapshot[2] = structuredClone(custom.graph.runs[0].snapshot[2]);
  custom.graph.runs[0].target = structuredClone(custom.graph.runs[0].target);
  custom.graph.nodes[1].data.template = { name: 'Multiview', instructions: 'Front and back', assets: [unused] };
  custom.graph.runs[0].snapshot[2].data.template = { name: 'Old preset', instructions: 'Earlier instruction', assets: [historical] };
  custom.graph.runs[0].target.data.template = { name: 'Old preset', instructions: 'Earlier instruction', assets: [current] };
  const bytes = await collect(await exportBoardArchive(custom, source)), files = await unpack(bytes), manifest = JSON.parse(files.get('board.json'));
  assert.equal(manifest.version, 2);
  assert.ok(files.has(`assets/${unused}`) && files.has(`assets/${historical}`) && files.has(`assets/${current}`));
  const imported = await importBoardArchive(bytes, destination), importedNode = imported.graph.nodes[1];
  const live = importedNode.data.template.assets[0], old = imported.graph.runs[0].snapshot[2].data.template.assets[0], target = imported.graph.runs[0].target.data.template.assets[0];
  assert.notEqual(live, unused); assert.notEqual(old, historical); assert.notEqual(target, current);
  assert.deepEqual(await readFile(path.join(destination, live)), await readFile(path.join(source, unused)));
  assert.deepEqual(await readFile(path.join(destination, old)), await readFile(path.join(source, historical)));
  assert.deepEqual(await readFile(path.join(destination, target)), await readFile(path.join(source, current)));
  assert.equal(importedNode.data.template.instructions, 'Front and back');
  assert.equal(imported.graph.runs[0].snapshot[2].data.template.instructions, 'Earlier instruction');
  manifest.version = 1;
  files.set('board.json', Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(importBoardArchive(await pack(files), destination), /newer board format/);
  custom.graph.nodes[1].data.template.assets = [];
  custom.graph.runs = [];
  assert.equal(JSON.parse((await unpack(await collect(await exportBoardArchive(custom, source)))).get('board.json')).version, 2);
});

test('path traversal, symlinks and oversized entries are rejected before extraction', async t => {
  const { source, destination } = await fixture(t), files = await unpack(await collect(await exportBoardArchive(board, source)));
  const traversal = await pack([['xx/outside.txt', Buffer.from('bad')]]);
  const from = Buffer.from('xx/outside.txt'), to = Buffer.from('../outside.txt'); assert.equal(from.length, to.length);
  for (let offset = traversal.indexOf(from); offset !== -1; offset = traversal.indexOf(from, offset + from.length)) to.copy(traversal, offset);
  await assert.rejects(importBoardArchive(traversal, destination), /path|relative/);
  await assert.rejects(importBoardArchive(await pack(files, { mode: 0o120777 }), destination), /links/);
  const oversized = await pack(files, { compress: true });
  for (let offset = 0; offset < oversized.length - 46; offset++) {
    if (oversized.readUInt32LE(offset) !== 0x02014b50) continue;
    const size = oversized.readUInt16LE(offset + 28), name = oversized.subarray(offset + 46, offset + 46 + size).toString();
    if (name.startsWith('assets/')) { oversized.writeUInt32LE(31 * 1024 * 1024, offset + 24); break; }
  }
  await assert.rejects(importBoardArchive(oversized, destination), /size limit/);
  assert.deepEqual(await readdir(destination), []);
});

test('imports cannot create a board too large for the normal save endpoint', async t => {
  const { source } = await fixture(t);
  const large = structuredClone(board);
  large.graph.nodes = Array.from({ length: 43 }, (_, i) => ({ id: `text-${i}`, type: 'text', position: { x: i * 400, y: 0 }, data: { text: 'x'.repeat(100000) } }));
  large.graph.edges = []; large.graph.groups = []; large.graph.runs = [];
  await assert.rejects(exportBoardArchive(large, source), /editable board content/);
});
