import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudServer } from './cloud-server.mjs';

const origin='https://chen-1314-yang.github.io';
async function start(options={}) {
  const server=createCloudServer({parentOrigin:origin,...options});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  return {server,url,get:p=>fetch(url+p),post:(p,body,headers={})=>fetch(url+p,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...headers},body:JSON.stringify(body)})};
}
async function sid(c) { const r=await c.post('/api/session',{}); assert.equal(r.status,200); return (await r.json()).sessionId; }
async function close(c) { c.server.closeAllConnections(); await new Promise(r=>c.server.close(r)); }
async function* minimalTurn(p) { yield {type:'session',sessionId:p.sessionId}; yield {type:'result',markdown:'已核验结果'}; yield {type:'answer',markdown:'正式答复'}; yield {type:'done',ms:0}; }

test('云端仅开放必要路由，不泄露主机路径或其他人的会话',async()=>{
  const c=await start({runTurn:minimalTurn});
  try {
    for(const p of ['/api/sessions','/api/session?id=any','/api/probe-llm','/api/decide','/api/ask','/offline-demo','/../llm.mjs']) assert.equal((await c.get(p)).status,404,p);
    const r=await c.get('/api/health'); const body=await r.text();
    assert.equal(r.status,200); assert.equal(JSON.parse(body).engine.ok,true);
    assert.doesNotMatch(body,/projectRoot|keySource|[CD]:\\|sessionId|offlineDemo/);
    assert.equal(r.headers.get('content-security-policy').includes("frame-ancestors 'self' "+origin),true);
    assert.equal(r.headers.get('access-control-allow-origin'),null);
    assert.equal((await c.get('/')).status,200);
    assert.equal((await c.get('/llm.mjs')).status,404);
  } finally { await close(c); }
});
test('会话由服务器随机创建；跨站/猜测/指定 id 请求在模型前拒绝',async()=>{
  let calls=0; const c=await start({runTurn:async function*(p){calls++;yield* minimalTurn(p);}});
  try {
    const a=await sid(c),b=await sid(c); assert.match(a,/^[a-f0-9]{64}$/); assert.notEqual(a,b);
    assert.equal((await c.post('/api/session',{sessionId:a})).status,400);
    assert.equal((await c.post('/api/session',{}, {Origin:'https://evil.example'})).status,403);
    assert.equal((await c.post('/api/chat/stream',{text:'hi',sessionId:'guess'})).status,401);
    assert.equal((await c.post('/api/chat/stream',{text:'hi',sessionId:a},{Origin:'https://evil.example'})).status,403);
    assert.equal(calls,0);
    const r=await c.post('/api/chat/stream',{text:'hi',sessionId:a}); assert.equal(r.status,200); await r.text(); assert.equal(calls,1);
  } finally {await close(c);}
});
test('请求约束真正拦截超长文本、超大/错误 JSON，并移除自检强制意图',async()=>{
  let params=[]; const c=await start({runTurn:async function*(p){params.push(p);yield* minimalTurn(p);}});
  try {
    const a=await sid(c);
    assert.equal((await c.post('/api/chat/stream',{text:'x'.repeat(2001),sessionId:a})).status,400);
    assert.equal((await c.post('/api/chat/stream',{text:'x'.repeat(40000),sessionId:a})).status,413);
    const r=await fetch(c.url+'/api/chat/stream',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{bad'});assert.equal(r.status,400);
    assert.equal((await c.post('/api/chat/stream',{text:123,sessionId:a})).status,400);
    assert.equal(params.length,0);
    const good=await c.post('/api/chat/stream',{text:'你好',sessionId:a,forceIntent:'decide'});await good.text();
    assert.equal(params.length,1);assert.equal(params[0].forceIntent,undefined);
  } finally {await close(c);}
});
test('SSE 保留已核验结果→正式回答→结束；不缓存流',async()=>{
  const c=await start({runTurn:minimalTurn});
  try {
    const r=await c.post('/api/chat/stream',{text:'hi',sessionId:await sid(c)});
    assert.match(r.headers.get('content-type'),/text\/event-stream/);assert.match(r.headers.get('cache-control'),/no-store/);
    const txt=await r.text(); const ev=txt.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
    assert.deepEqual(ev.map(x=>x.type),['session','result','answer','done']);
  } finally {await close(c);}
});
test('模型费用调用有全局上限，换会话不能绕过；创建会话也受限',async()=>{
  let calls=0; const c=await start({dailyTurns:1,newSessionLimit:3,runTurn:async function*(p){calls++;yield* minimalTurn(p);}});
  try {
    const a=await sid(c),b=await sid(c);
    await(await c.post('/api/chat/stream',{text:'hi',sessionId:a})).text();
    assert.equal((await c.post('/api/chat/stream',{text:'hi',sessionId:b})).status,429);assert.equal(calls,1);
    await sid(c); assert.equal((await c.post('/api/session',{})).status,429);
  } finally {await close(c);}
});
test('同会话重复提交被拒绝，进程重启/过期 id 不继承任何历史',async()=>{
  let release; const c=await start({runTurn:async function*(p){yield{type:'session',sessionId:p.sessionId};await new Promise(r=>release=r);yield{type:'done'};}});
  try {
    const a=await sid(c); const pending=await c.post('/api/chat/stream',{text:'hi',sessionId:a});
    assert.equal((await c.post('/api/chat/stream',{text:'hi',sessionId:a})).status,409);
    release(); await pending.text();
    const c2=await start({runTurn:minimalTurn});try{assert.equal((await c2.post('/api/chat/stream',{text:'hi',sessionId:a})).status,401);}finally{await close(c2);}
  } finally{release?.();await close(c);}
});
test('异常输出不把后端堆栈/路径/密钥发给访客',async()=>{
  const c=await start({runTurn:async function*(){throw new Error('D:\\private\\.user_api_key sk-test-private');}});
  try{const r=await c.post('/api/chat/stream',{text:'hi',sessionId:await sid(c)});const txt=await r.text();assert.doesNotMatch(txt,/sk-test|private|stack/);assert.match(txt,/error/);assert.match(txt,/done/);}finally{await close(c);}
});
