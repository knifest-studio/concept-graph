import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { helperDownloadFiles, cloudHelperDownload } from '../src/helper-download.mjs';

export const version = '22.22.3';
export const targets = [
  { name: 'macos-arm64', archive: `node-v${version}-darwin-arm64.tar.gz`, sha256: '0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207', platform: 'darwin-arm64' },
  { name: 'macos-x64', archive: `node-v${version}-darwin-x64.tar.gz`, sha256: '45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec', platform: 'darwin-x64' },
  { name: 'windows-x64', archive: `node-v${version}-win-x64.zip`, sha256: '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33', platform: 'win-x64' },
];
export const helperFiles = ['helper.mjs', 'helper-auth.mjs', 'server.mjs', 'mcp-coordinator.mjs', 'codex.mjs', 'workspace.mjs', 'desktop-preferences.mjs', 'graph.mjs', 'src/annotations.mjs', 'src/pages.mjs', 'src/theme.mjs', 'src/layers.mjs', 'src/sections.mjs', 'src/node-placement.mjs', 'src/image-edits.mjs', 'board-archive.mjs', 'LICENSE'];
export const dependencies = ['yauzl', 'yazl', 'pend', 'buffer-crc32'];
export const chunkSize = 20 * 1024 * 1024;

export function windowsHelperLauncher(site = '') {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'pushd "%~dp0"',
    'if errorlevel 1 exit /b 1',
    'set "PATH=%~dp0runtime;%PATH%"',
    ...(site ? [`set "CONCEPT_GRAPH_SITE=${site}"`] : []),
    '"%~dp0runtime\\node.exe" "%~dp0helper.mjs"',
    'set "helperExitCode=%errorlevel%"',
    'popd',
    'pause',
    'exit /b %helperExitCode%',
    '',
  ].join('\r\n');
}

export async function computeHelperVersion(root) {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  for (const file of [...helperFiles].sort()) {
    const bytes = await readFile(path.join(root, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return `${version}-${hash.digest('hex').slice(0, 10)}`;
}

export async function directorySize(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? directorySize(file) : stat(file).then(info => info.size);
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

export function validateHelperSite(site) {
  const invalid = () => { throw new Error('CONCEPT_GRAPH_HELPER_SITE must contain HTTPS origins only.'); };
  if (typeof site !== 'string' || !site.trim()) return invalid();
  return site.split(',').map(value => {
    const origin = value.trim();
    let url;
    try { url = new URL(origin); } catch { return invalid(); }
    if (!/^https:\/\/[^/?#\s\\]+\/?$/i.test(origin) || !url.hostname || url.username || url.password) return invalid();
    return url.origin;
  }).join(',');
}

export function helperInfoPlist(template, site) {
  const marker = '__CONCEPT_GRAPH_HELPER_SITE__';
  if (template.split(marker).length !== 2) throw new Error('Helper Info.plist must contain one site placeholder.');
  const escaped = validateHelperSite(site).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]);
  return template.replace(marker, () => escaped);
}

export function helperOutputPaths(root, env = process.env) {
  const site = path.resolve(env.CONCEPT_GRAPH_SITE_OUTPUT || path.join(root, 'dist-cloud'));
  const downloads = path.resolve(env.CONCEPT_GRAPH_DOWNLOADS_OUTPUT || path.join(root, 'dist-downloads'));
  if (downloads === site || downloads.startsWith(site + path.sep)) throw new Error('Helper binaries must be outside the static site output.');
  return { site, downloads };
}

export function helperDownloadEntry(platform, bytes, unpackedSize, helperVersion) {
  const file = Object.hasOwn(helperDownloadFiles, platform) ? helperDownloadFiles[platform] : null;
  if (!file) throw new Error(`Invalid helper download: ${platform}`);
  const entry = { file, url: `/downloads/${file}`, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), kind: file.endsWith('.dmg') ? 'dmg' : 'exe', ...(unpackedSize === undefined ? {} : { unpackedSize }), ...(helperVersion === undefined ? {} : { helperVersion }) };
  if (!cloudHelperDownload(platform, entry)) throw new Error(`Invalid helper download: ${platform}`);
  return entry;
}

export function mergeHelperDownloads(manifest, entries) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid helper manifest.');
  for (const [name, entry] of Object.entries(entries)) {
    if (!cloudHelperDownload(name, entry)) throw new Error(`Invalid helper download: ${name}`);
  }
  return { ...manifest, ...entries };
}

export async function updateHelperDownloads(downloads, entries) {
  const filename = path.join(downloads, 'concept-graph-helper-downloads.json');
  let manifest = {};
  try { manifest = JSON.parse(await readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const merged = mergeHelperDownloads(manifest, entries);
  await mkdir(downloads, { recursive: true });
  await writeFile(filename, JSON.stringify(merged, null, 2) + '\n');
}
