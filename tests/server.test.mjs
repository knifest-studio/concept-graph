import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test('board-scoped saves and queued generation stay isolated across edits and restarts', {timeout:15000}, async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'concept-server-test-'));
  let child;
  t.after(async()=>{child?.kill(); await delay(100); await rm(directory,{recursive:true,force:true});});
  const start=()=>new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'14319',CONCEPT_GRAPH_DATA:directory,CODEX_BIN:path.join(root,'tests/fixtures/codex.mjs')},stdio:['ignore','pipe','pipe']});
    child.on('error',reject); child.once('exit',code=>{if(code)reject(new Error('Test server exited '+code));});
    child.stdout.on('data',bytes=>{if(bytes.toString().includes('is ready'))resolve();});
    child.stderr.on('data',bytes=>{if(bytes.toString().includes('EADDRINUSE'))reject(new Error('Test port 14319 is occupied'));});
  });
  const request=async(url,method='GET',body)=>{
    const response=await fetch('http://127.0.0.1:14319'+url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    return {status:response.status,value:await response.json()};
  };
  await start();
  const workspace=(await request('/api/workspace')).value;
  const a=workspace.defaultBoardId, b=(await request('/api/boards','POST',{name:'Separate tests'})).value.id;
  const prompt=id=>({id,type:'text',position:{x:0,y:0},data:{text:'Make a test image'}});
  for(const [board,node] of [[a,'a'],[b,'b']])assert.equal((await request(`/api/boards/${board}/graph`,'PUT',{revision:0,nodes:[prompt(node)],edges:[]})).status,200);
  assert.equal((await request('/api/graph','PUT',{})).status,426);
  assert.equal((await request(`/api/boards/${a}/graph`,'PUT',{revision:0,nodes:[],edges:[]})).status,409);
  await request(`/api/boards/${a}/runs`,'POST',{nodeId:'a',revision:1});
  await request(`/api/boards/${b}/runs`,'POST',{nodeId:'b',revision:1});
  const changed=prompt('a');changed.data.text='Edited after starting; original snapshot stays';
  const graphA=(await request(`/api/boards/${a}`)).value.board.graph;
  assert.equal((await request(`/api/boards/${a}/graph`,'PUT',{...graphA,nodes:[changed]})).status,200);
  let final;
  for(let i=0;i<80;i++){
    final=await Promise.all([a,b].map(async board=>(await request(`/api/boards/${board}`)).value.board.graph));
    if(final.every(g=>g.runs[0]?.status==='completed'))break;
    await delay(50);
  }
  for(const [index,g] of final.entries()){
    assert.equal(g.runs[0].status,'completed');assert.ok(g.runs[0].startedAt);
    assert.equal(g.nodes.length,2);assert.equal(g.edges[0].source,index===0?'a':'b');
    assert.equal(g.runs[0].target.data.text,'Make a test image');
  }
  assert.equal(final[0].nodes[0].data.text,changed.data.text);
  assert.equal(final[1].nodes[0].data.text,'Make a test image');
  final[0].groups=[{id:'test-group',name:'Saved group',nodeIds:final[0].nodes.map(node=>node.id),collapsed:true}];
  assert.equal((await request(`/api/boards/${a}/graph`,'PUT',final[0])).status,200);
  final[0]=(await request(`/api/boards/${a}`)).value.board.graph;
  // An older tab without the additive groups field must not erase memberships.
  const {groups,...oldClient}=final[0];
  assert.equal((await request(`/api/boards/${a}/graph`,'PUT',oldClient)).status,200);
  final[0]=(await request(`/api/boards/${a}`)).value.board.graph;
  assert.deepEqual(final[0].groups,groups);
  assert.equal((await request(`/api/boards/${a}`,'PATCH',{name:'🧙'.repeat(40)})).status,200);
  const exportResponse=await fetch(`http://127.0.0.1:14319/api/boards/${a}/export`);
  assert.equal(exportResponse.status,200);assert.match(exportResponse.headers.get('content-disposition'),/conceptgraph/);
  const archive=Buffer.from(await exportResponse.arrayBuffer());
  const imported=[];
  for(let i=0;i<2;i++){
    const result=await fetch('http://127.0.0.1:14319/api/boards/import',{method:'POST',headers:{'Content-Type':'application/zip'},body:archive});
    assert.equal(result.status,201);const {board}=await result.json();assert.notEqual(board.id,a);assert.ok(board.name.length<=80);assert.doesNotThrow(()=>encodeURIComponent(board.name));
    const graph=(await request(`/api/boards/${board.id}`)).value.board.graph;
    assert.deepEqual(graph.nodes.map(n=>n.id),final[0].nodes.map(n=>n.id));
    assert.deepEqual(graph.edges,final[0].edges);assert.deepEqual(graph.groups,groups);assert.deepEqual(graph.runs,final[0].runs);
    const image=graph.nodes.find(n=>n.type==='image');assert.notEqual(image.data.asset,final[0].nodes.find(n=>n.type==='image').data.asset);
    assert.equal((await fetch('http://127.0.0.1:14319/assets/'+image.data.asset)).status,200);
    imported.push({board,graph});
  }
  assert.notEqual(imported[0].board.name,imported[1].board.name);
  const beforeInvalid=(await request('/api/workspace')).value;
  const invalid=await fetch('http://127.0.0.1:14319/api/boards/import',{method:'POST',body:'not a zip'});assert.equal(invalid.status,400);
  const forbidden=await fetch('http://127.0.0.1:14319/api/boards/import',{method:'POST',headers:{Origin:'https://example.invalid'},body:archive});assert.equal(forbidden.status,403);
  assert.deepEqual((await request('/api/workspace')).value,beforeInvalid);assert.equal(beforeInvalid.defaultBoardId,a);
  for(const [index,board]of[a,b].entries())assert.deepEqual((await request(`/api/boards/${board}`)).value.board.graph,final[index]);
  const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped;
  await start();
  for(const [index,board] of [a,b].entries())assert.deepEqual((await request(`/api/boards/${board}`)).value.board.graph,final[index]);
  for(const {board,graph}of imported)assert.deepEqual((await request(`/api/boards/${board.id}`)).value.board.graph,graph);
});
