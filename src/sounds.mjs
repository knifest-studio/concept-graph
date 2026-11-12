export const soundPreferenceKey = viewer => `concept-graph-sounds:${viewer}`;
export function readSoundPreference(storage, key) {
  try { return storage.getItem(key) !== 'off'; } catch { return true; }
}
export function writeSoundPreference(storage, key, enabled) {
  try { storage.setItem(key, enabled ? 'on' : 'off'); } catch {}
}
export function eventOnce(seen, id) {
  if (seen.has(id)) return false;
  seen.add(id); return true;
}

export const pitchVariation = (random = Math.random) => .96 + Math.max(0, Math.min(1, random())) * .08;

let context, master, alert, resuming;
const volume = .55;
// [frequency from, to, delay s, length s, wave, peak gain]; each note decays exponentially like a soft mallet.
const sounds = {
  chat: [[880, 990, 0, .12, 'sine', .055]],
  'voice-join': [[523, 659, 0, .15, 'sine', .065]],
  'voice-leave': [[659, 440, 0, .15, 'sine', .055]],
  start: [[330, 660, 0, .14, 'triangle', .32], [660, 1320, 0, .1, 'sine', .08]],
  arrival: [[1046.5, 1046.5, 0, .45, 'sine', .3], [1318.5, 1318.5, .08, .45, 'sine', .28], [1568, 1568, .16, .6, 'sine', .26], [523.25, 523.25, 0, .5, 'triangle', .1]],
  error: [[440, 415, 0, .18, 'sine', .28], [349, 330, .14, .26, 'sine', .26]],
  create: [[520, 880, 0, .09, 'sine', .22]],
  drop: [[230, 180, 0, .06, 'sine', .035]],
  remove: [[420, 160, 0, .18, 'triangle', .09]],
  success: [[660, 660, 0, .13, 'sine', .18], [880, 880, .1, .2, 'sine', .18]],
  step: [[740, 740, 0, .25, 'sine', .18]],
  celebrate: [[523, 523, 0, .18, 'triangle', .18], [659, 659, .1, .18, 'triangle', .18], [784, 784, .2, .18, 'triangle', .18], [1046, 1046, .3, .45, 'sine', .24]],
  'tick-up': [[780, 1000, 0, .065, 'sine', .08]],
  'tick-down': [[650, 460, 0, .065, 'sine', .07]],
  connect: [[900, 1250, 0, .05, 'triangle', .18], [1800, 1800, .01, .06, 'sine', .06]],
  // A teammate calling: a two-note door chime, played twice.
  call: [[1318.5, 1318.5, 0, .5, 'sine', .3], [1046.5, 1046.5, .22, .7, 'sine', .3], [1318.5, 1318.5, .9, .5, 'sine', .22], [1046.5, 1046.5, 1.12, .8, 'sine', .22], [659.25, 659.25, 0, .6, 'triangle', .06]],
};
export function unlockSounds() {
  try {
    if (document.hidden) return;
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Audio) return;
    if (!context) {
      context = new Audio(); master = context.createGain();
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -12; compressor.knee.value = 16; compressor.ratio.value = 6; compressor.attack.value = .003; compressor.release.value = .2;
      master.gain.value = volume; master.connect(compressor); compressor.connect(context.destination);
      // Collaboration alerts also play in background tabs, where they are most needed.
      alert = context.createGain(); alert.gain.value = volume; alert.connect(compressor);
      document.addEventListener('visibilitychange', () => { master.gain.value = document.hidden ? 0 : volume; });
    }
    if (context.state === 'suspended') { resuming = context.resume(); resuming.catch(() => {}); }
  } catch {}
}
export async function playSound(kind, allowed = () => true, { index = 0, background = false } = {}) {
  try {
    if (resuming) await resuming;
    if (!allowed() || (document.hidden && !background) || context?.state !== 'running') return;
    const output = background ? alert : master;
    const pitch = pitchVariation() * (kind === 'arrival' ? [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3][Math.floor(Math.random() * 5)] : kind === 'step' ? 2 ** (Math.max(0, Math.min(3, index)) / 12 * 2) : 1);
    const jitter = Math.random() * .008;
    if (kind === 'start' || kind === 'remove') {
      const duration = kind === 'start' ? .32 : .18, buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
      const noise = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain(), start = context.currentTime + jitter;
      noise.buffer = buffer; filter.type = 'bandpass'; filter.Q.value = .8;
      filter.frequency.setValueAtTime((kind === 'start' ? 350 : 1500) * pitch, start); filter.frequency.exponentialRampToValueAtTime((kind === 'start' ? 2200 : 250) * pitch, start + duration);
      gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(.12, start + .03); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      noise.connect(filter); filter.connect(gain); gain.connect(master); noise.start(start); noise.stop(start + duration);
      noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); };
    }
    for (const [from, to, delay, duration, type, peak] of sounds[kind] || []) {
      const oscillator = context.createOscillator(), gain = context.createGain(), start = context.currentTime + delay + jitter;
      oscillator.type = type; oscillator.frequency.setValueAtTime(from * pitch, start); oscillator.frequency.exponentialRampToValueAtTime(to * pitch, start + duration * .6);
      gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(peak, start + .006); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
      oscillator.connect(gain); gain.connect(output); oscillator.start(start); oscillator.stop(start + duration);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    }
  } catch {}
}
