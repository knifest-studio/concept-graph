import path from 'node:path';
import { validateHelperSite } from './helper-build.mjs';

export function windowsHelperConfig(site) {
  return validateHelperSite(site) + '\n';
}

export function windowsHelperPayload(files) {
  if (!files.length || new Set(files).size !== files.length) throw new Error('Invalid Windows helper payload.');
  const quote = value => value.replaceAll('$', () => '$$').replaceAll('"', () => '$\\"');
  const directories = new Set(['']);
  const install = [], remove = [];
  for (const file of [...files].sort()) {
    if (typeof file !== 'string' || file.includes('${') || file.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error('Invalid Windows helper payload path.');
    let directory = path.posix.dirname(file);
    if (directory === '.') directory = '';
    install.push(`  SetOutPath "$INSTDIR${directory ? '\\' + quote(directory.replaceAll('/', '\\')) : ''}"`, `  File "/oname=${quote(path.posix.basename(file))}" "\${APP_DIR}/${file}"`);
    remove.push(`  Delete "$INSTDIR\\${quote(file.replaceAll('/', '\\'))}"`);
    while (directory) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
      if (directory === '.') break;
    }
  }
  for (const directory of [...directories].filter(Boolean).sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))) remove.push(`  RMDir "$INSTDIR\\${quote(directory.replaceAll('/', '\\'))}"`);
  return ['!macro InstallPayload', ...install, '!macroend', '', '!macro RemovePayload', ...remove, '!macroend', ''].join('\n');
}

export function windowsHelperIcon(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) throw new Error('Expected a 256px PNG helper icon.');
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14); header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}
