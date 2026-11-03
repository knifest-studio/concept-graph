import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(process.env.CONCEPT_GRAPH_SITE_OUTPUT || path.join(root, 'dist'));
for (const [script, args, env] of [
  [path.join(root, 'node_modules/vite/bin/vite.js'), ['build', '--outDir', output, '--emptyOutDir'], { VITE_CONCEPT_GRAPH_HOSTED: '1' }],
  [path.join(root, 'scripts/package-helper.mjs'), [path.join(output, 'concept-graph-helper.tgz')], {}],
]) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
