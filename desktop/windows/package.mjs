import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yauzl from 'yauzl';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const [publishArg, nodeArchiveArg, distArg, outputArg] = process.argv.slice(2);
if (!publishArg || !nodeArchiveArg || !distArg || !outputArg) {
  throw new Error('Usage: node desktop/windows/package.mjs <windows-publish-dir> <node-win-x64.zip> <local-dist-dir> <new-output-dir>');
}
const publish = path.resolve(publishArg), archive = path.resolve(nodeArchiveArg);
const dist = path.resolve(distArg), output = path.resolve(outputArg);
const nodeDigest = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33';
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== nodeDigest) throw new Error('Node.js archive checksum mismatch.');
await stat(path.join(publish, 'Concept Graph.exe'));
await stat(path.join(dist, 'index.html'));
const runtimeConfig = JSON.parse(await readFile(path.join(publish, 'Concept Graph.runtimeconfig.json'), 'utf8'));
const dependencies = JSON.parse(await readFile(path.join(publish, 'Concept Graph.deps.json'), 'utf8'));
const frameworkVersion = name => runtimeConfig.runtimeOptions.includedFrameworks.find(item => item.name === name)?.version;
const coreVersion = frameworkVersion('Microsoft.NETCore.App');
const desktopVersion = frameworkVersion('Microsoft.WindowsDesktop.App');
const webview = Object.keys(dependencies.libraries).find(item => item.startsWith('Microsoft.Web.WebView2/'))?.split('/')[1];
if (!coreVersion || !desktopVersion || !webview) throw new Error('Could not determine the bundled .NET or WebView2 versions.');
const nuget = process.env.NUGET_PACKAGES || path.join(homedir(), '.nuget', 'packages');
const notices = [
  [`microsoft.netcore.app.runtime.win-x64/${coreVersion}/LICENSE.TXT`, 'DOTNET-LICENSE.txt'],
  [`microsoft.netcore.app.runtime.win-x64/${coreVersion}/THIRD-PARTY-NOTICES.TXT`, 'DOTNET-THIRD-PARTY-NOTICES.txt'],
  [`microsoft.windowsdesktop.app.runtime.win-x64/${desktopVersion}/LICENSE`, 'WINDOWSDESKTOP-LICENSE.txt'],
  [`microsoft.web.webview2/${webview}/LICENSE.txt`, 'WEBVIEW2-LICENSE.txt'],
  [`microsoft.web.webview2/${webview}/NOTICE.txt`, 'WEBVIEW2-NOTICE.txt'],
];
for (const [file] of notices) await stat(path.join(nuget, file));
await mkdir(output);
for (const entry of await readdir(publish)) {
  if (/\.(pdb|xml)$/i.test(entry)) continue;
  await cp(path.join(publish, entry), path.join(output, entry), { recursive: true, errorOnExist: true, force: false });
}
const app = path.join(output, 'app');
const runtime = path.join(output, 'runtime');
const licenseDir = path.join(output, 'ThirdPartyLicenses');
await mkdir(app);
await mkdir(runtime);
await mkdir(licenseDir);
for (const [file, name] of notices) await cp(path.join(nuget, file), path.join(licenseDir, name));
const files = new Map([
  ['node-v22.22.3-win-x64/node.exe', path.join(runtime, 'node.exe')],
  ['node-v22.22.3-win-x64/LICENSE', path.join(output, 'NODE-LICENSE')],
]);
await new Promise((resolve, reject) => {
  yauzl.open(archive, { lazyEntries: true }, (openError, zip) => {
    if (openError) return reject(openError);
    const found = new Set();
    zip.on('error', reject);
    zip.on('end', () => found.size === files.size ? resolve() : reject(new Error('Node.js executable or license is missing.')));
    zip.on('entry', entry => {
      if (!files.has(entry.fileName)) return zip.readEntry();
      if (found.has(entry.fileName)) return reject(new Error('Duplicate Node.js archive entry.'));
      found.add(entry.fileName);
      zip.openReadStream(entry, async (streamError, stream) => {
        if (streamError) return reject(streamError);
        try { await pipeline(stream, createWriteStream(files.get(entry.fileName), { flags: 'wx' })); zip.readEntry(); }
        catch (error) { zip.close(); reject(error); }
      });
    });
    zip.readEntry();
  });
});
for (const file of ['server.mjs', 'mcp.mjs', 'mcp-coordinator.mjs', 'codex.mjs', 'workspace.mjs', 'desktop-preferences.mjs', 'graph.mjs', 'board-archive.mjs', 'helper-auth.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await cp(path.join(root, file), path.join(app, file));
}
await mkdir(path.join(app, 'src'), { recursive: true });
for (const file of ['canvas.mjs', 'node-template.mjs', 'annotations.mjs', 'pages.mjs', 'theme.mjs', 'layers.mjs', 'sections.mjs', 'node-placement.mjs', 'image-edits.mjs']) await cp(path.join(root, 'src', file), path.join(app, 'src', file));
for (const dependency of ['yauzl', 'yazl', 'pend', 'buffer-crc32']) {
  await cp(path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency), { recursive: true });
}
await cp(dist, path.join(app, 'dist'), { recursive: true });
console.log(`Windows desktop prototype: ${output}`);
