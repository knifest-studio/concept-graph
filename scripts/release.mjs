import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric release version.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error('Release tag must match package.json version.');
}
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.includes('LICENSE') || !files.includes('README.md')) throw new Error('Track the source, README and license before packaging.');
const forbidden = /(^|\/)(data|backups|node_modules|releases|\.git|\.codex|\.env(?:\..*)?)(\/|$)|\.(log|conceptgraph)$/i;
if (files.some(file => file !== 'examples/courier-robot.conceptgraph' && forbidden.test(file))) throw new Error('Tracked private or generated files must not be packaged.');
const walk = async directory => {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else files.push(name);
  }
};
await walk('dist');
if (!files.includes('dist/index.html')) throw new Error('Build the browser interface first.');

const directory = path.join(root, 'releases');
await mkdir(directory, { recursive: true });
const filename = `concept-graph-v${version}.zip`;
const output = path.join(directory, filename);
const zip = new yazl.ZipFile();
const writing = pipeline(zip.outputStream, createWriteStream(output));
for (const file of [...new Set(files)].sort()) {
  const source = path.join(root, file), info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release entries must be ordinary files: ${file}`);
  zip.addFile(source, `concept-graph-${version}/${file}`, { mode: info.mode, mtime: info.mtime });
}
zip.end();
await writing;
const checksum = createHash('sha256').update(await readFile(output)).digest('hex');
await writeFile(path.join(directory, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
console.log(`Release package: ${output}`);
console.log(`SHA-256: ${checksum}`);
