#!/usr/bin/env node
// Deterministic local worker used only by integration tests. No OpenAI requests.
import { createInterface } from 'node:readline';
let next = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params={}}=JSON.parse(line);
  if(id===undefined)return;
  let result={};
  if(method==='account/read')result={account:{type:'chatgpt'}};
  if(method==='modelProvider/capabilities/read')result={imageGeneration:true};
  if(method==='thread/start')result={thread:{id:`thread-${++next}`}};
  if(method==='turn/start') {
    const turnId=`turn-${next}`; result={turn:{id:turnId}};
    send({id,result});
    send({method:'item/started',params:{threadId:params.threadId,item:{type:'imageGeneration',id:'img'}}});
    setTimeout(()=>{
      send({method:'item/completed',params:{threadId:params.threadId,item:{type:'imageGeneration',id:'img',result:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=',failure:null}}});
      send({method:'turn/completed',params:{threadId:params.threadId,turn:{id:turnId,status:'completed'}}});
    },Number(process.env.CONCEPT_GRAPH_TEST_DELAY_MS || 300));
    return;
  }
  send({id,result});
});
