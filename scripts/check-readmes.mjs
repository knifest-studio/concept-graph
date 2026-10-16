import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const record = path.join(root, 'docs/readme-sync.json');
const previous = JSON.parse(await readFile(record, 'utf8'));
const current = {};
for (const name of ['README.md', 'README.uk.md']) {
  current[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex');
}
const changed = Object.keys(current).filter(name => current[name] !== previous[name]);
if (process.argv.includes('--update')) {
  if (changed.includes('README.md') && !changed.includes('README.uk.md')) {
    throw new Error('README.md changed. Update README.uk.md before recording synchronization.');
  }
  await writeFile(record, JSON.stringify(current, null, 2) + '\n');
  console.log('Reviewed README synchronization recorded.');
} else {
  if (changed.length) throw new Error('README synchronization is stale: ' + changed.join(', ') + '. Review both languages, then run npm run docs:mark-synced.');
  console.log('English and Ukrainian READMEs match their recorded synchronization.');
}
