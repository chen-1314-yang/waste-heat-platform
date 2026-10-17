import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
process.env.DEEPSEEK_API_KEY = 'latency-test-placeholder';
process.env.DEEPSEEK_TIMEOUT_MS = '80';
process.env.DEEPSEEK_REWRITE_TIMEOUT_MS = '80';
const LLM = await import('./llm.mjs');
const Dlg = await import('./dialog.mjs');
const nativeFetch = globalThis.fetch;
const response = (content, finish='stop') => ({ok:true,status:200,text:async()=>JSON.stringify({choices:[{message:{content},finish_reason:finish}],usage:{completion_tokens:20}})});
const source = '推荐 ORC 余热发电。共 2 条候选。可回收热功率 5402 kW。\n\n这是仿真推算，不是实测；仅适用于本轮工况。';
test.afterEach(()=>{globalThis.fetch=nativeFetch;});

test('timeout covers body after immediate headers', async()=>{
  globalThis.fetch=async(_url,init)=>({ok:true,status:200,text:()=>new Promise((resolve,reject)=>{
    const t=setTimeout(()=>resolve(JSON.stringify({choices:[{message:{content:source},finish_reason:'stop'}]})),350);
    init.signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('aborted body'));},{once:true});
  })});
  const start=Date.now(); const out=await LLM.composeAnswer(source);
  assert.equal(out.ok,false); assert.match(out.reason,/timeout/); assert.ok(Date.now()-start<260,'body must be bounded');
});

test('compose disables thinking, tries once, preserves original on budget exhaustion',async()=>{
  const calls=[];globalThis.fetch=async(_u,i)=>{calls.push(JSON.parse(i.body));return response('','length');};
  const out=await LLM.composeAnswer(source);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].thinking,{type:'disabled'});
  assert.equal(out.ok,false);assert.equal(out.text,source);
});

test('knowledge polish failure never cascades whole/block retries',async()=>{
  const calls=[];globalThis.fetch=async(_u,i)=>{calls.push(JSON.parse(i.body));return response('','length');};
  const out=await LLM.polish(source);
  assert.equal(calls.length,1);assert.deepEqual(calls[0].thinking,{type:'disabled'});
  assert.equal(out.polished,false);assert.equal(out.text,source);
});

test('nonempty truncated rewrite rejected; parse retains existing thinking/budget retry',async()=>{
  globalThis.fetch=async()=>response(source,'length');
  assert.equal((await LLM.composeAnswer(source)).ok,false);
  const calls=[];globalThis.fetch=async(_u,i)=>{const body=JSON.parse(i.body);calls.push(body);return calls.length===1?response('','length'):response('{"温度_degC":200}');};
  assert.equal((await LLM.parseScene('200℃')).温度_degC,200);
  assert.equal(calls.length,2);assert.equal(calls[0].thinking,undefined);assert.equal(calls[1].max_tokens,6000);
});

const parsed={温度_degC:200,温度_原文:'200℃',流量_数值:24.5,流量_单位:'kg/s',流量_原文:'24.5kg/s',载体:'热水/冷凝水',需求:'发电',年运行小时:6500,年运行小时_原文:'6500小时',换热端差_degC:15,换热端差_原文:'15K',连续性:'连续',驱动_原文:'余热自驱动'};
test('verified result emitted before blocked compose; invented number rejected',async()=>{
  let release,started;const ready=new Promise(r=>started=r);const pending=new Promise(r=>release=r);
  globalThis.fetch=async(_u,i)=>{const b=JSON.parse(i.body);
    if(b.max_tokens===1000)return response('{"intent":"decide"}');
    if(b.max_tokens===3000)return response(JSON.stringify(parsed));
    started();await pending;return response(source+'\n假造数字 9999999999。');
  };
  const events=[];const run=(async()=>{for await(const e of Dlg.runTurn({text:'200℃加压热水，24.5kg/s，每年6500小时，连续运行，换热端差15K，余热自驱动，想发电。'}))events.push(e);})();
  await ready;
  try{
    const first=events.find(e=>e.type==='result');assert.ok(first,'result must exist before compose resolves');
    assert.equal(first.source,'engine');assert.match(first.markdown,/ORC/);assert.ok(first.verify.ok);
    assert.equal(events.some(e=>e.type==='answer'),false);
  }finally{release();await run;}
  const final=events.find(e=>e.type==='answer');assert.equal(final.mode,'template');assert.doesNotMatch(final.markdown,/9999999999/);
  assert.equal(events.filter(e=>e.type==='answer').length,1);assert.ok(events.find(e=>e.type==='verify').rejected);
});

test('UI shows result before final answer, retains source, marks completion',()=>{
  let code=fs.readFileSync(new URL('./public/app.js',import.meta.url),'utf8');
  const index=code.indexOf('/* ============================================================ 交互绑定 */');
  assert.ok(index>0);code=code.slice(0,index);
  const sandbox={document:{querySelector:()=>({}),querySelectorAll:()=>[]},window:{},console};
  vm.createContext(sandbox);vm.runInContext(code,sandbox);
  vm.runInContext('closeRunSteps=()=>{}; collapseSteps=()=>{}; renderCites=()=>{}; scrollBottom=()=>{};',sandbox);
  const nodes=new Map();const node=()=>({hidden:true,innerHTML:'',textContent:'',dataset:{},insertAdjacentHTML(_p,t){this.innerHTML+=t;},querySelectorAll:()=>[]});
  const host={dataset:{},querySelector(s){if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);}};
  sandbox.host=host;sandbox.ev={type:'result',source:'engine',markdown:source,verify:{ok:true}};
  vm.runInContext('handleEvent(host,ev)',sandbox);
  assert.equal(host.querySelector('[data-role="bubble"]').hidden,false);
  assert.match(host.querySelector('[data-role="md"]').innerHTML,/5402/);
  assert.equal(host.querySelector('[data-role="result-status"]').hidden,false);
  sandbox.ev={type:'answer',mode:'llm',markdown:'推荐 ORC。'};vm.runInContext('handleEvent(host,ev)',sandbox);
  assert.match(host.querySelector('[data-role="result-original"]').innerHTML,/5402/);
  assert.equal(host.querySelector('[data-role="result-status"]').textContent,'回答已完成');
});
