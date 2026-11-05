import test from 'node:test';
import assert from 'node:assert/strict';

async function audioHarness(t, { resume, broken = false } = {}) {
  const previous = { document: globalThis.document, AudioContext: globalThis.AudioContext };
  const contexts = [], oscillators = [], gains = [], compressors = [], noises = [], filters = [], listeners = {};
  const parameter = () => ({ value: 0, points: [], setValueAtTime(value, time) { this.points.push([value, time]); }, linearRampToValueAtTime(value, time) { this.points.push([value, time]); }, exponentialRampToValueAtTime(value, time) { this.points.push([value, time]); } });
  globalThis.document = { hidden: false, addEventListener: (type, callback) => { listeners[type] = callback; } };
  globalThis.AudioContext = class {
    constructor() { if (broken) throw new Error('no audio'); this.state = 'suspended'; this.currentTime = 10; this.sampleRate = 44100; contexts.push(this); }
    resume() { if (resume) return resume(this); this.state = 'running'; return Promise.resolve(); }
    createDynamicsCompressor() { const compressor = { threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(), connect(destination) { this.destination = destination; } }; compressors.push(compressor); return compressor; }
    createBuffer(_, length) { const samples = new Float32Array(length); return { getChannelData: () => samples }; }
    createBufferSource() { const noise = { connect() {}, disconnect() {}, start() {}, stop() {} }; noises.push(noise); return noise; }
    createBiquadFilter() { const filter = { frequency: parameter(), Q: parameter(), connect() {}, disconnect() {} }; filters.push(filter); return filter; }
    createGain() { const gain = { gain: parameter(), connect(destination) { this.destination = destination; }, disconnect() {} }; gains.push(gain); return gain; }
    createOscillator() { const oscillator = { frequency: parameter(), connect() {}, disconnect() {}, start(time) { this.started = time; }, stop(time) { this.stopped = time; } }; oscillators.push(oscillator); return oscillator; }
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  });
  const sounds = await import(`../src/sounds.mjs?test=${crypto.randomUUID()}`);
  return { ...sounds, contexts, oscillators, gains, compressors, noises, filters, listeners };
}

test('one lazy context plays an audible launch, a rising chime and a falling failure tone', async t => {
  const audio = await audioHarness(t);
  await audio.playSound('start'); assert.equal(audio.contexts.length, 0);
  audio.unlockSounds(); audio.unlockSounds();
  assert.equal(audio.contexts.length, 1); assert.equal(audio.gains[0].gain.value, .55);
  assert.equal(audio.compressors.length, 1); assert.equal(audio.gains[0].destination, audio.compressors[0]); assert.equal(audio.compressors[0].ratio.value, 6);
  // The second output carries only calls, which also play in a background tab.
  assert.equal(audio.gains[1].gain.value, .55); assert.equal(audio.gains[1].destination, audio.compressors[0]);
  await audio.playSound('start');
  assert.equal(audio.noises.length, 1);
  const sweep = audio.filters[0].frequency.points; assert.ok(sweep[1][0] > sweep[0][0]);
  assert.equal(audio.oscillators[0].type, 'triangle');
  assert.ok(Math.abs(audio.oscillators[0].stopped - audio.oscillators[0].started - .14) < 1e-9);
  await audio.playSound('arrival');
  const chime = audio.oscillators.slice(2, 5).map(o => o.frequency.points[0][0]);
  assert.ok(chime[0] < chime[1] && chime[1] < chime[2]);
  await audio.playSound('error');
  const [first, second] = audio.oscillators.slice(6, 8);
  assert.ok(second.frequency.points[0][0] < first.frequency.points[0][0]);
  for (const gain of audio.gains.slice(2)) {
    assert.ok(gain.gain.points[0][0] <= .001 && gain.gain.points.at(-1)[0] <= .001);
    assert.ok(gain.gain.points[1][0] <= .35);
  }
  const count = audio.oscillators.length;
  document.hidden = true; audio.listeners.visibilitychange();
  await audio.playSound('arrival'); assert.equal(audio.oscillators.length, count); assert.equal(audio.gains[0].gain.value, 0);
  await audio.playSound('call', () => true, { background: true });
  assert.ok(audio.oscillators.length > count); assert.ok(audio.gains.slice(-1)[0].destination === audio.gains[1]);
  const called = audio.oscillators.length;
  document.hidden = false; audio.listeners.visibilitychange(); assert.equal(audio.gains[0].gain.value, .55);
  await audio.playSound('start', () => false); await audio.playSound('call', () => false, { background: true }); assert.equal(audio.oscillators.length, called);
});

test('a gesture resume can finish asynchronously without playing after mute or tab hide', async t => {
  let finish;
  const audio = await audioHarness(t, { resume: context => new Promise(resolve => { finish = () => { context.state = 'running'; resolve(); }; }) });
  audio.unlockSounds();
  let enabled = true;
  const playing = audio.playSound('start', () => enabled);
  enabled = false; finish(); await playing;
  assert.equal(audio.oscillators.length, 0);
  document.hidden = true; await audio.playSound('start'); assert.equal(audio.oscillators.length, 0);
});

test('Web Audio failures never escape into app actions', async t => {
  const audio = await audioHarness(t, { broken: true });
  assert.doesNotThrow(() => audio.unlockSounds());
  await assert.doesNotReject(audio.playSound('start'));
  delete globalThis.AudioContext;
  assert.doesNotThrow(() => audio.unlockSounds());
});


test('step pitches rise, remove sweeps down, and confirmation meanings have distinct notes', async t => {
  const audio = await audioHarness(t); audio.unlockSounds();
  for (let index = 0; index < 4; index++) await audio.playSound('step', () => true, { index });
  const steps = audio.oscillators.map(o => o.frequency.points[0][0]);
  assert.ok(steps.every((pitch, index) => !index || pitch > steps[index - 1]));
  await audio.playSound('remove');
  const sweep = audio.filters.at(-1).frequency.points; assert.ok(sweep[1][0] < sweep[0][0]);
  for (const kind of ['success', 'celebrate', 'drop', 'tick-up', 'tick-down', 'connect', 'create']) {
    const before = audio.oscillators.length; await audio.playSound(kind); assert.ok(audio.oscillators.length > before, kind);
  }
  const before = audio.oscillators.length; await audio.playSound('unknown'); assert.equal(audio.oscillators.length, before);
});
