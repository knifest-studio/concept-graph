import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { resolveVideo, videoInput, videoModels, rewriteVideoMentions, videoDefaults, videoSpeedOf } from '../src/video-generation.mjs';
import { readVideoAutoplay, videoAutoplayKey } from '../src/video-autoplay.mjs';
import { videoStatus, videoRequest, falVideo, videoFile, storeVideoMp4, videoPartBytes } from '../cloud/video.mjs';
import { validateMp4Header, maxVideoBytes } from '../src/video-assets.mjs';
import { signVideoInput, verifyVideoInput, verifySession } from '../cloud/auth.mjs';
import { validateGraph, runInputs, runInputRecord, nameImageConnections, duplicateNodes } from '../graph.mjs';
import { imageAssets } from '../src/image-edits.mjs';
import { checkArgs, runBoardTool, toolByName } from '../cloud/mcp-tools.mjs';
import { placeRunOutput } from '../src/run-outputs.mjs';
import { expectedOutputs } from '../src/output-placement.mjs';
import { runPlaceholders } from '../src/run-placeholders.mjs';
import { applyLocalGraph } from '../src/cloud-sync.mjs';
import { boardStats } from '../cloud/board-stats.mjs';
import { recordedKind } from '../src/generation-analytics.mjs';
import { createCanvasThumbnail } from '../src/canvas-thumbnails.mjs';
const png = '11111111-1111-1111-1111-111111111111.png', mp4 = '22222222-2222-2222-2222-222222222222.mp4';
const videoBytes = Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109]);
const image = id => ({ id, type: 'image', position: { x: 0, y: 0 }, data: { asset: png, caption: id, aspect: 9/16 } });
function graph(model = 'minimax', roles = [], extra = {}) {
  const images = roles.map((role, index) => image('i' + index));
  return { revision: 0, nodes: [...images, { id: 'v', type: 'text', position: { x: 400, y: 0 }, data: { text: 'Animate #1, #2 and #3', task: 'video', ...videoDefaults, videoModel: model, videoRoles: Object.fromEntries(roles.map((role, index) => ['i' + index, role])), ...extra } }], edges: images.map((image, i) => ({ id: 'e' + i, source: image.id, target: 'v' })), groups: [], runs: [], viewport: { x: 0, y: 0, zoom: 1 } };
}
const resolve = (model, roles, extra) => { const g = graph(model, roles, extra), { target, images } = runInputs(g, 'v'); return resolveVideo(target, images); };

test('endpoint matrix × roles: no input disappears and unsupported combinations block', () => {
  for (const model of Object.keys(videoModels)) {
    for (const [roles, mode, blocked] of [[[], 'text', false], [['start'], 'image', false], [['start','end'], 'image', false], [['reference'], 'reference', false], [['start','reference'], 'reference', ['omni','seedance'].includes(model)], [['start','middle','end'], model === 'minimax' ? 'reference' : 'image', ['omni','seedance'].includes(model)]]) {
      const r = resolve(model, roles);
      assert.equal(r.mode, mode, model + roles); assert.equal(r.blocked, blocked, model + roles); assert.equal(r.inputs.length, roles.length);
      const path = model === 'minimax' && mode === 'reference' ? 'minimax/h3-max' : videoModels[model].path;
      assert.equal(r.endpoint, `${path}/${mode}-to-video`);
    }
    assert.equal(resolve(model, ['end']).blocked, model !== 'minimax');
    assert.equal(resolve(model, ['start','start']).blocked, true);
  }
  for (const [model, count] of [['omni',10], ['kling',10], ['seedance',30], ['minimax',12]]) {
    assert.equal(resolve(model, Array(count).fill('reference')).blocked, false);
    assert.equal(resolve(model, Array(count+1).fill('reference')).blocked, true);
  }
  assert.equal(resolve('kling',['start',...Array(8).fill('middle'),'end']).blocked,false);
  assert.equal(resolve('kling',['reference','start',...Array(8).fill('middle'),'end']).blocked,true);
  assert.equal(resolve('minimax',['middle']).blocked,true);
});

test('every endpoint sends its documented field names and types, never a guessed common image field', () => {
  for (const model of Object.keys(videoModels)) for (const roles of [[], ['start','end'], ['reference'], ...(model === 'minimax' || model === 'kling' ? [['start','middle','end','reference']] : [])]) {
    const r = resolve(model,roles), payload = videoInput(r, 'Animate #1 and #2', roles.map((_,i) => `https://image.test/${i}`));
    assert.equal(typeof payload.duration, model === 'seedance' ? 'string' : 'number'); assert.equal(payload.resolution, r.applied.videoResolution);
    if (roles.includes('start')) assert.equal(payload[model === 'kling' ? 'start_image_url' : 'image_url'], 'https://image.test/0');
    if (roles.includes('reference')) assert.deepEqual(payload[model === 'minimax' ? 'reference_image_urls' : 'image_urls'], [`https://image.test/${roles.indexOf('reference')}`]);
    if (roles.includes('middle')) {
      if (model === 'kling') assert.deepEqual(payload.middle_image_urls, ['https://image.test/1']);
      else { assert.equal(payload.middle_image_url,'https://image.test/1'); assert.equal(payload.middle_frame_time,2.5); assert.equal(payload.prompt_expansion_mode,'balanced'); }
    }
    if (model === 'seedance') { assert.equal(payload.generate_audio,true); assert.equal(payload.codec,'H264'); }
    else assert.equal('generate_audio' in payload,false);
    if (r.followsImage && model !== 'seedance') assert.equal('aspect_ratio' in payload,false);
  }
});

test('clamps keep requested settings and recompute prices; end images cap Omni at 10 seconds', () => {
  const a = resolve('minimax',[],{duration:20,videoResolution:'4k'}); assert.equal(a.requested.duration,20); assert.equal(a.applied.duration,15); assert.equal(a.applied.videoResolution,'2K'); assert.equal(a.usd,1.95);
  const b = resolve('omni',['start','end'],{duration:20,videoAspectRatio:'1:1',videoAudio:false}); assert.equal(b.applied.duration,10); assert.equal(b.usd,.819); assert.equal(b.applied.videoAspectRatio,'16:9'); assert.equal(b.applied.videoAudio,true); assert.equal(b.requested.videoAudio,false);
  assert.equal(resolve('minimax',[]).applied.videoResolution,'768P'); assert.equal(resolve('minimax',[]).usd,.3);
  assert.equal(resolve('minimax',['reference']).usd,.4);
  assert.ok(resolve('minimax',Array(5).fill('reference')).usd>.4);
  assert.equal(resolve('minimax',['start','middle','end'],{videoResolution:'2K'}).applied.videoResolution,'768P');
  assert.equal(resolve('seedance',[],{duration:1,videoAudio:false}).applied.duration,4);
  for (const [model,usd] of [['omni',.4095],['kling',.785],['seedance',2.365]]) assert.equal(resolve(model,[]).usd,usd);
});

test('connection roles persist through new connections, numbering changes, duplication and image ID remapping', () => {
  const g=graph('minimax',[]); g.nodes.unshift(image('a'),image('b'),image('c'));
  const connect=(source,id)=>{ const edge={id,source,target:'v'}; g.nodes=nameImageConnections(g.nodes,g.edges,[edge]);g.edges.push(edge); };
  connect('a','e1'); connect('b','e2'); const target=()=>g.nodes.find(n=>n.id==='v');target().data.videoRoles.b='end';connect('c','e3');
  assert.deepEqual(target().data.videoRoles,{a:'start',b:'end',c:'reference'});
  g.edges=g.edges.filter(e=>e.source!=='a'); assert.deepEqual(runInputRecord(g,'v').map(i=>[i.number,i.role]),[[1,'end'],[2,'reference']]);
  const copied=duplicateNodes(g,['v']);assert.deepEqual(copied.nodes[0].data.videoRoles,target().data.videoRoles); assert.equal(copied.edges.length,2);
  const together=duplicateNodes(g,['v','b'],{ids:new Map([['v','v2'],['b','b2']])}); assert.equal(together.nodes[0].data.videoRoles.b2,'end');assert.equal(together.nodes[0].data.videoRoles.b,undefined);
  g.edges=[];g.nodes.push(image('fresh'));connect('fresh','e4');assert.equal(target().data.videoRoles.fresh,'start');assert.equal(target().data.videoRoles.b,'end');
});

test('mentions use reference-list indices, independent of frame/input numbers and model changes', () => {
  for (const [model,refs] of [['minimax','Image 1'],['kling','@Image1'],['omni','<IMAGE_REF_0>'],['seedance','@Image1']]) {
    const r=resolve(model,['start','reference','end']); assert.equal(rewriteVideoMentions('#1 then #2 then #3; keep #20',r),`the start frame then ${refs} then the end frame; keep #20`);
  }
});

test('video access uses its own per-person list and shares team usage', async()=>{
  const calls=[],dir={videoAllowed:async email=>{calls.push(email);return email==='yes@test';},nanoUsage:async()=>({usedToday:2,teamSpentUsd:1.123})};
  const env={FAL_KEY:'secret'};assert.equal((await videoStatus({email:'no@test'},env,dir)).allowed,false);
  const status=await videoStatus({email:'yes@test'},env,dir);assert.equal(status.usedToday,2);assert.equal(status.teamSpentUsd,1.12);assert.equal(calls.length,2);
});

test('signed input links are scoped, expire, reject tampering, and are not sessions',async()=>{
  const token=await signVideoInput(png,'secret',1000000);assert.equal(await verifyVideoInput(token,png,'secret',1000001),true);
  for(const [asset,secret,now] of [[mp4,'secret',1000001],[png,'wrong',1000001],[png,'secret',2200000]]) assert.equal(await verifyVideoInput(token,asset,secret,now),false);
  assert.equal(await verifySession(token,'secret',1000001),null);
});

// Workers supplies FixedLengthStream; this Node stand-in checks its exact length and tracks which streams it creates.
const fixedLengths = new WeakMap();
function fixedLengthRuntime(t) {
  const previous = globalThis.FixedLengthStream;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(length) {
      let total = 0;
      super({ transform(chunk, controller) { total += chunk.byteLength; if (total > length) throw new Error('fixed length overflow'); controller.enqueue(chunk); }, flush() { if (total !== length) throw new Error('fixed length underflow'); } });
      fixedLengths.set(this.readable, length);
    }
  };
  t.after(() => { if (previous === undefined) delete globalThis.FixedLengthStream; else globalThis.FixedLengthStream = previous; });
}
function bucket() {
  const state = { writes: [], parts: [], complete: false, aborted: false, calls: 0 };
  return { state,
    async put(key, bytes, metadata) {
      state.calls++;
      let length = bytes.byteLength;
      if (bytes.getReader) { length = 0; for await (const chunk of bytes) length += chunk.byteLength; assert.equal(length, fixedLengths.get(bytes)); }
      state.writes.push({ key, length, metadata });
    },
    async createMultipartUpload() {
      state.calls++;
      return {
        async uploadPart(partNumber, bytes) { state.calls++; state.parts.push(bytes.length); return { partNumber, etag: 'x' }; },
        async complete() { state.calls++; state.complete = true; },
        async abort() { state.calls++; state.aborted = true; },
      };
    },
  };
}
function streamedVideo(length, { declared = false, failAfter = Infinity, splitHeader = false, signalAfter, controller, invalid = false } = {}) {
  let sent = 0;
  const response = new Response(new ReadableStream({ pull(output) {
    if (sent >= failAfter) throw new Error('stream failure');
    if (sent >= length) { output.close(); return; }
    const chunk = new Uint8Array(Math.min(splitHeader && sent < 12 ? 3 : 64 * 1024, length - sent));
    if (!invalid && sent < videoBytes.length) chunk.set(videoBytes.subarray(sent, Math.min(videoBytes.length, sent + chunk.length)));
    sent += chunk.length; output.enqueue(chunk);
    if (signalAfter && sent >= signalAfter) controller.abort();
  } }), { headers: declared ? { 'Content-Length': String(length) } : {} });
  response.arrayBuffer = response.blob = () => { throw new Error('buffered'); };
  return response;
}
test('MP4 result storage is bounded streaming, capped, abortable, and never buffers a response body', async t => {
  fixedLengthRuntime(t);
  validateMp4Header(videoBytes);
  for (const declared of [false, true]) {
    const small = bucket(); assert.equal(await storeVideoMp4(streamedVideo(20, { declared, splitHeader: true }), small, mp4), 20);
    assert.equal(small.state.writes[0].metadata.httpMetadata.contentType, 'video/mp4'); assert.equal(small.state.calls, 1);
    const broken = bucket(); await assert.rejects(storeVideoMp4(streamedVideo(34 * 1024 * 1024, { declared, failAfter: 33 * 1024 * 1024 }), broken, mp4), /stream failure/);
    assert.equal(broken.state.aborted, !declared); assert.equal(broken.state.complete, false); assert.equal(broken.state.writes.length, 0);
    const invalid = bucket(); await assert.rejects(storeVideoMp4(streamedVideo(20, { declared, invalid: true, splitHeader: true }), invalid, mp4), /MP4/); assert.equal(invalid.state.writes.length, 0);
    const controller = new AbortController(), cancelled = bucket();
    await assert.rejects(storeVideoMp4(streamedVideo(1024 * 1024, { declared, controller, signalAfter: 128 * 1024 }), cancelled, mp4, controller.signal), /abort/i); assert.equal(cancelled.state.writes.length, 0);
  }
  for (const response of [new Response('invalid'), new Response(videoBytes, { headers: { 'Content-Length': String(maxVideoBytes + 1) } }), new Response(videoBytes, { headers: { 'Content-Length': '21' } }), new Response(videoBytes, { headers: { 'Content-Length': '19' } }), new Response(videoBytes, { headers: { 'Content-Length': 'abc' } })]) await assert.rejects(storeVideoMp4(response, bucket(), mp4), /MP4|128 MB|length/);
  const failed = bucket(); failed.put = async () => { throw new Error('R2 rejected upload'); };
  await assert.rejects(storeVideoMp4(streamedVideo(1024 * 1024, { declared: true }), failed, mp4), /R2 rejected/);
});

test('a cap-sized video costs one fixed-length PUT or six multipart R2 calls, within the queue budget', async t => {
  fixedLengthRuntime(t);
  assert.equal(maxVideoBytes, 128 * 1024 * 1024); assert.equal(videoPartBytes, 32 * 1024 * 1024);
  for (const declared of [true, false]) {
    const files = bucket(); assert.equal(await storeVideoMp4(streamedVideo(maxVideoBytes, { declared }), files, mp4), maxVideoBytes);
    assert.equal(files.state.calls, declared ? 1 : 6);
    assert.deepEqual(files.state.parts, declared ? [] : Array(4).fill(videoPartBytes));
    assert.equal(6 + 1 + files.state.calls <= 13, true, 'submit + 2 streams + 2 status checks + result + download + R2');
    assert.equal(30 + 6 + 1 + files.state.calls + 4 + 2 < 50, true, '30 input checks + queue/download/storage + access/quota/save RPCs + version/backup');
  }
});

test('queue streams statuses and downloads MP4 without forwarding the key',async()=>{
  const calls=[],root='https://queue.fal.run/requests/job';const result=await falVideo({model:resolve('kling',[]).endpoint,key:'secret',input:{},fetcher:async(url,init)=>{calls.push({url,init});if(init.method==='POST')return Response.json({status_url:root+'/status',response_url:root});if(url.endsWith('/stream'))return new Response('data: {"status":"COMPLETED"}\n\n');return Response.json({video:{url:'https://media.example/out.mp4'}});}});
  assert.equal(result.url,'https://media.example/out.mp4');assert.equal(calls.length,3);assert.ok(calls.every(c=>c.init.headers.Authorization==='Key secret'));
  await videoFile(result.url,{fetcher:async(url,init)=>{assert.equal(init.headers,undefined);return new Response(videoBytes);}});
  await assert.rejects(videoFile('file:///secret'),/unsafe/);
});

test('placement, archive asset traversal, history, low zoom and analytics recognise video',async()=>{
  const g=graph('kling',['start']),r=resolve('kling',['start']),run={id:'r',nodeId:'v',task:'video',videoModel:'kling',model:r.endpoint,provider:'nano-banana',status:'running',startedAt:new Date().toISOString(),settings:{requested:r.requested,applied:r.applied}};
  assert.equal(expectedOutputs(g,run)[0].type,'video');assert.equal(runPlaceholders(g,[run],'page-1').nodes.length,1);
  const placed=placeRunOutput(g,{runId:'r',nodeId:'v',run,asset:mp4,output:{index:0},video:{name:'Video',poster:png,...r.applied,usd:r.usd,endpoint:r.endpoint}}), output=placed.nodes.find(n=>n.type==='video');
  validateGraph(placed);assert.deepEqual(imageAssets(output),[mp4,png]);assert.equal(recordedKind(run).task,'video');assert.equal(recordedKind(run).generator,'fal');
  const doc=new Y.Doc();applyLocalGraph(doc,placed,{nodes:[],edges:[],groups:[],runs:[]});assert.ok(boardStats(doc).covers.includes(png));doc.destroy();
  let fetches=0;assert.deepEqual(await createCanvasThumbnail('/assets/'+mp4,{fetchImage:()=>{fetches++}}),{src:''});assert.equal(fetches,0);
});

test('cloud MCP Video schema is separate, stores roles and returns shared requested/applied settings',()=>{
  const tool=toolByName.get('add_video_node'),args={boardId:'11111111-1111-1111-1111-111111111111',prompt:'Animate #1',model:'omni',settings:{duration:20},imageInputs:[{nodeId:'i0',role:'start'},{nodeId:'i1',role:'end'}]};checkArgs(args,tool.inputSchema);
  const g=graph('minimax',['reference','reference']),ctx={graph:g,args,prepared:{fal:true},templates:[]};const result=runBoardTool(tool,ctx),node=result.graph.nodes.find(n=>n.id===result.result.nodeId);assert.equal(node.data.videoRoles.i1,'end');assert.equal(result.result.generation.applied.duration,10);assert.equal(result.result.generation.requested.duration,20);
  assert.throws(()=>runBoardTool(tool,{...ctx,prepared:{fal:false}}),/fal.ai key/);
  assert.equal(toolByName.get('add_text_node').inputSchema.properties.videoModel,undefined);assert.equal(toolByName.get('update_node').inputSchema.properties.videoModel,undefined);
  assert.throws(()=>checkArgs({...args,model:'wrong'},tool.inputSchema),/invalid/);
  assert.equal(videoRequest(result.graph,node.id).generation.endpoint,'google/gemini-omni-flash/v1.2/image-to-video');
});

test('changed JSX and server modules parse without starting a server or browser',async()=>{
  const {transform,build}=await import('esbuild');for(const path of ['src/main.jsx','src/VideoNode.jsx','src/TeamAccessDialog.jsx','src/NodeContextMenu.jsx'])await transform(await readFile(new URL('../'+path,import.meta.url),'utf8'),{loader:'jsx',format:'esm'});
  await build({entryPoints:[new URL('../src/main.jsx',import.meta.url).pathname],bundle:true,packages:'external',platform:'browser',outdir:'/tmp/concept-graph-video-build',write:false,logLevel:'silent'});
  for(const entry of ['cloud/worker.mjs','mcp.mjs'])await build({entryPoints:[new URL('../'+entry,import.meta.url).pathname],bundle:true,packages:'external',platform:'node',write:false,logLevel:'silent'});
});


test('fake video queue covers all twelve endpoints without opening a port', async t => {
  const { fakeFalHandler } = await import('../scripts/fake-fal.mjs'), { Readable } = await import('node:stream');
  t.mock.method(console, 'log', () => {}); const handler = fakeFalHandler({ delay: 0 });
  const call = async (url, method = 'GET', input) => {
    const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []); Object.assign(req, { url, method, headers: { host: '127.0.0.1:8832', authorization: 'Key fake' } });
    let status, headers, body; await handler(req, { writeHead(s,h) {status=s;headers=h;}, end(bytes) {body=bytes;} }); return {status,headers,body};
  };
  for (const model of Object.keys(videoModels)) for (const roles of [[], ['start'], ['reference']]) {
    const endpoint = resolve(model,roles).endpoint, queued = await call('/'+endpoint,'POST',{prompt:'Go'}); assert.equal(queued.status,200);
    const result = await call(new URL(JSON.parse(queued.body).response_url).pathname); assert.match(JSON.parse(result.body).video.url,/video.mp4$/);
  }
  const video = await call('/video.mp4'); assert.equal(video.headers['Content-Type'],'video/mp4'); validateMp4Header(video.body);
});

test('video cards render clamps and role errors, and light/collapsed results never create a video element', async t => {
  const { build } = await import('esbuild'), { createRequire } = await import('node:module'), React = await import('react'), { renderToStaticMarkup } = await import('react-dom/server');
  const { ReactFlowProvider } = createRequire(import.meta.url)('@xyflow/react');
  const contents = "export * from './VideoNode.jsx'; export { CanvasContext } from './canvas-context.jsx'; export { createCanvasStore } from './canvas-store.mjs'; export { setLanguage } from './i18n.mjs';";
  const result = await build({ stdin: { contents, resolveDir: new URL('../src/', import.meta.url).pathname, loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom', '@xyflow/react'], loader: { '.css': 'empty' }, logLevel: 'silent' });
  const module = { exports: {} }; new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
  const { CanvasContext, createCanvasStore, VideoNode, VideoPrompt, setLanguage } = module.exports;
  const old = globalThis.document; globalThis.document = { activeElement: null, documentElement: {} }; t.after(() => { if (old === undefined) delete globalThis.document; else globalThis.document = old; });
  const data = { asset: mp4, name: 'Flight', duration: 5, videoModel: 'omni', videoResolution: '720p', usd: .4095, endpoint: 'google/gemini-omni-flash/v1.2/text-to-video' };
  const state = { detail: 'full', focusId: null, videoInputs: new Map(), activeNodes: new Set(), latestRun: new Map(), videoReady: true, readOnly: false };
  const render = (Component, data, change = {}) => renderToStaticMarkup(React.createElement(ReactFlowProvider,null,React.createElement(CanvasContext.Provider, {value:{store:createCanvasStore({...state,...change})}},React.createElement(Component,{id:'v',data,assetUrl:asset=>'/assets/'+asset,Icon:()=>null}))));
  const full = render(VideoNode,data); assert.match(full,/<video/);assert.match(full,/controls=""/);assert.match(full,/muted=""/);assert.doesNotMatch(full,/autoplay/);assert.match(full,/Download MP4/); assert.match(full,/source connectable/);
  for (const change of [{detail:'light'},{detail:'tiny'}]) assert.doesNotMatch(render(VideoNode,data,change),/<video/);
  assert.doesNotMatch(render(VideoNode,{...data,collapsed:true}),/<video/);
  const g = graph('omni',['start','end'],{duration:20}), target = g.nodes.find(n=>n.id==='v'), inputs = runInputs(g,'v').images;
  const prompt = render(VideoPrompt,target.data,{videoInputs:new Map([['v',inputs]])}); assert.match(prompt,/Duration 20 → 10 s for this model/); assert.match(prompt,/10 s · ≈\$0.82/); assert.match(prompt,/Generate a 10 s video with Gemini Omni Flash 1.2 · about \$0.82/);assert.match(prompt,/Role of image #2/);
  const mixed = graph('omni',['start','reference']), blocked = render(VideoPrompt,mixed.nodes.find(n=>n.id==='v').data,{videoInputs:new Map([['v',runInputs(mixed,'v').images]])}); assert.match(blocked,/cannot combine frames/);assert.match(blocked,/class="run-button nano"[^>]*disabled=""/);
  const clip = clipInput('clip', 8, { poster: png }), editing = render(VideoPrompt, { text: 'Edit #1', task: 'video', videoModel: 'seedance', duration: 20, videoRoles: { clip: 'edit' } }, { videoInputs: new Map([['v', [clip]]]) });
  assert.match(editing, /Reference video/); assert.match(editing, /Edit this video/); assert.match(editing, /Extend this video/); assert.doesNotMatch(editing, /Start frame/);
  assert.match(editing, /Includes 8 s of input video/); assert.match(editing, /8 s · ≈\$4.54/); assert.match(editing, /From video/); assert.match(editing, /Editing follows/); assert.doesNotMatch(editing, /auto s|<video|src="[^"]*\.mp4/);
  const walk = render(VideoPrompt, { text: 'faster', task: 'video', videoModel: 'minimax' }, { videoInputs: new Map([['v', [clipInput('walk', 5.2, { width: 752, height: 800 })]]]) });
  assert.match(walk, /<option value="auto" selected="">Auto<\/option>/); assert.match(walk, /Follows the inputs/); assert.doesNotMatch(walk, /Shape .* for this model/);
  const omniWalk = render(VideoPrompt, { text: 'faster', task: 'video', videoModel: 'omni' }, { videoInputs: new Map([['v', [clipInput('walk', 5.2, { width: 752, height: 800 })]]]) }); assert.match(omniWalk, /9:16 from the inputs/);
  const fast = render(VideoNode, { ...data, playbackRate: 3 }); assert.match(fast, /aria-label="Playback speed"/); assert.match(fast, /aria-pressed="true"[^>]*>3×/); assert.match(fast, /aria-pressed="false"[^>]*>1×/);
  assert.match(render(VideoNode, data, { readOnly: true }), /disabled=""[^>]*>2×/); assert.doesNotMatch(render(VideoNode, data, { detail: 'light' }), /Playback speed/);
  const uploaded = render(VideoNode, clipNode().data); assert.match(uploaded, /Flight.mp4/); assert.match(uploaded, /1280 × 720/); assert.doesNotMatch(uploaded, /≈\$0.00|MiniMax H3/);
  setLanguage('uk');const uk=render(VideoPrompt,target.data,{videoInputs:new Map([['v',inputs]])});assert.match(uk,/Згенерувати відео на 10 с/);assert.match(uk,/Початковий кадр/);assert.doesNotMatch(uk,/Generate a 10/);
});

test('video queue reconnects once and stays within six fal requests', async () => {
  const root = 'https://queue.fal.run/requests/bounded-video', calls = [];
  let streams = 0, statuses = 0;
  const result = await falVideo({ model: resolve('minimax', []).endpoint, input: {}, fetcher: async (url, init = {}) => {
    calls.push(url);
    if (init.method === 'POST') return Response.json({ status_url: root + '/status', response_url: root });
    if (url.endsWith('/stream')) { streams++; return new Response('data: {"status":"IN_PROGRESS"}\n\n'); }
    if (url.endsWith('/status')) return Response.json({ status: ++statuses === 2 ? 'COMPLETED' : 'IN_PROGRESS' });
    return Response.json({ video: { url: 'https://media.example/bounded.mp4' } });
  } });
  assert.equal(result.url, 'https://media.example/bounded.mp4'); assert.equal(streams, 2); assert.equal(calls.length, 6);
});

const clipInput = (nodeId = 'clip', duration = 8, extra = {}) => ({ nodeId, asset: mp4, kind: 'video', duration, width: 1280, height: 720, bytes: 1024, number: 1, ...extra });
const resolveClips = (model, inputs = [clipInput()], roles = {}, settings = {}) => resolveVideo({ data: { task: 'video', videoModel: model, videoRoles: roles, ...settings } }, inputs);
const clipNode = (id = 'clip', duration = 8) => ({ id, type: 'video', position: { x: 0, y: 0 }, data: { asset: mp4, name: 'Flight', duration, width: 1280, height: 720, uploaded: true, fileName: 'Flight.mp4', bytes: 1024 } });

test('video inputs route all models to reference mode with documented fields and independent mention indices', () => {
  for (const [model, field, mention] of [['minimax', 'reference_video_urls', 'Video 1'], ['omni', 'reference_video_urls', '<VIDEO_REF_0>'], ['kling', 'video_urls', '@Video1'], ['seedance', 'video_urls', '@Video1']]) {
    const inputs = [{ nodeId: 'picture', asset: png, number: 1 }, clipInput('clip', 8, { number: 2 }), clipInput('clip2', 3, { number: 3 })];
    const resolved = resolveClips(model, inputs), payload = videoInput(resolved, '#2 follows #1 and #3, not #20', ['image', 'video', 'video2']);
    assert.equal(resolved.blocked, false, model); assert.equal(resolved.mode, 'reference');
    assert.equal(resolved.endpoint, `${model === 'minimax' ? 'minimax/h3-max' : videoModels[model].path}/reference-to-video`);
    assert.deepEqual(payload[field], ['video', 'video2']); assert.deepEqual(payload[model === 'minimax' ? 'reference_image_urls' : 'image_urls'], ['image']);
    assert.match(payload.prompt, new RegExp(mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.match(payload.prompt, /#20$/);
    assert.equal(payload[field === 'video_urls' ? 'reference_video_urls' : 'video_urls'], undefined);
    assert.equal(payload.image_url, undefined); assert.equal(payload.start_image_url, undefined);
  }
});

test('per-model clip limits block before spending, including known dimensions/FPS and combined files', () => {
  for (const [model, min, max, total, count] of [['minimax', 2, 15, 15, 12], ['omni', .01, 15, Infinity, 3], ['kling', 3, 30, 30, 5], ['seedance', 1.8, 30.2, 30.2, 10]]) {
    assert.equal(resolveClips(model, [clipInput('a', min)]).blocked, false, model);
    assert.equal(resolveClips(model, [clipInput('a', max)]).blocked, false, model);
    assert.equal(resolveClips(model, [clipInput('a', max + .01)]).blocked, true, model);
    if (min > .01) assert.equal(resolveClips(model, [clipInput('a', min - .01)]).blocked, true, model);
    if (total < Infinity) assert.ok(resolveClips(model, [clipInput('a', total / 2 + .01), clipInput('b', total / 2)]).issues.some(i => i.reason.includes('combined')));
    assert.ok(resolveClips(model, Array.from({ length: count + 1 }, (_, i) => clipInput('c' + i, min))).issues.some(i => i.reason.includes('Too many video')));
    for (const duration of [undefined, 0, NaN]) assert.equal(resolveClips(model, [clipInput('a', duration, { duration })]).blocked, true);
    assert.equal(resolveClips(model, [clipInput('a', min, { bytes: maxVideoBytes + 1 })]).blocked, true);
    assert.equal(resolveClips(model, [clipInput()], { clip: 'start' }).blocked, true);
    for (const role of ['edit', 'extend']) assert.equal(resolveClips(model, [clipInput()], { clip: role }).blocked, model !== 'seedance');
  }
  for (const extra of [{ width: 299 }, { height: 6001 }, { width: 400, height: 1200 }, { fps: 23 }, { fps: 61 }]) assert.equal(resolveClips('seedance', [clipInput('a', 8, extra)]).blocked, true);
  assert.equal(resolveClips('seedance', [clipInput('a', 8, { fps: 60 })]).blocked, false);
  assert.equal(resolveClips('seedance', [clipInput('a', 8, { fps: undefined })]).blocked, false, 'unknown FPS is checked by fal, not invented by the browser');
  const refs = Array.from({ length: 12 }, (_, i) => ({ nodeId: 'i' + i, asset: png }));
  assert.equal(resolveClips('minimax', [...refs, clipInput()]).blocked, true);
  const frames = [{ nodeId: 'image', asset: png }, clipInput()];
  for (const model of Object.keys(videoModels)) assert.equal(resolveClips(model, frames, { image: 'start' }).blocked, ['omni', 'seedance'].includes(model));
});

test('video prices include input seconds, Kling minimum billing and explicit token estimates', () => {
  assert.equal(resolveClips('kling').usd, 1.222); assert.equal(resolveClips('kling').billedSeconds, 13);
  assert.equal(resolveClips('kling', [clipInput('clip', 3)], {}, { duration: 10 }).usd, 1.88);
  assert.equal(resolveClips('kling', undefined, {}, { videoResolution: '1080p' }).usd, 1.833);
  assert.equal(resolveClips('seedance').usd, 3.6894); assert.equal(resolveClips('seedance').rate, .2838);
  assert.equal(resolveClips('minimax').usd, .9632); // 5 s output + table's 32256 input tokens minus shared 4096 allowance
  assert.ok(resolveClips('minimax', [clipInput('clip', 8, { fps: 30 })]).usd > .9632);
  assert.equal(resolveClips('omni').usd, .4218); // includes disclosed 1024 tokens/s assumption at $1.50/M
  for (const model of Object.keys(videoModels)) assert.equal(resolveClips(model).inputSeconds, 8);
});

test('Seedance edit/extend retains stored settings, sends Auto and orders the chosen target first', () => {
  for (const role of ['edit', 'extend']) {
    const resolved = resolveClips('seedance', [clipInput('reference', 3), clipInput('target', 8, { number: 2 })], { target: role }, { duration: 5, videoAspectRatio: '1:1' });
    const input = videoInput(resolved, '#1 with #2', ['reference-url', 'target-url']);
    assert.equal(resolved.blocked, false); assert.equal(resolved.requested.duration, 5); assert.equal(resolved.requested.videoAspectRatio, '1:1');
    assert.equal(input.task, role === 'edit' ? 'editing' : 'extension'); assert.equal(input.aspect_ratio, 'auto');
    assert.equal(input.duration, role === 'edit' ? 'auto' : '5'); assert.deepEqual(input.video_urls, ['target-url', 'reference-url']);
    assert.equal(input.prompt, '@Video2 with @Video1'); assert.equal(resolved.outputSeconds, role === 'edit' ? 8 : 5);
    assert.equal(resolved.usd, role === 'edit' ? 5.3922 : 4.5408);
  }
  assert.equal(resolveClips('seedance', [clipInput('a', 3), clipInput('b', 8)], { a: 'edit', b: 'extend' }).blocked, true);
  assert.deepEqual(resolveClips('seedance', undefined, { clip: 'edit' }).unsupported, {}, 'only explicitly stored settings report clamps');
});

test('connections number images and videos together; clip Reference defaults never consume frame roles', async () => {
  const { connectionNumbers } = await import('../src/edge-numbers.mjs');
  let g = graph('kling', []); g.nodes.unshift(clipNode(), image('a'), image('b'));
  for (const source of ['clip', 'a', 'b']) { const edge = { id: 'e' + source, source, target: 'v' }; g.nodes = nameImageConnections(g.nodes, g.edges, [edge]); g.edges.push(edge); }
  const node = g.nodes.find(n => n.id === 'v'); assert.deepEqual(node.data.videoRoles, { clip: 'reference', a: 'start', b: 'end' });
  const inputs = runInputs(g, 'v').images; assert.deepEqual(inputs.map(i => [i.nodeId, i.number, i.role]), [['clip', 1, 'reference'], ['a', 2, 'start'], ['b', 3, 'end']]);
  assert.equal(inputs[0].duration, 8); assert.equal(inputs[0].width, 1280);
  assert.deepEqual(runInputRecord(g, 'v')[0], { nodeId: 'clip', asset: mp4, label: 'Flight', number: 1, role: 'reference', kind: 'video', duration: 8 });
  validateGraph({ ...g, runs: [{ id: 'run', nodeId: 'v', status: 'completed', inputs: runInputRecord(g, 'v') }] });
  assert.deepEqual([...connectionNumbers(g.edges, ['v'], id => g.nodes.some(n => n.id === id && ['image', 'video'].includes(n.type))).values()], ['1', '2', '3']);
  const duplicated = duplicateNodes(g, ['v', 'clip'], { ids: new Map([['v', 'v2'], ['clip', 'clip2']]) });
  assert.equal(duplicated.nodes.find(n => n.id === 'v2').data.videoRoles.clip2, 'reference');
  assert.equal(duplicated.nodes.find(n => n.id === 'v2').data.videoRoles.clip, undefined);
  const fractional = structuredClone(g); fractional.nodes.find(n => n.id === 'clip').data.duration = 8.125; validateGraph(fractional);
});

test('MCP accepts existing video sources only for Video prompts and keeps image/video schemas separate', () => {
  const g = graph('minimax', []); g.nodes.push(clipNode());
  const tool = toolByName.get('add_video_node'), args = { prompt: 'Move #1', model: 'seedance', videoInputs: [{ nodeId: 'clip', role: 'edit' }] };
  checkArgs({ boardId: '11111111-1111-1111-1111-111111111111', ...args }, tool.inputSchema);
  const result = runBoardTool(tool, { graph: g, args, prepared: { fal: true }, templates: [] });
  assert.equal(result.result.generation.task, 'editing'); assert.equal(result.result.generation.inputSeconds, 8);
  assert.equal(result.graph.nodes.find(n => n.id === result.result.nodeId).data.videoRoles.clip, 'edit');
  assert.deepEqual(tool.inputSchema.properties.imageInputs.items.properties.role.enum, ['start', 'end', 'middle', 'reference']);
  const connect = toolByName.get('connect_nodes'), connected = runBoardTool(connect, { graph: g, args: { source: 'clip', target: 'v' } });
  assert.equal(connected.graph.nodes.find(n => n.id === 'v').data.videoRoles.clip, 'reference');
  const normal = structuredClone(g); normal.nodes.find(n => n.id === 'v').data = { text: 'Image prompt' };
  assert.throws(() => runBoardTool(connect, { graph: normal, args: { source: 'clip', target: 'v' } }), /Video prompt/);
});

test('MP4 browser validation reads only its header and stores fractional metadata with an optional small poster', async () => {
  const { videoFile: isClip, checkVideoFile, videoMetadata } = await import('../src/video-upload.mjs');
  const file = new File([videoBytes], 'flight.MP4', { type: 'video/mp4' });
  file.arrayBuffer = () => { throw new Error('must not buffer the whole video'); };
  assert.equal(isClip(file), true); await checkVideoFile(file);
  await assert.rejects(checkVideoFile(new File(['invalid'], 'bad.mp4')), /MP4/);
  await assert.rejects(checkVideoFile({ name: 'large.mp4', size: maxVideoBytes + 1 }), /128 MB/);
  await assert.rejects(checkVideoFile(new File([videoBytes], 'other.mov')), /MP4/);
  const poster = new Blob(['poster'], { type: 'image/png' }), calls = [];
  const video = { duration: 8.125, videoWidth: 1920, videoHeight: 1080, set src(value) { queueMicrotask(() => this.onloadeddata()); }, removeAttribute: key => calls.push(key), load: () => calls.push('load') };
  const canvas = { getContext: () => ({ drawImage: () => calls.push('draw') }), toBlob: resolve => resolve(poster) };
  const options = { document: { createElement: tag => tag === 'video' ? video : canvas }, makeURL: () => 'blob:test', revokeURL: url => calls.push(url) };
  const meta = await videoMetadata(file, options); assert.equal(meta.duration, 8.125); assert.equal(meta.width, 1920); assert.equal(meta.height, 1080); assert.equal(meta.poster, poster); assert.equal(canvas.width, 1024); assert.equal(canvas.height, 576); assert.deepEqual(calls, ['draw', 'src', 'load', 'blob:test']);
  canvas.getContext = () => null; assert.equal((await videoMetadata(file, options)).poster, undefined);
  video.duration = Infinity; await assert.rejects(videoMetadata(file, options), /metadata/); assert.equal(calls.at(-1), 'blob:test');
  // Generated videos without a start image get their first frame, smaller, from the stored asset URL.
  const { videoPoster } = await import('../src/video-upload.mjs'); canvas.getContext = () => ({ drawImage: () => calls.push('draw') }); calls.length = 0;
  let source; Object.defineProperty(video, 'src', { configurable: true, set(value) { source = value; queueMicrotask(() => this.onloadeddata()); } });
  assert.equal(await videoPoster('/assets/clip.mp4', { document: options.document }), poster); assert.equal(source, '/assets/clip.mp4'); assert.equal(canvas.width, 768); assert.equal(canvas.height, 432); assert.deepEqual(calls, ['draw', 'src', 'load']);
  canvas.getContext = () => null; assert.equal(await videoPoster('/assets/clip.mp4', { document: options.document }), undefined);
  Object.defineProperty(video, 'src', { configurable: true, set() { queueMicrotask(() => this.onerror()); } }); await assert.rejects(videoPoster('/assets/bad.mp4', { document: options.document }), /poster/);
});

test('cloud MP4 uploads enforce board edit access and stream validated bytes; signed fal URLs serve ranges', async t => {
  const nodeModule = await import('node:module');
  if (!nodeModule.registerHooks) { t.skip('requires Node module hooks'); return; }
  const hooks = nodeModule.registerHooks({ resolve(specifier, context, next) {
    if (specifier !== 'cloudflare:workers') return next(specifier, context);
    return { url: 'data:text/javascript,' + encodeURIComponent('export const env={}; export class DurableObject { constructor(ctx,env) {this.ctx=ctx;this.env=env;} } export class WorkerEntrypoint { constructor(ctx,env) {this.ctx=ctx;this.env=env;} }'), shortCircuit: true };
  } });
  let worker;
  try { ({ default: worker } = await import('../cloud/worker.mjs')); } finally { hooks.deregister(); }
  fixedLengthRuntime(t);
  const { signSession, sessionIdentity } = await import('../cloud/auth.mjs');
  const boardId = '11111111-1111-1111-1111-111111111111', files = new Map(), calls = [];
  let role = 'edit', hasBoard = true;
  const env = { SESSION_SECRET: 'video-upload-test', Directory: { idFromName: name => name, get: () => ({ boardFor: async () => hasBoard ? { id: boardId, role } : null }) }, FILES: {
    async put(key, stream, metadata) { calls.push('put'); assert.ok(stream.getReader, 'known-length upload stays a stream'); const pieces = []; for await (const part of stream) pieces.push(part); const bytes = Buffer.concat(pieces); files.set(key, { bytes, size: bytes.length, ...metadata }); },
    async get(key, options) { calls.push('get'); const file = files.get(key); if (!file) return null; const partial = options?.range?.get('Range'); return partial ? { ...file, range: { offset: 4, length: 8, suffix: undefined }, body: file.bytes.subarray(4, 12) } : { ...file, body: file.bytes }; }
  } };
  const cookie = await signSession(sessionIdentity({ name: 'Artist', email: 'artist@example.com' }), env.SESSION_SECRET);
  // Use the actual session cookie name, so this tests routing rather than bypassing authentication.
  const { sessionCookie } = await import('../cloud/auth.mjs');
  const auth = sessionCookie(cookie, new URL('http://localhost:8787')).split(';')[0];
  const upload = (body = videoBytes, extra = {}) => worker.fetch(new Request(`http://localhost:8787/api/assets?boardId=${boardId}`, { method: 'POST', body, headers: { Cookie: auth, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length), ...extra } }), env, {});
  assert.equal((await worker.fetch(new Request(`http://localhost:8787/api/assets?boardId=${boardId}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: videoBytes }), env, {})).status, 401);
  role = 'view'; assert.equal((await upload()).status, 403);
  role = 'edit'; hasBoard = false; assert.equal((await upload()).status, 404); hasBoard = true;
  assert.equal((await upload(videoBytes, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await upload(Buffer.from('not an mp4 file'))).status, 400);
  assert.equal((await upload(videoBytes, { 'Content-Length': String(maxVideoBytes + 1) })).status, 400);
  calls.length = 0;
  const response = await upload(); assert.equal(response.status, 200); const { asset, bytes } = await response.json();
  assert.match(asset, /\.mp4$/); assert.equal(bytes, videoBytes.length); assert.deepEqual(calls, ['put']); assert.equal(files.get('assets/' + asset).httpMetadata.contentType, 'video/mp4');
  const token = await signVideoInput(asset, env.SESSION_SECRET), url = `http://localhost:8787/api/video-inputs/${asset}?token=${token}`;
  const whole = await worker.fetch(new Request(url), env, {}); assert.equal(whole.status, 200); assert.equal(whole.headers.get('Content-Type'), 'video/mp4'); assert.equal(whole.headers.get('Content-Length'), '20'); assert.equal((await whole.arrayBuffer()).byteLength, 20);
  const range = await worker.fetch(new Request(url, { headers: { Range: 'bytes=4-11' } }), env, {}); assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Range'), 'bytes 4-11/20'); assert.equal(range.headers.get('Content-Length'), '8'); assert.equal((await range.arrayBuffer()).byteLength, 8);
  const head = await worker.fetch(new Request(url, { method: 'HEAD' }), env, {}); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await worker.fetch(new Request(url.replace(asset, png)), env, {})).status, 403);
});

test('a video dragged from its output into empty space starts a node, like images and prompts', async () => {
  const { edgeDropCreatesPrompt } = await import('../src/canvas.mjs');
  const drop = type => edgeDropCreatesPrompt({ isValid: false, fromNode: { id: 'v', type }, fromHandle: { type: 'source' } }, true);
  assert.equal(drop('video'), true); assert.equal(drop('image'), true); assert.equal(drop('model'), false);
});

test('Auto format keeps the shape of the inputs instead of forcing 16:9', () => {
  // A portrait walk cycle as a MiniMax reference must not be re-framed to 16:9 (Nov 18: the background changed).
  const portrait = clipInput('walk', 5.184, { width: 752, height: 800 });
  const minimax = resolveClips('minimax', [portrait]);
  assert.equal(minimax.requested.videoAspectRatio, 'auto'); assert.equal(minimax.applied.videoAspectRatio, 'auto'); assert.deepEqual(minimax.unsupported, {});
  assert.equal(videoInput(minimax, 'make it faster', ['https://x/walk.mp4']).aspect_ratio, 'adaptive');
  assert.equal(videoInput(resolveClips('kling', [portrait]), 'x', ['https://x/walk.mp4']).aspect_ratio, 'auto');
  assert.equal(resolveClips('omni', [portrait]).applied.videoAspectRatio, '9:16');
  assert.equal(resolveClips('omni', [clipInput()]).applied.videoAspectRatio, '16:9');
  // A chosen shape is still sent as chosen; text-only runs stay 16:9 without a clamp, even when Auto was picked.
  assert.equal(videoInput(resolveClips('minimax', [portrait], {}, { videoAspectRatio: '1:1' }), 'x', ['https://x/walk.mp4']).aspect_ratio, '1:1');
  const text = resolveVideo({ data: { task: 'video', videoModel: 'minimax', videoAspectRatio: 'auto' } }, []);
  assert.equal(text.applied.videoAspectRatio, '16:9'); assert.deepEqual(text.unsupported, {}); assert.equal(videoInput(text, 'x', []).aspect_ratio, '16:9');
});

test('video cards keep a valid speed and autoplay by default per viewer', () => {
  assert.equal(videoSpeedOf({ playbackRate: 3 }), 3); assert.equal(videoSpeedOf({ playbackRate: 5 }), 1); assert.equal(videoSpeedOf({}), 1);
  const board = speed => ({ nodes: [{ ...clipNode(), data: { ...clipNode().data, playbackRate: speed } }], edges: [] });
  validateGraph(board(2)); assert.throws(() => validateGraph(board(1.5)), /Invalid video speed/);
  const saved = value => ({ getItem: key => key === videoAutoplayKey ? value : null });
  assert.equal(readVideoAutoplay(saved(null)), true); assert.equal(readVideoAutoplay(saved(null), true), false);
  assert.equal(readVideoAutoplay(saved('off')), false); assert.equal(readVideoAutoplay(saved('on'), true), true);
  assert.equal(readVideoAutoplay({ getItem() { throw new Error('blocked'); } }), true);
});
