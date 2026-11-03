import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(process.argv[2] || path.join(root, 'dist', 'concept-graph-helper.tgz'));
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-helper-'));
const packageDir = path.join(temp, 'package');
try {
  await mkdir(packageDir);
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = ['helper.mjs', 'helper-auth.mjs', 'server.mjs', 'mcp-coordinator.mjs', 'codex.mjs', 'workspace.mjs', 'graph.mjs', 'board-archive.mjs', 'LICENSE'];
  for (const file of files) await cp(path.join(root, file), path.join(packageDir, file));
  await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'concept-graph-local-helper', version: source.version, type: 'module', license: source.license,
    bin: { 'concept-graph-helper': './helper.mjs' }, engines: source.engines,
    dependencies: { yauzl: source.dependencies.yauzl, yazl: source.dependencies.yazl },
  }, null, 2) + '\n');
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: packageDir, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(temp, 'cache') } });
  if (result.status !== 0) throw new Error(result.stderr || 'Could not package the local helper.');
  const [{ filename }] = JSON.parse(result.stdout);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(path.join(temp, filename), output);
  console.log(`Local helper package: ${output}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
