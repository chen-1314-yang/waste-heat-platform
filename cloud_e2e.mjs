import assert from 'node:assert/strict';
import {createCloudServer} from './cloud-server.mjs';
const server=createCloudServer();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port;
const post=(p,b)=>fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
try {
  const id=(await(await post('/api/session',{})).json()).sessionId;
  const scenes=[{demand:'发电',medium:'烟气',continuity:'连续',tempC:320,flowValue:4.4667,flowUnit:'kg/s',dT:10,hours:6500},{demand:'发电',medium:'热水/冷凝水',continuity:'连续',tempC:200,flowValue:24.5,flowUnit:'kg/s',dT:15,hours:6500}];
  const evidence=[];
  for(const scene of scenes) {
    const r=await post('/api/chat/stream',{text:'',scene,sessionId:id,noPolish:true});
    assert.equal(r.status,200);
    const frames=(await r.text()).split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    assert.equal(frames.filter(x=>x.type==='answer').length,1);
    // Direct form has no optional LLM polish, so it sends the final answer immediately.
    const verify=frames.find(x=>x.type==='verify');
    assert(verify?.checked>0,'numeric gate checked this answer');
    assert(!frames.find(x=>x.type==='error'));
    const detail=frames.find(x=>x.type==='detail');
    assert(detail?.engineRaw?.engine?.top);
    evidence.push({scene,top:detail.engineRaw.engine.top,numberGateChecked:verify.checked,existingTemplateMissing:verify.missing,finalAnswers:1});
  }
  console.log(JSON.stringify({ok:true,source:'Actual packaged engine + dialog + HTTP SSE, LLM disabled',evidence},null,2));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
