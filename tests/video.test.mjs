import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { resolveVideo, videoInput, videoModels, rewriteVideoMentions, videoDefaults } from '../src/video-generation.mjs';
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
  const full = render(VideoNode,data); assert.match(full,/<video/);assert.match(full,/controls=""/);assert.match(full,/muted=""/);assert.doesNotMatch(full,/autoplay/);assert.match(full,/Download MP4/);
  for (const change of [{detail:'light'},{detail:'tiny'}]) assert.doesNotMatch(render(VideoNode,data,change),/<video/);
  assert.doesNotMatch(render(VideoNode,{...data,collapsed:true}),/<video/);
  const g = graph('omni',['start','end'],{duration:20}), target = g.nodes.find(n=>n.id==='v'), inputs = runInputs(g,'v').images;
  const prompt = render(VideoPrompt,target.data,{videoInputs:new Map([['v',inputs]])}); assert.match(prompt,/Duration 20 → 10 s for this model/); assert.match(prompt,/10 s · ≈\$0.82/); assert.match(prompt,/Generate a 10 s video with Gemini Omni Flash 1.2 · about \$0.82/);assert.match(prompt,/Role of image #2/);
  const mixed = graph('omni',['start','reference']), blocked = render(VideoPrompt,mixed.nodes.find(n=>n.id==='v').data,{videoInputs:new Map([['v',runInputs(mixed,'v').images]])}); assert.match(blocked,/cannot combine frames/);assert.match(blocked,/class="run-button nano"[^>]*disabled=""/);
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
