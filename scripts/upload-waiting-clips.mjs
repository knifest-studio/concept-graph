// Waiting clips that we may not redistribute are hosted, never committed: this uploads a local folder of them to the
// cloud bucket under clips/ and writes the index the app reads. Nothing here touches the repository or a release.
import { readdir, stat, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { clipPattern } from '../src/waiting-videos.mjs';

export const maxClipBytes = 4 * 1024 * 1024;

export async function waitingClipUploads(directory, indexFile) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
  if (!names.length) throw new Error(`No clips in ${directory}.`);
  for (const name of names) {
    if (!clipPattern.test(name)) throw new Error(`Unexpected clip name: ${name}. Use lowercase letters, digits and dashes, ending in .mp4.`);
    const { size } = await stat(path.join(directory, name));
    if (size < 1) throw new Error(`Empty clip: ${name}.`);
    if (size > maxClipBytes) throw new Error(`Clip is too large: ${name} (${(size / 1024 / 1024).toFixed(1)} MB, limit ${maxClipBytes / 1024 / 1024} MB).`);
  }
  const uploads = names.map(name => ['r2', 'object', 'put', `concept-graph-files/clips/${name}`,
    '--file', path.join(directory, name), '--content-type', 'video/mp4', '--remote', '-c', 'cloud/wrangler.jsonc']);
  // The index goes up last, so a half-finished upload never advertises a clip that is not there yet.
  uploads.push(['r2', 'object', 'put', 'concept-graph-files/clips/index.json',
    '--file', indexFile, '--content-type', 'application/json', '--remote', '-c', 'cloud/wrangler.jsonc']);
  return { names, uploads };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const directory = path.resolve(process.argv[2] || process.env.CONCEPT_GRAPH_CLIPS || path.join(root, 'clips'));
  const indexFile = path.join(tmpdir(), `concept-graph-clips-${randomUUID()}.json`);
  try {
    const { names, uploads } = await waitingClipUploads(directory, indexFile);
    await writeFile(indexFile, JSON.stringify(names));
    for (const args of uploads) {
      const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Clip upload failed with status ${result.status}.`);
    }
    console.log(`Uploaded ${names.length} waiting clips.`);
  } finally { await rm(indexFile, { force: true }); }
}
