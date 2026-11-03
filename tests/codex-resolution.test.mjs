import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findWindowsCodex, resolveCodex, codexInstallOptions } from '../codex.mjs';

test('managed locations match desktop layouts, overrides and supported architectures', () => {
  const mac = codexInstallOptions({ HOME: '/Users/test' }, 'darwin', 'arm64');
  assert.equal(mac.executable, '/Users/test/Library/Application Support/Concept Graph Settings/codex-cli/0.163.0/bin/codex');
  assert.match(mac.url, /aarch64-apple-darwin/);
  assert.match(codexInstallOptions({}, 'darwin', 'x64').url, /x86_64-apple-darwin/);
  const win = codexInstallOptions({ LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', SystemRoot: 'C:\\Windows' }, 'win32', 'arm64');
  assert.equal(win.executable, 'C:\\Users\\test\\AppData\\Local\\Concept Graph\\codex\\0.163.0-win-x64\\bin\\codex.exe');
  assert.match(win.url, /x86_64-pc-windows-msvc/); assert.equal(win.tar, 'C:\\Windows\\System32\\tar.exe');
  assert.equal(codexInstallOptions({}, 'linux', 'x64').supported, false);
  assert.equal(codexInstallOptions({}, 'darwin', 'ia32').supported, false);
  assert.equal(codexInstallOptions({ CONCEPT_GRAPH_DESKTOP_SETTINGS: '/tmp/settings/storage.json' }, 'darwin', 'x64').root, '/tmp/settings/codex-cli');
});

test('user Codex wins over managed copies, which are the fallback on Mac and Windows', () => {
  for (const platform of ['darwin', 'win32']) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const root = platform === 'win32' ? 'C:\\Test' : '/test';
    const env = { PATH: paths.join(root, 'tools'), CONCEPT_GRAPH_CODEX_INSTALL_DIR: paths.join(root, 'managed') };
    const managed = codexInstallOptions(env, platform, 'x64').executable;
    const own = paths.join(env.PATH, platform === 'win32' ? 'codex.exe' : 'codex');
    assert.equal(resolveCodex(env, platform, 'x64', file => file === managed || file === own), own);
    assert.equal(resolveCodex(env, platform, 'x64', file => file === managed), managed);
    assert.equal(resolveCodex({ ...env, CODEX_BIN: own }, platform, 'x64', file => file === managed || file === own), own);
    assert.throws(() => resolveCodex(env, platform, 'x64', () => false), { codexMissing: true });
    if (platform === 'win32') {
      const shim = { ...env, CODEX_BIN: 'C:\\Missing\\codex.cmd' };
      assert.equal(resolveCodex(shim, platform, 'x64', file => file === managed), managed);
      assert.throws(() => resolveCodex(shim, platform, 'x64', () => false), { codexMissing: true });
    }
  }
});

test('Windows finds a native Codex executable without invoking a shell or Node shim', () => {
  const env = { Path: 'C:\\Program Files\\Tools;C:\\Users\\User\\AppData\\Roaming\\npm', LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local' };
  const npm = 'C:\\Users\\User\\AppData\\Roaming\\npm';
  const shim = npm + '\\codex.cmd';
  const vendor = npm + '\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const files = new Set([shim, vendor]);
  assert.equal(findWindowsCodex(env, 'x64', file => files.has(file)), vendor);
  assert.equal(findWindowsCodex({ ...env, CODEX_BIN: shim }, 'x64', file => files.has(file)), vendor);

  const standalone = 'C:\\Users\\User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe';
  assert.equal(findWindowsCodex({ ...env, Path: '' }, 'x64', file => file === standalone), standalone);
  assert.equal(findWindowsCodex({ ...env, CODEX_BIN: 'D:\\custom\\codex.exe' }, 'x64', () => false), 'D:\\custom\\codex.exe');
  assert.throws(() => findWindowsCodex({ ...env, CODEX_BIN: shim }, 'x64', () => false), /native Codex executable/);
  assert.equal(findWindowsCodex({ Path: '' }, 'x64', () => false), 'codex.exe');

  const local = 'C:\\Users\\User\\.local\\bin\\codex.exe';
  assert.equal(findWindowsCodex({ Path: '', USERPROFILE: 'C:\\Users\\User' }, 'x64', file => file === local), local);
  const managed = 'C:\\Users\\User\\AppData\\Local\\Concept Graph\\codex\\0.163.0-win-x64\\bin\\codex.exe';
  assert.equal(findWindowsCodex({ ...env, Path: '' }, 'x64', file => file === managed), managed);
});

test('Windows ARM64 resolves the matching npm vendor binary', () => {
  const shim = 'C:\\npm\\codex.cmd';
  const vendor = 'C:\\npm\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe';
  assert.equal(findWindowsCodex({ PATH: 'C:\\npm' }, 'arm64', file => file === shim || file === vendor), vendor);
});

test('Windows finds the default npm install outside PATH, including mixed-case environment keys', () => {
  const appData = 'C:\\Users\\Пан Knifest! & (test)\\AppData\\Roaming';
  const npm = appData + '\\npm';
  const vendor = npm + '\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe';
  const files = new Set([npm + '\\codex.cmd', vendor]);
  assert.equal(findWindowsCodex({ Path: 'C:\\Windows\\System32', AppData: appData }, 'x64', file => files.has(file)), vendor);
  const native = 'D:\\Tools\\codex.exe';
  assert.equal(findWindowsCodex({ PATH: 'D:\\Tools', APPDATA: appData }, 'x64', file => file === native || files.has(file)), native);
});

test('Windows resolves PowerShell and batch overrides to native executables, never to a shell', () => {
  const npm = 'D:\\Codex Tools! & (test)';
  const vendor = npm + '\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe';
  for (const extension of ['cmd', 'CMD', 'bat', 'ps1', 'PS1']) {
    const shim = npm + '\\codex.' + extension;
    const exists = file => file === shim || file === vendor;
    assert.equal(findWindowsCodex({ CODEX_BIN: shim, PATH: 'C:\\Unrelated' }, 'x64', exists), vendor);
    assert.equal(findWindowsCodex({ CODEX_BIN: 'codex.' + extension, Path: `"${npm}"` }, 'x64', exists), vendor);
    assert.throws(() => findWindowsCodex({ CODEX_BIN: shim, PATH: 'C:\\Unrelated' }, 'x64', file => file === 'C:\\Unrelated\\codex.exe'), /native Codex executable/);
  }
  const shim = npm + '\\codex.ps1';
  assert.equal(findWindowsCodex({ PATH: npm }, 'x64', file => file === shim || file === vendor), vendor);
  const native = npm + '\\codex.exe';
  assert.equal(findWindowsCodex({ CODEX_BIN: shim }, 'x64', file => file === shim || file === native), native);
});

test('Windows keeps searching after a broken npm install and supports legacy vendor layouts', () => {
  const npm = 'C:\\npm';
  const vendor = npm + '\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const files = new Set(['C:\\Broken\\codex.cmd', npm + '\\codex.cmd', vendor]);
  assert.equal(findWindowsCodex({ PATH: 'C:\\Broken;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'x64', file => files.has(file)), vendor);
});

test('Windows resolves a project-local npm shim from node_modules/.bin', () => {
  const modules = 'C:\\My Project\\node_modules';
  const shim = modules + '\\.bin\\codex.cmd';
  const vendor = modules + '\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
  const exists = file => file === shim || file === vendor;
  assert.equal(findWindowsCodex({ PATH: modules + '\\.bin' }, 'x64', exists), vendor);
  assert.equal(findWindowsCodex({ CODEX_BIN: shim }, 'x64', exists), vendor);
});

test('Windows anchors relative CODEX_BIN paths before spawning in the data directory', () => {
  const directory = path.win32.resolve('Codex Tools');
  const native = directory + '\\codex.exe';
  assert.equal(findWindowsCodex({ CODEX_BIN: '.\\Codex Tools\\codex.exe' }, 'x64', () => false), native);
  const shim = directory + '\\codex.cmd';
  assert.equal(findWindowsCodex({ CODEX_BIN: '.\\Codex Tools\\codex.cmd' }, 'x64', file => file === shim || file === native), native);
});
