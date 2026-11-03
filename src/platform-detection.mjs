export async function detectPlatform(device = globalThis.navigator) {
  const uaData = device?.userAgentData;
  const userAgent = device?.userAgent || '';
  const legacyPlatform = device?.platform || '';
  const reportedPlatform = uaData?.platform || legacyPlatform || userAgent;
  const isMobile = uaData?.mobile === true || /android|iphone|ipad|ipod|mobile/i.test(userAgent)
    || (/mac/i.test(legacyPlatform) && (device?.maxTouchPoints || 0) > 1);
  let platform = 'unknown';
  if (isMobile || /android|ios|iphone|ipad|ipod/i.test(reportedPlatform)) platform = 'mobile';
  else if (/mac/i.test(reportedPlatform)) platform = 'macos';
  else if (/win/i.test(reportedPlatform)) platform = 'windows';
  else if (/linux/i.test(reportedPlatform) && !/cros|chrome ?os/i.test(reportedPlatform)) platform = 'linux';

  let architecture = 'unknown';
  if ((platform === 'macos' || platform === 'windows') && typeof uaData?.getHighEntropyValues === 'function') {
    try {
      const hints = await uaData.getHighEntropyValues(['architecture', 'bitness']);
      const arch = (hints?.architecture || '').toLowerCase();
      const bits = hints?.bitness || '';
      if ((arch === 'arm' && bits === '64') || ((arch === 'arm64' || arch === 'aarch64') && bits !== '32')) architecture = 'arm64';
      else if ((arch === 'x86' && bits === '64') || ((arch === 'x64' || arch === 'x86_64' || arch === 'amd64') && bits !== '32')) architecture = 'x64';
      else if (arch === 'x86' && bits === '32') architecture = 'x86';
    } catch { /* The browser may withhold architecture hints. */ }
  }

  const packageId = platform === 'macos' && architecture === 'arm64' ? 'macos-arm64'
    : platform === 'macos' && architecture === 'x64' ? 'macos-x64'
      : platform === 'windows' && architecture === 'x64' ? 'windows-x64' : null;
  return { platform, architecture, packageId };
}
