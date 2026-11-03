import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { version, targets, helperFiles, dependencies, chunkSize, directorySize, computeHelperVersion, windowsHelperLauncher } from './helper-build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.argv.includes('--cloud')) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-windows-helper.mjs')], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
const archives = process.env.CONCEPT_GRAPH_NODE_ARCHIVES;
if (!archives) throw new Error('Set CONCEPT_GRAPH_NODE_ARCHIVES to a directory containing the official Node.js v22.22.3 archives from https://nodejs.org/dist/v22.22.3/.');
const output = path.resolve(process.env.CONCEPT_GRAPH_SITE_OUTPUT || path.join(root, 'dist'));
// Optional site origin(s) baked into the launchers, e.g. a deployed cloud board site.
const site = process.env.CONCEPT_GRAPH_HELPER_SITE || '';
if (site && !site.split(',').every(origin => /^https:\/\/[a-z0-9.-]+$/i.test(origin.trim()))) throw new Error('CONCEPT_GRAPH_HELPER_SITE must be https origins.');
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-portable-'));
const manifest = {};
const run = (command, args, cwd = temp) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message || result.status}`);
};
try {
  const helperVersion = await computeHelperVersion(root);
  await mkdir(output, { recursive: true });
  for (const target of targets) {
    const archive = path.join(archives, target.archive);
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (digest !== target.sha256) throw new Error(`Checksum mismatch: ${target.archive}`);
    const work = path.join(temp, target.name);
    const app = path.join(work, 'Concept-Graph-Helper');
    const runtime = path.join(app, 'runtime');
    const extract = path.join(work, 'extract');
    await mkdir(runtime, { recursive: true });
    await mkdir(extract);
    const prefix = `node-v${version}-${target.platform}`;
    if (target.platform.startsWith('darwin')) {
      run('tar', ['-xzf', archive, '-C', extract, `${prefix}/bin/node`, `${prefix}/LICENSE`]);
      await cp(path.join(extract, prefix, 'bin/node'), path.join(runtime, 'node'));
      await chmod(path.join(runtime, 'node'), 0o755);
      await cp(path.join(extract, prefix, 'LICENSE'), path.join(app, 'NODE-LICENSE'));
      const launcher = `#!/bin/bash\ncd "$(dirname "$0")" || exit 1\nexport PATH="$PWD/runtime:$PATH"\n${site ? `export CONCEPT_GRAPH_SITE="${site}"\n` : ''}"$PWD/runtime/node" "$PWD/helper.mjs"\n`;
      const filename = path.join(app, 'Start Concept Graph.command');
      await writeFile(filename, launcher, { mode: 0o755 });
    } else {
      run('unzip', ['-j', '-q', archive, `${prefix}/node.exe`, `${prefix}/LICENSE`, '-d', extract]);
      await cp(path.join(extract, 'node.exe'), path.join(runtime, 'node.exe'));
      await cp(path.join(extract, 'LICENSE'), path.join(app, 'NODE-LICENSE'));
      await writeFile(path.join(app, 'Start Concept Graph.cmd'), windowsHelperLauncher(site));
    }
    for (const file of helperFiles) await cp(path.join(root, file), path.join(app, file));
    await writeFile(path.join(app, 'helper-version.json'), JSON.stringify({ version: helperVersion }) + '\n');
    for (const dependency of dependencies) await cp(path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency), { recursive: true });
    const zip = path.join(temp, `concept-graph-helper-${target.name}.zip`);
    run('zip', ['-q', '-9', '-r', zip, 'Concept-Graph-Helper'], work);
    const bytes = await readFile(zip);
    for (let offset = 0, part = 1; offset < bytes.length; offset += chunkSize, part++) {
      if (part > 2) throw new Error(`Archive ${target.name} exceeds two Site assets.`);
      await writeFile(path.join(output, `concept-graph-helper-${target.name}.zip.${String(part).padStart(3, '0')}`), bytes.subarray(offset, offset + chunkSize));
    }
    if (bytes.length <= chunkSize) throw new Error(`Archive ${target.name} must have two parts for the download UI.`);
    manifest[target.name] = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, unpackedSize: await directorySize(app), parts: 2, helperVersion };
    console.log(`${target.name}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB, 2 parts`);
  }
  await writeFile(path.join(output, 'concept-graph-helper-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
} finally {
  await rm(temp, { recursive: true, force: true });
}
