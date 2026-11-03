import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowsHelperLauncher, helperFiles, dependencies } from '../scripts/helper-build.mjs';
import { windowsHelperConfig, windowsHelperPayload, windowsHelperIcon } from '../scripts/windows-helper-build.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('native Windows launcher config contains only normalized HTTPS origins', () => {
  assert.equal(windowsHelperConfig(' https://BOARDS.example:443/,https://preview.example:8443 '), 'https://boards.example,https://preview.example:8443\n');
  assert.equal(windowsHelperConfig('https://[::1]:8443'), 'https://[::1]:8443\n');
  for (const site of [undefined, '', 'http://boards.example', 'https://user:pass@boards.example', 'https://boards.example/path', 'https://boards.example?', 'https://boards.example#', 'https://boards.example,', 'https://boards.example\n.evil', 'https://boards.example\\evil']) assert.throws(() => windowsHelperConfig(site), /HTTPS origins only/);
});

test('NSIS payload installs exact files and removes only those files and empty directories', () => {
  const files = ['runtime/node.exe', 'node_modules/yauzl/index.js', 'Concept Graph Helper.exe', 'helper-site.txt', 'node_modules/yauzl/lib/$data.js'];
  const payload = windowsHelperPayload(files);
  assert.equal(windowsHelperPayload([...files].reverse()), payload);
  assert.ok(payload.includes('File "/oname=Concept Graph Helper.exe" "${APP_DIR}/Concept Graph Helper.exe"'));
  assert.ok(payload.includes('SetOutPath "$INSTDIR\\runtime"\n  File "/oname=node.exe" "${APP_DIR}/runtime/node.exe"'));
  assert.ok(payload.includes('Delete "$INSTDIR\\node_modules\\yauzl\\lib\\$$data.js"'));
  assert.ok(payload.includes('RMDir "$INSTDIR\\node_modules\\yauzl\\lib"'));
  assert.ok(payload.indexOf('RMDir "$INSTDIR\\node_modules\\yauzl\\lib"') < payload.indexOf('RMDir "$INSTDIR\\node_modules\\yauzl"'));
  assert.ok(payload.indexOf('RMDir "$INSTDIR\\node_modules\\yauzl"') < payload.indexOf('RMDir "$INSTDIR\\node_modules"'));
  assert.doesNotMatch(payload, /\b(?:RMDir|File)\s+\/r\b|REBOOTOK|\.concept-graph|\$PROFILE|\$LOCALAPPDATA/);
  assert.equal((payload.match(/^  File /gm) || []).length, files.length);
  assert.equal((payload.match(/^  Delete /gm) || []).length, files.length);
  for (const files of [[], ['same', 'same'], ['../secret'], ['/secret'], ['runtime/../../secret'], ['runtime\\secret'], ['file:stream'], ['file*'], ['file"'], ['file\n'], ['${APP_DIR}/file'], ['folder./file'], ['folder /file'], [null]]) assert.throws(() => windowsHelperPayload(files), /Invalid Windows helper payload/);
});

test('Windows ICO wraps the rendered 256px site PNG without changing its bytes', () => {
  const png = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(256, 16); png.writeUInt32BE(256, 20);
  const ico = windowsHelperIcon(png);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.equal(ico.readUInt32LE(18), 22);
  assert.deepEqual(ico.subarray(22), png);
  for (const bytes of [Buffer.from('invalid'), Buffer.alloc(32), null]) assert.throws(() => windowsHelperIcon(bytes), /256px PNG/);
  png.writeUInt32BE(128, 16);
  assert.throws(() => windowsHelperIcon(png), /256px PNG/);
});

test('the real NSIS script compiles a Unicode payload with spaces and literal dollar signs without warnings', async t => {
  const makensis = process.env.CONCEPT_GRAPH_MAKENSIS || '/opt/homebrew/bin/makensis';
  if (spawnSync(makensis, ['-VERSION']).error?.code === 'ENOENT') return t.skip('NSIS is not installed');
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-helper-інсталятор with spaces-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'app'), payload = path.join(directory, 'payload.nsh'), output = path.join(directory, 'Concept-Graph-Helper-windows-x64-setup.exe');
  const files = ['Concept Graph Helper.exe', 'helper-site.txt', 'node_modules/test/$data.js'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(app, file)), { recursive: true });
    await writeFile(path.join(app, file), 'test payload');
  }
  await writeFile(payload, windowsHelperPayload(files));
  const result = spawnSync(makensis, ['-WX', '-V2', `-DAPP_DIR=${app}`, `-DPAYLOAD_INCLUDE=${payload}`, `-DOUTPUT_FILE=${output}`, '-DPRODUCT_VERSION=1.2.3', '-DHELPER_VERSION=1.2.3-0123456789', '-DHELPER_SIZE_KIB=1', path.join(root, 'desktop/windows-helper/installer.nsi')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8' } });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await readFile(output)).subarray(0, 2).toString(), 'MZ');
});

test('Windows launcher quotes paths, handles UNC directories and disables inherited delayed expansion', () => {
  const launcher = windowsHelperLauncher('https://boards.example');
  assert.ok(!/(?<!\r)\n/.test(launcher), 'batch files use CRLF');
  assert.match(launcher, /^@echo off\r\nsetlocal DisableDelayedExpansion\r\npushd "%~dp0"\r\n/);
  assert.ok(launcher.includes('pushd "%~dp0"\r\nif errorlevel 1 exit /b 1\r\n'));
  assert.ok(launcher.includes('set "PATH=%~dp0runtime;%PATH%"\r\n'));
  assert.ok(launcher.includes('set "CONCEPT_GRAPH_SITE=https://boards.example"\r\n'));
  assert.ok(launcher.includes('"%~dp0runtime\\node.exe" "%~dp0helper.mjs"\r\nset "helperExitCode=%errorlevel%"\r\npopd\r\npause\r\nexit /b %helperExitCode%\r\n'));
  assert.ok(!windowsHelperLauncher().includes('CONCEPT_GRAPH_SITE='));
});

test('portable helper includes all local runtime imports and external dependencies', async () => {
  for (const file of helperFiles.filter(file => file.endsWith('.mjs'))) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('./')) assert.ok(helperFiles.includes(specifier.slice(2)), `${file} requires ${specifier}`);
      else assert.ok(dependencies.includes(specifier), `${file} requires ${specifier}`);
    }
  }
});

test('Windows executes the generated launcher from a Unicode path with spaces and shell metacharacters', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'concept-helper-Пан Knifest! & (test)-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'runtime'));
  await cp(process.execPath, path.join(directory, 'runtime', 'node.exe'));
  await writeFile(path.join(directory, 'Start Concept Graph.cmd'), windowsHelperLauncher('https://boards.example'));
  // Exercise the real batch file without starting the helper or binding a server.
  await writeFile(path.join(directory, 'helper.mjs'), `console.log('LAUNCH:' + JSON.stringify({ cwd: process.cwd(), path: process.env.PATH, site: process.env.CONCEPT_GRAPH_SITE })); process.exitCode = 7;`);
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/v:on', '/s', '/c', '""Start Concept Graph.cmd""'], {
    cwd: directory, encoding: 'utf8', input: '\r\n', windowsVerbatimArguments: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.match(/LAUNCH:(.+)/)?.[1] || 'null');
  assert.equal(output?.cwd, directory);
  assert.equal(output.site, 'https://boards.example');
  assert.ok(output.path.startsWith(path.join(directory, 'runtime') + ';'));
});
