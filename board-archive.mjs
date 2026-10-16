import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { writeFile, stat, mkdtemp, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { validateGraph, imageFormat } from './graph.mjs';
import { boardName } from './workspace.mjs';

export const maxBoardArchiveBytes = 512 * 1024 * 1024;
const maxManifestBytes = 32 * 1024 * 1024, maxImageBytes = 30 * 1024 * 1024, maxEntries = 5000;
const assetPattern = /^[\da-f-]{36}\.(png|jpg|webp|gif)$/;
const format = 'concept-graph-board';
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 120;

function validateNodeMetadata(node) {
  if (node.data.label !== undefined && (typeof node.data.label !== 'string' || node.data.label.length > 100000)) fail('Invalid image label.');
  if (node.data.runId !== undefined && !validId(node.data.runId)) fail('Invalid image history reference.');
}

function validateArchiveGraph(graph) {
  validateGraph(graph);
  if (!Number.isSafeInteger(graph.revision) || graph.revision < 0 || !graph.viewport || graph.viewport.zoom <= 0
    || !Array.isArray(graph.runs) || graph.runs.length > 5000) fail('Invalid board history or viewport.');
  const editable = JSON.stringify({ revision: graph.revision, nodes: graph.nodes, edges: graph.edges, groups: graph.groups, viewport: graph.viewport });
  if (Buffer.byteLength(editable) > 4 * 1024 * 1024) fail('The editable board content exceeds the 4 MB limit.');
  graph.nodes.forEach(validateNodeMetadata);
  const runIds = new Set();
  for (const run of graph.runs) {
    if (!run || !validId(run.id) || runIds.has(run.id) || !validId(run.nodeId)
      || !['queued', 'running', 'completed', 'error', 'cancelled'].includes(run.status)
      || !Array.isArray(run.outputIds) || run.outputIds.length > 2000 || !run.outputIds.every(validId)
      || !Number.isFinite(Date.parse(run.createdAt))) fail('Invalid generation history.');
    runIds.add(run.id);
    for (const key of ['label', 'message', 'error', 'prompt']) {
      if (run[key] !== undefined && (typeof run[key] !== 'string' || run[key].length > 150000)) fail('Invalid generation text.');
    }
    for (const key of ['startedAt', 'finishedAt']) if (run[key] !== undefined && !Number.isFinite(Date.parse(run[key]))) fail('Invalid generation timestamp.');
    if (run.images !== undefined && (!Array.isArray(run.images) || run.images.length > 10 || !run.images.every(asset => typeof asset === 'string' && assetPattern.test(asset)))) fail('Invalid saved image inputs.');
    if (run.snapshot !== undefined) {
      validateGraph({ nodes: run.snapshot, edges: [] });
      run.snapshot.forEach(validateNodeMetadata);
    }
    if (run.target !== undefined) {
      validateGraph({ nodes: [run.target], edges: [] });
      if (run.target.type !== 'text') fail('Invalid saved prompt.');
    }
  }
}

function referencedAssets(graph) {
  const assets = new Set();
  const visit = node => { if (node?.type === 'image') assets.add(node.data.asset); };
  graph.nodes.forEach(visit);
  for (const run of graph.runs) {
    run.images?.forEach(asset => assets.add(asset));
    run.snapshot?.forEach(visit);
    visit(run.target);
  }
  return assets;
}

async function fileHash(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function exportBoardArchive(board, assetsDir) {
  const saved = structuredClone({ name: board.name, createdAt: board.createdAt, graph: board.graph });
  boardName(saved.name); validateArchiveGraph(saved.graph);
  const assets = {}, needed = referencedAssets(saved.graph);
  if (needed.size + 1 > maxEntries) fail('This board contains too many images to export.');
  let total = 0;
  for (const asset of needed) {
    const filename = path.join(assetsDir, asset), info = await stat(filename);
    if (!info.isFile() || info.size > maxImageBytes) fail('An image exceeds the 30 MB limit.');
    total += info.size;
    if (total > maxBoardArchiveBytes) fail('This board exceeds the 512 MB export limit.');
    assets[asset] = { size: info.size, sha256: await fileHash(filename) };
  }
  const manifest = Buffer.from(JSON.stringify({ format, version: 1, exportedAt: new Date().toISOString(), board: saved, assets }, null, 2));
  if (manifest.length > maxManifestBytes || total + manifest.length + (needed.size + 1) * 512 > maxBoardArchiveBytes) fail('This board exceeds the archive size limits.');
  const zip = new yazl.ZipFile();
  zip.on('error', error => zip.outputStream.destroy(error));
  zip.addBuffer(manifest, 'board.json', { compress: false });
  for (const asset of needed) zip.addFile(path.join(assetsDir, asset), `assets/${asset}`, { compress: false });
  zip.end();
  return zip.outputStream;
}

async function readEntry(zip, entry, limit) {
  const chunks = []; let total = 0;
  for await (const chunk of await zip.openReadStreamPromise(entry)) {
    total += chunk.length;
    if (total > limit) fail('An archive entry exceeds its size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function importBoardArchive(bytes, assetsDir) {
  if (!bytes.length || bytes.length > maxBoardArchiveBytes) fail('Choose a .conceptgraph file no larger than 512 MB.');
  let zip;
  try { zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true }); }
  catch { fail('This .conceptgraph file is damaged or is not a valid board archive.'); }
  let staging;
  const installed = [];
  try {
    const entries = new Map(); let expanded = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (entries.size >= maxEntries || entries.has(name)) fail('The archive has too many entries or duplicate filenames.');
      if (name !== 'board.json' && !/^assets\/[\da-f-]{36}\.(png|jpg|webp|gif)$/.test(name)) fail('The archive contains an unexpected file path.');
      if (!entry.canDecodeFileData() || ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) fail('Encrypted files, links, or unsupported compression are not allowed.');
      const limit = name === 'board.json' ? maxManifestBytes : maxImageBytes;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limit) fail('An archive entry exceeds its size limit.');
      expanded += entry.uncompressedSize;
      if (expanded > maxBoardArchiveBytes) fail('The expanded archive exceeds 512 MB.');
      entries.set(name, entry);
    }
    const manifestEntry = entries.get('board.json');
    if (!manifestEntry) fail('The .conceptgraph file is missing board.json.');
    let manifest;
    try { manifest = JSON.parse((await readEntry(zip, manifestEntry, maxManifestBytes)).toString('utf8')); }
    catch { fail('The board manifest is damaged or invalid.'); }
    if (manifest?.format !== format || manifest.version !== 1) fail('This board format version is not supported.');
    const board = manifest.board;
    boardName(board?.name); validateArchiveGraph(board.graph);
    const needed = referencedAssets(board.graph), inventory = manifest.assets;
    if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)
      || Object.keys(inventory).length !== needed.size || entries.size !== needed.size + 1) fail('The image inventory does not match the board.');
    for (const asset of needed) {
      const info = inventory[asset], entry = entries.get(`assets/${asset}`);
      if (!entry || !info || !Number.isSafeInteger(info.size) || info.size !== entry.uncompressedSize || !/^[\da-f]{64}$/.test(info.sha256)) fail('A required image is missing or invalid.');
    }
    staging = await mkdtemp(path.join(path.dirname(assetsDir), '.board-import-'));
    const remap = new Map();
    for (const asset of needed) {
      const image = await readEntry(zip, entries.get(`assets/${asset}`), maxImageBytes);
      if (createHash('sha256').update(image).digest('hex') !== inventory[asset].sha256) fail('An image checksum does not match; the archive may be damaged.');
      if ('.' + imageFormat(image) !== path.extname(asset)) fail('An image format does not match its filename.');
      const name = randomUUID() + path.extname(asset);
      await writeFile(path.join(staging, name), image, { flag: 'wx' });
      remap.set(asset, name);
    }
    const graph = structuredClone(board.graph);
    const remapNode = node => { if (node?.type === 'image') node.data.asset = remap.get(node.data.asset); };
    graph.nodes.forEach(remapNode);
    for (const run of graph.runs) {
      if (run.images) run.images = run.images.map(asset => remap.get(asset));
      run.snapshot?.forEach(remapNode); remapNode(run.target);
      if (['queued', 'running'].includes(run.status)) {
        run.status = 'cancelled';
        run.message = 'This run was unfinished when exported. Run the prompt again to generate.';
        run.finishedAt = new Date().toISOString();
      }
    }
    graph.revision = 0;
    for (const name of remap.values()) {
      await copyFile(path.join(staging, name), path.join(assetsDir, name), constants.COPYFILE_EXCL);
      installed.push(name);
    }
    return { name: board.name, graph, assets: installed };
  } catch (error) {
    await Promise.all(installed.map(name => rm(path.join(assetsDir, name), { force: true })));
    throw error;
  } finally {
    zip.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
