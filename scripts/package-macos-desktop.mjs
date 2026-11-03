import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.resolve(process.argv[2] || path.join(root, 'desktop-build', 'Concept Graph.app'));
const destination = path.resolve(process.argv[3] || path.join(root, 'desktop-build', 'Concept Graph-preview.dmg'));
const identity = process.env.CONCEPT_GRAPH_MAC_SIGN_IDENTITY;
const notaryProfile = process.env.CONCEPT_GRAPH_MAC_NOTARY_PROFILE;
if (notaryProfile && (!identity || !identity.startsWith('Developer ID Application:'))) throw new Error('Notarization requires CONCEPT_GRAPH_MAC_SIGN_IDENTITY with a full Developer ID Application identity.');
if (identity && !identity.startsWith('Developer ID Application:')) throw new Error('CONCEPT_GRAPH_MAC_SIGN_IDENTITY must be a full Developer ID Application identity, or omitted for an ad hoc preview.');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
};
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', source]);
if (identity) {
  for (const item of [source, path.join(source, 'Contents/Resources/runtime/node')]) {
    run('codesign', ['--verify', '--strict', '--verbose=2', item]);
    const details = spawnSync('codesign', ['--display', '--verbose=4', item], { encoding: 'utf8' });
    if (details.error) throw details.error;
    const output = details.stdout + details.stderr;
    if (details.status !== 0 || !output.includes(`Authority=${identity}\n`) || !/flags=.*\bruntime\b/.test(output) || !/^Timestamp=/m.test(output)) throw new Error('Distribution requires the app and bundled Node to have the selected Developer ID signature, Hardened Runtime and a secure timestamp. Rebuild with CONCEPT_GRAPH_MAC_SIGN_IDENTITY.');
  }
}
const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-dmg-'));
try {
  const staged = path.join(temp, 'Concept Graph.app');
  await cp(source, staged, { recursive: true, verbatimSymlinks: true });
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', staged]);
  await symlink('/Applications', path.join(temp, 'Applications'));
  await mkdir(path.dirname(destination), { recursive: true });
  run('hdiutil', ['create', '-srcfolder', temp, '-volname', 'Concept Graph', '-format', 'UDZO', destination]);
  if (identity) {
    run('codesign', ['--force', '--sign', identity, '--timestamp', destination]);
    run('codesign', ['--verify', '--verbose=2', destination]);
  }
  if (notaryProfile) {
    const submitted = spawnSync('xcrun', ['notarytool', 'submit', destination, '--keychain-profile', notaryProfile, '--wait', '--output-format', 'json'], { encoding: 'utf8' });
    if (submitted.error) throw submitted.error;
    let result;
    try { result = JSON.parse(submitted.stdout); } catch { throw new Error('Notarization did not return a JSON result. Check the selected Keychain profile and notarytool output.'); }
    if (submitted.status !== 0 || result.status !== 'Accepted') throw new Error(`Notarization was not accepted (status: ${result.status || 'unknown'}, id: ${result.id || 'unavailable'}). Do not publish this DMG.`);
    run('xcrun', ['stapler', 'staple', destination]);
    run('xcrun', ['stapler', 'validate', destination]);
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', destination]);
  }
  run('hdiutil', ['verify', destination]);
  console.log(`Built ${destination}`);
  if (identity && !notaryProfile) console.warn('Signed but not notarized: set CONCEPT_GRAPH_MAC_NOTARY_PROFILE before publishing.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
