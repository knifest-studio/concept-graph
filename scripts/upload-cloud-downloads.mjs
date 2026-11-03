import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperOutputPaths, mergeHelperDownloads } from './helper-build.mjs';
import { helperDownloadType } from '../src/helper-download.mjs';

export async function cloudDownloadUploads(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (!entries.length) throw new Error('No helper downloads to upload. Build the helpers first.');
  const manifestName = 'concept-graph-helper-downloads.json', files = new Set(), uploads = [];
  for (const entry of entries.sort((a, b) => Number(a.name === manifestName) - Number(b.name === manifestName) || a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name), type = entry.name === manifestName ? 'application/json' : helperDownloadType(entry.name);
    if (!entry.isFile() || !type || (await stat(file)).size < 1) throw new Error(`Unexpected helper download: ${entry.name}`);
    files.add(entry.name);
    uploads.push(['r2', 'object', 'put', `concept-graph-files/downloads/${entry.name}`, '--file', file, '--content-type', type, '--remote', '-c', 'cloud/wrangler.jsonc']);
  }
  if (!files.has(manifestName)) throw new Error('Missing helper manifest. Build the helpers first.');
  const manifest = JSON.parse(await readFile(path.join(directory, manifestName), 'utf8'));
  mergeHelperDownloads(manifest, manifest);
  if (!Object.keys(manifest).length) throw new Error('Invalid helper manifest.');
  for (const entry of Object.values(manifest)) {
    if (!files.has(entry.file)) throw new Error(`Missing helper download: ${entry.file}`);
  }
  return uploads;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const outputs = helperOutputPaths(root);
  for (const args of await cloudDownloadUploads(outputs.downloads)) {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Helper download upload failed with status ${result.status}.`);
  }
}
