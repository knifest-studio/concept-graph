import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Analytics sessions name the build they ran (session_start reads this meta), so an error can be tied to a deploy.
// The short commit, marked -dirty for uncommitted changes; a source package without Git uses its version and build time.
const root = fileURLToPath(new URL('.', import.meta.url));
export function buildVersion() {
  if (existsSync(new URL('.git', import.meta.url))) {
    try { return execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=7', '--exclude=*'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
  }
  return `${JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')).version}+${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`;
}
const version = { name: 'concept-graph-version', transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'concept-graph-version', content: buildVersion() }, injectTo: 'head' }] };
export default defineConfig({ plugins: [version], build: { assetsDir: 'static' } });
