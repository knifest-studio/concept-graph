import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { version, targets, helperFiles, dependencies, directorySize, validateHelperSite, helperOutputPaths, helperDownloadEntry, updateHelperDownloads, computeHelperVersion } from './helper-build.mjs';
import { helperDownloadFiles } from '../src/helper-download.mjs';
import { windowsHelperConfig, windowsHelperPayload, windowsHelperIcon } from './windows-helper-build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const site = validateHelperSite(process.env.CONCEPT_GRAPH_HELPER_SITE);
const archives = process.env.CONCEPT_GRAPH_NODE_ARCHIVES;
if (!archives) throw new Error('Set CONCEPT_GRAPH_NODE_ARCHIVES to the directory with official Node.js v22.22.3 archives.');
const outputs = helperOutputPaths(root);
const target = targets.find(target => target.name === 'windows-x64');
const archive = path.resolve(archives, target.archive);
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== target.sha256) throw new Error(`Checksum mismatch: ${target.archive}`);
const dotnet = process.env.CONCEPT_GRAPH_DOTNET || path.join(homedir(), '.dotnet/dotnet');
const makensis = process.env.CONCEPT_GRAPH_MAKENSIS || '/opt/homebrew/bin/makensis';
for (const [tool, args, name] of [[dotnet, ['--version'], '.NET SDK (default: ~/.dotnet/dotnet; override CONCEPT_GRAPH_DOTNET)'], [makensis, ['-VERSION'], 'NSIS (brew install makensis; override CONCEPT_GRAPH_MAKENSIS)']]) {
  const result = spawnSync(tool, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`Windows helper build requires ${name}: ${result.error?.message || result.stderr || result.status}`);
}
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-windows-helper-'));
const run = (command, args, extraEnv = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
};
const payloadFiles = async (directory, prefix = '') => {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await payloadFiles(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unexpected Windows helper payload: ${relative}`);
  }
  return result;
};
try {
  const helperVersion = await computeHelperVersion(root);
  const app = path.join(temp, 'app'), extract = path.join(temp, 'extract');
  await mkdir(path.join(app, 'runtime'), { recursive: true });
  await mkdir(extract);
  const prefix = `node-v${version}-${target.platform}`;
  run('unzip', ['-j', '-q', archive, `${prefix}/node.exe`, `${prefix}/LICENSE`, '-d', extract]);
  await cp(path.join(extract, 'node.exe'), path.join(app, 'runtime/node.exe'));
  await cp(path.join(extract, 'LICENSE'), path.join(app, 'NODE-LICENSE'));
  for (const file of helperFiles) { await mkdir(path.dirname(path.join(app, file)), { recursive: true }); await cp(path.join(root, file), path.join(app, file)); }
  for (const dependency of dependencies) await cp(path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency), { recursive: true });
  await writeFile(path.join(app, 'helper-version.json'), JSON.stringify({ version: helperVersion }) + '\n');
  await writeFile(path.join(app, 'helper-site.txt'), windowsHelperConfig(site));
  const iconset = path.join(temp, 'iconset'), icon = path.join(temp, 'ConceptGraph.ico');
  run('swift', [path.join(root, 'desktop/macos/make-icon.swift'), path.join(root, 'public/favicon.svg'), iconset], { CLANG_MODULE_CACHE_PATH: path.join(temp, 'clang-cache'), SWIFT_MODULECACHE_PATH: path.join(temp, 'swift-cache') });
  await writeFile(icon, windowsHelperIcon(await readFile(path.join(iconset, 'icon_128x128@2x.png'))));
  run(dotnet, ['publish', path.join(root, 'desktop/windows-helper/ConceptGraph.Helper.csproj'), '-c', 'Release', '-o', app, `-p:BaseIntermediateOutputPath=${path.join(temp, 'obj')}/`, `-p:BaseOutputPath=${path.join(temp, 'bin')}/`, `-p:HelperIcon=${icon}`], { DOTNET_CLI_HOME: path.join(temp, 'dotnet'), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', NUGET_PACKAGES: process.env.NUGET_PACKAGES || path.join(tmpdir(), 'concept-graph-nuget') });
  const payload = path.join(temp, 'payload.nsh');
  await writeFile(payload, windowsHelperPayload(await payloadFiles(app)));
  const file = helperDownloadFiles[target.name], installer = path.join(temp, file), unpackedSize = await directorySize(app);
  run(makensis, ['-WX', '-V3', `-DAPP_DIR=${app}`, `-DPAYLOAD_INCLUDE=${payload}`, `-DOUTPUT_FILE=${installer}`, `-DPRODUCT_VERSION=${helperVersion.split('-')[0]}`, `-DHELPER_VERSION=${helperVersion}`, `-DHELPER_SIZE_KIB=${Math.ceil(unpackedSize / 1024)}`, path.join(root, 'desktop/windows-helper/installer.nsi')], { LC_ALL: 'en_US.UTF-8' }); // makensis aborts on non-ASCII paths without a UTF-8 locale.
  const bytes = await readFile(installer);
  const entry = helperDownloadEntry(target.name, bytes, unpackedSize, helperVersion);
  await mkdir(outputs.downloads, { recursive: true });
  await cp(installer, path.join(outputs.downloads, file));
  await updateHelperDownloads(outputs.downloads, { [target.name]: entry });
  await rm(path.join(outputs.downloads, 'Concept-Graph-Helper-windows-x64.zip'), { force: true });
  console.log(`${file}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB (${helperVersion})`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
