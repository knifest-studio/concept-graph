import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arch = process.env.CONCEPT_GRAPH_MAC_ARCH || process.arch;
const checksums = {
  arm64: '0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207',
  x64: '45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec',
};
if (process.platform !== 'darwin' || !checksums[arch]) throw new Error('Build on macOS for arm64 or x64.');
const archives = process.env.CONCEPT_GRAPH_NODE_ARCHIVES;
if (!archives) throw new Error('Set CONCEPT_GRAPH_NODE_ARCHIVES to the directory with verified Node.js v22.22.3 archives.');
const nodeArchive = path.join(archives, `node-v22.22.3-darwin-${arch}.tar.gz`);
if (createHash('sha256').update(await readFile(nodeArchive)).digest('hex') !== checksums[arch]) throw new Error('Node.js archive checksum mismatch.');
const output = path.resolve(process.env.CONCEPT_GRAPH_DESKTOP_OUTPUT || path.join(root, 'desktop-build'));
const destination = path.join(output, 'Concept Graph.app');
const identity = process.env.CONCEPT_GRAPH_MAC_SIGN_IDENTITY || '-';
if (identity !== '-' && !identity.startsWith('Developer ID Application:')) throw new Error('CONCEPT_GRAPH_MAC_SIGN_IDENTITY must be a full Developer ID Application identity, or omitted for a local ad hoc preview.');
const sparkle = process.env.CONCEPT_GRAPH_SPARKLE_FRAMEWORK;
const feed = process.env.CONCEPT_GRAPH_UPDATE_FEED;
const publicKey = process.env.CONCEPT_GRAPH_UPDATE_PUBLIC_KEY;
if (sparkle || feed || publicKey) {
  if (identity !== '-') throw new Error('Developer ID distribution with Sparkle is not supported until its nested helpers have a verified signing workflow.');
  let url;
  try { url = new URL(feed); } catch { throw new Error('An HTTPS update feed is required when enabling Sparkle.'); }
  if (!sparkle || !publicKey || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || Buffer.from(publicKey, 'base64').length !== 32 || Buffer.from(publicKey, 'base64').toString('base64') !== publicKey) throw new Error('A Sparkle framework, HTTPS update feed and 32-byte Ed25519 public key are all required.');
}
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-macos-build-'));
const staged = path.join(temp, 'Concept Graph.app');
const resources = path.join(staged, 'Contents/Resources');
const app = path.join(resources, 'app');
const executable = path.join(staged, 'Contents/MacOS/ConceptGraph');
const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
};
try {
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(resources, 'runtime'), { recursive: true });
  await mkdir(app, { recursive: true });
  const plist = path.join(staged, 'Contents/Info.plist');
  await cp(path.join(root, 'desktop/macos/Info.plist'), plist);
  run('tar', ['-xzf', nodeArchive, '-C', temp, `node-v22.22.3-darwin-${arch}/bin/node`, `node-v22.22.3-darwin-${arch}/LICENSE`]);
  await cp(path.join(temp, `node-v22.22.3-darwin-${arch}/bin/node`), path.join(resources, 'runtime/node'));
  await chmod(path.join(resources, 'runtime/node'), 0o755);
  await cp(path.join(temp, `node-v22.22.3-darwin-${arch}/LICENSE`), path.join(resources, 'runtime/NODE-LICENSE'));
  for (const file of ['server.mjs', 'mcp.mjs', 'mcp-coordinator.mjs', 'codex.mjs', 'workspace.mjs', 'graph.mjs', 'board-archive.mjs', 'helper-auth.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, file), path.join(app, file));
  await mkdir(path.join(app, 'src'), { recursive: true });
  for (const file of ['canvas.mjs', 'node-template.mjs', 'annotations.mjs', 'pages.mjs', 'layers.mjs', 'sections.mjs', 'node-placement.mjs']) await cp(path.join(root, 'src', file), path.join(app, 'src', file));
  for (const dependency of ['yauzl', 'yazl', 'pend', 'buffer-crc32']) await cp(path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency), { recursive: true });
  run(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', path.join(app, 'dist'), '--emptyOutDir'], { VITE_CONCEPT_GRAPH_HOSTED: '0' });
  const target = arch === 'arm64' ? 'arm64-apple-macos12.0' : 'x86_64-apple-macos12.0';
  const swiftEnv = { CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-cache'), SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-cache') };
  const swiftArgs = ['-O', '-target', target, ...['main.swift', 'Storage.swift', 'CodexInstall.swift', 'Updates.swift', 'UpdateConfiguration.swift'].map(file => path.join(root, 'desktop/macos', file))];
  if (sparkle) {
    const frameworks = path.join(staged, 'Contents/Frameworks');
    await mkdir(frameworks, { recursive: true });
    await cp(sparkle, path.join(frameworks, 'Sparkle.framework'), { recursive: true, verbatimSymlinks: true });
    await cp(path.join(path.dirname(path.resolve(sparkle)), 'LICENSE'), path.join(resources, 'SPARKLE-LICENSE'));
    swiftArgs.push('-F', path.dirname(path.resolve(sparkle)), '-framework', 'Sparkle', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks');
    for (const [key, type, value] of [['SUFeedURL', 'string', feed], ['SUPublicEDKey', 'string', publicKey], ['SUEnableAutomaticChecks', 'bool', 'true'], ['SUAllowsAutomaticUpdates', 'bool', 'false']]) run('plutil', ['-insert', key, `-${type}`, value, plist]);
  }
  run('swiftc', [...swiftArgs, '-o', executable], swiftEnv);
  const iconset = path.join(temp, 'ConceptGraph.iconset');
  run('swift', [path.join(root, 'desktop/macos/make-icon.swift'), path.join(root, 'public/favicon.svg'), iconset], swiftEnv);
  run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'ConceptGraph.icns')]);
  if (identity !== '-') {
    // Node is a separate process: only it needs the V8 JIT entitlement.
    run('codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', '--identifier', 'studio.knifest.conceptgraph.node', '--entitlements', path.join(root, 'desktop/macos', `node-${arch}.entitlements`), path.join(resources, 'runtime/node')]);
    run('codesign', ['--verify', '--strict', '--verbose=2', path.join(resources, 'runtime/node')]);
  }
  // Sign nested code first, then seal the complete bundle after all resources exist.
  run('codesign', ['--force', '--sign', identity, ...(identity === '-' ? [] : ['--timestamp', '--options', 'runtime']), staged]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', staged]);
  await mkdir(output, { recursive: true });
  try { await rename(staged, destination); }
  catch (error) { if (error.code === 'EXDEV') await cp(staged, destination, { recursive: true, force: false, errorOnExist: true }); else throw error; }
  console.log(`Built ${destination}`);
  if (identity === '-') console.warn('Ad hoc preview only: this app is not Developer ID signed or notarized for distribution.');
  else console.log('Developer ID signed; notarize the DMG before publishing it.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
