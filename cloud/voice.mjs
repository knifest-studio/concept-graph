export const maxVoice = 8, maxSignalBytes = 24 * 1024;
export const voiceHasSpace = (ids, own) => new Set(ids.filter(id => id !== own)).size < maxVoice;
export function voiceSignal(value) {
  if (!Number.isSafeInteger(value?.to) || value.to < 0 || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) return false;
  return new TextEncoder().encode(JSON.stringify(value.data)).byteLength <= maxSignalBytes;
}
export const stunServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
export function browserIceServers(servers) {
  if (!Array.isArray(servers)) throw new Error('Invalid voice credentials.');
  return servers.flatMap(server => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => typeof url === 'string' && /^(stun|turn|turns):/.test(url) && !/:53(?:\?|$)/.test(url));
    return urls.length ? [{ urls, ...(typeof server.username === 'string' ? { username: server.username } : {}), ...(typeof server.credential === 'string' ? { credential: server.credential } : {}) }] : [];
  });
}
export async function voiceIce(env, fetcher = fetch) {
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: stunServers };
  const response = await fetcher(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 201) throw new Error('Voice credentials are unavailable. Try again.');
  const iceServers = browserIceServers((await response.json()).iceServers);
  if (!iceServers.length) throw new Error('Voice credentials are unavailable. Try again.');
  return { iceServers };
}
