export const helperDownloadFiles = {
  'macos-arm64': 'Concept-Graph-Helper-macos-arm64.dmg',
  'macos-x64': 'Concept-Graph-Helper-macos-x64.dmg',
  'windows-x64': 'Concept-Graph-Helper-windows-x64-setup.exe',
};

export function helperDownloadType(file) {
  if (!Object.values(helperDownloadFiles).includes(file)) return null;
  return file.endsWith('.dmg') ? 'application/x-apple-diskimage' : 'application/vnd.microsoft.portable-executable';
}

export function cloudHelperDownload(platform, entry) {
  const file = Object.hasOwn(helperDownloadFiles, platform) ? helperDownloadFiles[platform] : null;
  if (!file || entry?.file !== file || entry.url !== `/downloads/${file}` ||
      entry.kind !== (file.endsWith('.dmg') ? 'dmg' : 'exe') || !Number.isSafeInteger(entry.size) || entry.size < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.helperVersion !== undefined && (typeof entry.helperVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?-[a-f0-9]{10}$/.test(entry.helperVersion))) ||
      (entry.unpackedSize !== undefined && (!Number.isSafeInteger(entry.unpackedSize) || entry.unpackedSize < 1))) return null;
  return entry;
}

export function helperOutdated(helperVersion, download) {
  return !!download?.helperVersion && helperVersion !== download.helperVersion;
}

export async function fetchHelperArchive(platform, onProgress = () => {}, fetchResource = fetch) {
  if (!['macos-arm64', 'macos-x64', 'windows-x64'].includes(platform)) throw new Error('Unsupported helper platform.');
  const manifestResponse = await fetchResource('/concept-graph-helper-manifest.json');
  if (!manifestResponse.ok) throw new Error('Helper downloads are unavailable.');
  const manifest = await manifestResponse.json(), item = manifest[platform];
  if (!item || item.parts !== 2 || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 128 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid helper download information.');
  const parts = [];
  for (let i = 1; i <= item.parts; i++) {
    onProgress(`Downloading part ${i} of ${item.parts}…`);
    const response = await fetchResource(`/concept-graph-helper-${platform}.zip.${String(i).padStart(3, '0')}`);
    if (!response.ok) throw new Error('Could not download the helper.');
    parts.push(await response.arrayBuffer());
  }
  const blob = new Blob(parts, { type: 'application/zip' });
  if (blob.size !== item.size) throw new Error('The helper download is incomplete.');
  onProgress('Checking download…');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const checksum = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (checksum !== item.sha256) throw new Error('The helper download failed its integrity check.');
  return blob;
}
