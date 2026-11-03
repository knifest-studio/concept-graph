import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { version, targets, helperFiles, dependencies, directorySize, validateHelperSite, helperInfoPlist, helperOutputPaths, helperDownloadEntry, updateHelperDownloads, computeHelperVersion } from './helper-build.mjs';
import { helperDownloadFiles } from '../src/helper-download.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const site = validateHelperSite(process.env.CONCEPT_GRAPH_HELPER_SITE);
const archs = [...new Set((process.env.CONCEPT_GRAPH_MAC_ARCHS ?? 'arm64,x64').split(/[\s,]+/).filter(Boolean))];
if (process.platform !== 'darwin' || !archs.length || archs.some(arch => !['arm64', 'x64'].includes(arch))) throw new Error('Build on macOS with CONCEPT_GRAPH_MAC_ARCHS=arm64,x64 (or either architecture).');
const archives = process.env.CONCEPT_GRAPH_NODE_ARCHIVES;
if (!archives) throw new Error('Set CONCEPT_GRAPH_NODE_ARCHIVES to the directory with official Node.js v22.22.3 archives.');
const outputs = helperOutputPaths(root);
const identity = process.env.CONCEPT_GRAPH_MAC_SIGN_IDENTITY || '-';
if (identity !== '-' && !identity.startsWith('Developer ID Application:')) throw new Error('CONCEPT_GRAPH_MAC_SIGN_IDENTITY must be a full Developer ID Application identity, or - for an ad hoc preview.');
const notaryProfile = process.env.CONCEPT_GRAPH_MAC_NOTARY_PROFILE;
if (notaryProfile && identity === '-') throw new Error('Notarization requires a Developer ID Application identity, not ad hoc signing.');
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-macos-helper-'));
const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
};
const submit = file => {
  const submitted = spawnSync('xcrun', ['notarytool', 'submit', file, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
  if (submitted.error) throw submitted.error;
  let result;
  try { result = JSON.parse(submitted.stdout); } catch { throw new Error(`Notarization did not return JSON: ${submitted.stderr}`); }
  if (submitted.status !== 0 || result.status !== 'Accepted') throw new Error(`Notarization was not accepted (status: ${result.status || 'unknown'}, id: ${result.id || 'unavailable'}).`);
};
const entries = {}, images = [];
try {
  const helperVersion = await computeHelperVersion(root);
  for (const arch of archs) {
    const target = targets.find(target => target.name === `macos-${arch}`);
    const archive = path.resolve(archives, target.archive);
    if (createHash('sha256').update(await readFile(archive)).digest('hex') !== target.sha256) throw new Error(`Checksum mismatch: ${target.archive}`);
    const work = path.join(temp, arch);
    const imageRoot = path.join(work, 'image');
    const app = path.join(imageRoot, 'Concept Graph Helper.app');
    const resources = path.join(app, 'Contents/Resources');
    const helper = path.join(resources, 'helper');
    const node = path.join(resources, 'runtime/node');
    const executable = path.join(app, 'Contents/MacOS/ConceptGraphHelper');
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(path.dirname(node), { recursive: true });
    await mkdir(helper);
    const template = await readFile(path.join(root, 'desktop/macos-helper/Info.plist'), 'utf8');
    await writeFile(path.join(app, 'Contents/Info.plist'), helperInfoPlist(template, site));
    const prefix = `node-v${version}-${target.platform}`;
    run('tar', ['-xzf', archive, '-C', work, `${prefix}/bin/node`, `${prefix}/LICENSE`]);
    await cp(path.join(work, prefix, 'bin/node'), node);
    await chmod(node, 0o755);
    await cp(path.join(work, prefix, 'LICENSE'), path.join(resources, 'runtime/NODE-LICENSE'));
    for (const file of helperFiles) { await mkdir(path.dirname(path.join(helper, file)), { recursive: true }); await cp(path.join(root, file), path.join(helper, file)); }
    await writeFile(path.join(helper, 'helper-version.json'), JSON.stringify({ version: helperVersion }) + '\n');
    for (const dependency of dependencies) await cp(path.join(root, 'node_modules', dependency), path.join(helper, 'node_modules', dependency), { recursive: true });
    const swiftEnv = { CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-cache'), SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-cache') };
    run('swiftc', ['-O', '-target', `${arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos12.0`, path.join(root, 'desktop/macos-helper/main.swift'), '-o', executable], swiftEnv);
    const iconset = path.join(work, 'ConceptGraph.iconset');
    run('swift', [path.join(root, 'desktop/macos/make-icon.swift'), path.join(root, 'public/favicon.svg'), iconset], swiftEnv);
    run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'ConceptGraph.icns')]);
    const signing = ['--force', '--sign', identity, '--options', 'runtime', ...(identity === '-' ? [] : ['--timestamp'])];
    run('codesign', [...signing, '--identifier', 'studio.knifest.conceptgraph.helper.node', '--entitlements', path.join(root, 'desktop/macos', `node-${arch}.entitlements`), node]);
    run('codesign', ['--verify', '--strict', '--verbose=2', node]);
    run('codesign', [...signing, app]);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    if (notaryProfile) {
      const zip = path.join(work, 'notarize-app.zip');
      run('ditto', ['-c', '-k', '--keepParent', app, zip]);
      submit(zip);
      run('xcrun', ['stapler', 'staple', app]);
      run('xcrun', ['stapler', 'validate', app]);
      run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    }
    await symlink('/Applications', path.join(imageRoot, 'Applications'));
    const file = helperDownloadFiles[target.name], dmg = path.join(work, file);
    run('hdiutil', ['create', '-srcfolder', imageRoot, '-volname', 'Concept Graph Helper', '-format', 'UDZO', dmg]);
    if (identity !== '-') {
      run('codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
      run('codesign', ['--verify', '--verbose=2', dmg]);
    }
    if (notaryProfile) {
      submit(dmg);
      run('xcrun', ['stapler', 'staple', dmg]);
      run('xcrun', ['stapler', 'validate', dmg]);
      run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
    }
    run('hdiutil', ['verify', dmg]);
    const bytes = await readFile(dmg);
    entries[target.name] = helperDownloadEntry(target.name, bytes, await directorySize(app), helperVersion);
    images.push({ source: dmg, file });
    console.log(`${file}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB`);
  }
  await mkdir(outputs.downloads, { recursive: true });
  for (const { source, file } of images) await cp(source, path.join(outputs.downloads, file));
  await updateHelperDownloads(outputs.downloads, entries);
  if (identity === '-') console.warn('Ad hoc preview only: not Developer ID signed or notarized.');
  else if (!notaryProfile) console.warn('Signed but not notarized: set CONCEPT_GRAPH_MAC_NOTARY_PROFILE before publishing.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
