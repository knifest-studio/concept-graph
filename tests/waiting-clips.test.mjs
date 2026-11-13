import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allWaitingVideos, clipAt, clipPattern, loadWaitingVideos, resetWaitingVideos, siteClipUrls } from '../src/waiting-videos.mjs';
import { waitingSeed } from '../src/run-placeholders.mjs';
import { maxClipBytes, waitingClipUploads } from '../scripts/upload-waiting-clips.mjs';

test('the site index only yields clip names the worker will serve back', () => {
  assert.deepEqual(siteClipUrls(['subway-surfers.mp4', 'surf-02.mp4']), ['/clips/subway-surfers.mp4', '/clips/surf-02.mp4']);
  assert.deepEqual(siteClipUrls(['a.mp4', 'a.mp4']), ['/clips/a.mp4']);
  for (const bad of [['../../etc/passwd'], ['nested/clip.mp4'], ['clip.mp4?x=1'], ['Clip.mp4'], ['clip.webm'], ['-clip.mp4'], ['.mp4'], [`${'a'.repeat(41)}.mp4`], [null], [12], [{ name: 'clip.mp4' }]]) {
    assert.deepEqual(siteClipUrls(bad), [], `accepted ${JSON.stringify(bad)}`);
    assert.equal(clipPattern.test(String(bad[0])), false);
  }
  assert.deepEqual(siteClipUrls('clip.mp4'), []);
  assert.deepEqual(siteClipUrls(undefined), []);
});

test('the app plays what the site lists and shimmers without a clip when it lists nothing', async () => {
  resetWaitingVideos();
  // Nothing is bundled: a board that never reaches the index has no clip to play.
  assert.deepEqual(allWaitingVideos, []);
  const asked = [];
  const list = await loadWaitingVideos(async (url, options) => {
    asked.push([url, options?.cache]);
    return { ok: true, json: async () => ['family-guy-01.mp4', 'bad name.mp4', 'subway-surfers.mp4'] };
  });
  assert.deepEqual(asked, [['/clips/index.json', 'no-cache']]);
  assert.deepEqual(list, ['/clips/family-guy-01.mp4', '/clips/subway-surfers.mp4']);
  // One lookup per page: a second caller gets the resolved list without asking again.
  assert.deepEqual(await loadWaitingVideos(() => assert.fail('asked twice')), list);

  for (const offline of [async () => ({ ok: false, json: async () => ['nope.mp4'] }),
    async () => { throw new Error('offline'); },
    async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
    async () => ({ ok: true, json: async () => ({ clips: ['nope.mp4'] }) })]) {
    resetWaitingVideos();
    assert.deepEqual(await loadWaitingVideos(offline), []);
  }
  resetWaitingVideos();
});

test('a placeholder keeps its own clip, steps through the rest and survives an empty list', () => {
  const clips = Array.from({ length: 10 }, (_, index) => `/clips/0${index}.mp4`);
  // Neighbouring placeholders open on different clips and step together without colliding.
  const seeds = Array.from({ length: 8 }, (_, index) => waitingSeed(`run-pending-${index}`));
  for (let step = 0; step < clips.length; step++) {
    const row = seeds.map(seed => clipAt(seed, step, clips));
    assert.equal(new Set(row).size, seeds.length, `step ${step}`);
    assert.ok(row.every(clip => clips.includes(clip)));
  }
  // Every clip is reached within one pass, and the walk repeats from there.
  const seen = Array.from({ length: clips.length }, (_, step) => clipAt(seeds[0], step, clips));
  assert.equal(new Set(seen).size, clips.length);
  assert.equal(clipAt(seeds[0], clips.length, clips), seen[0]);
  // A board with no hosted clips has nothing to play, and one clip just repeats.
  assert.equal(clipAt(seeds[0], 0, []), undefined);
  assert.equal(clipAt(seeds[0], 3, ['/clips/only.mp4']), '/clips/only.mp4');
});

test('clip upload sends every file to the remote bucket and writes the index last', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'concept-graph-clips-test-'));
  const indexFile = path.join(temp, 'index.json');
  try {
    await assert.rejects(waitingClipUploads(temp, indexFile), /No clips in/);
    await writeFile(path.join(temp, 'subway-surfers.mp4'), 'clip');
    await writeFile(path.join(temp, 'cs-surf.mp4'), 'clip');
    const { names, uploads } = await waitingClipUploads(temp, indexFile);
    assert.deepEqual(names, ['cs-surf.mp4', 'subway-surfers.mp4']);
    assert.deepEqual(uploads[0], ['r2', 'object', 'put', 'concept-graph-files/clips/cs-surf.mp4', '--file', path.join(temp, 'cs-surf.mp4'), '--content-type', 'video/mp4', '--remote', '-c', 'cloud/wrangler.jsonc']);
    assert.deepEqual(uploads.at(-1), ['r2', 'object', 'put', 'concept-graph-files/clips/index.json', '--file', indexFile, '--content-type', 'application/json', '--remote', '-c', 'cloud/wrangler.jsonc']);
    assert.equal(uploads.length, 3);

    await writeFile(path.join(temp, 'Clip Two.mp4'), 'clip');
    await assert.rejects(waitingClipUploads(temp, indexFile), /Unexpected clip name: Clip Two.mp4/);
    await rm(path.join(temp, 'Clip Two.mp4'));
    await writeFile(path.join(temp, 'notes.txt'), 'private');
    await assert.rejects(waitingClipUploads(temp, indexFile), /Unexpected clip name: notes.txt/);
    await rm(path.join(temp, 'notes.txt'));
    await writeFile(path.join(temp, 'empty.mp4'), '');
    await assert.rejects(waitingClipUploads(temp, indexFile), /Empty clip: empty.mp4/);
    await rm(path.join(temp, 'empty.mp4'));
    await writeFile(path.join(temp, 'huge.mp4'), Buffer.alloc(maxClipBytes + 1));
    await assert.rejects(waitingClipUploads(temp, indexFile), /Clip is too large: huge.mp4/);
    await rm(path.join(temp, 'huge.mp4'));
    // Folders and links are skipped rather than uploaded as clips.
    await mkdir(path.join(temp, 'archive'));
    await symlink(path.join(temp, 'cs-surf.mp4'), path.join(temp, 'link.mp4'));
    const after = await waitingClipUploads(temp, indexFile);
    assert.deepEqual(after.names, ['cs-surf.mp4', 'subway-surfers.mp4']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a placeholder renders the hosted clip once the index has loaded', async () => {
  const vite = await createServer({ configFile: false, appType: 'custom', server: { middlewareMode: true, ws: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const module = await vite.ssrLoadModule('/src/waiting-videos.mjs');
    const { WaitingVideo } = await vite.ssrLoadModule('/src/PendingNode.jsx');
    const { waitingSeed } = await vite.ssrLoadModule('/src/run-placeholders.mjs');
    // Before the site answers there is nothing to play, so the placeholder shows its shimmer alone.
    module.resetWaitingVideos();
    assert.equal(renderToStaticMarkup(React.createElement(WaitingVideo, { seed: waitingSeed('run-pending-0') })), '');
    await module.loadWaitingVideos(async () => ({ ok: true, json: async () => ['subway-surfers-01.mp4', 'cs-surf.mp4'] }));
    const html = renderToStaticMarkup(React.createElement(WaitingVideo, { seed: waitingSeed('run-pending-0') }));
    assert.match(html, /<video[^>]+src="\/clips\/(subway-surfers-01|cs-surf)\.mp4"/);
    assert.match(html, /muted/);
    // A reveal keeps playing the clip its placeholder was on, from where it stopped.
    const reveal = renderToStaticMarkup(React.createElement(WaitingVideo, { seed: waitingSeed('run-pending-0'), src: '/clips/cs-surf.mp4', initialTime: 3 }));
    assert.match(reveal, /src="\/clips\/cs-surf\.mp4"/);
    module.resetWaitingVideos();
  } finally { await vite.close(); }
});
