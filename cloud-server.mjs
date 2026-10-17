// Public entry only. Original local server and numeric engine stay unchanged.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
process.env.WH_ROOT=path.join(HERE,'runtime');
// Cloud credentials come only from the hosting environment, never local fallback files.
if (!process.env.DEEPSEEK_API_KEY?.trim()) process.env.DSH_AGENT_WH_NO_LLM='1';
const [Dlg,Session,Engine,LLM,Rag]=await Promise.all([
  import('./dialog.mjs'),import('./session.mjs'),import('./engine_bridge.mjs'),import('./llm.mjs'),import('./rag.mjs')
]);

function json(res,status,data,extra={}) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let bytes=0,parts=[];
  for await(const part of req) {
    bytes+=part.length;
    if(bytes>32768) { const e=new Error('请求体过大');e.status=413;throw e; }
    parts.push(part);
  }
  let data;
  try{data=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');}catch{const e=new Error('JSON 格式不正确');e.status=400;throw e;}
  if(!data||Array.isArray(data)||typeof data!=='object'){const e=new Error('请求格式不正确');e.status=400;throw e;}
  return data;
}
const staticFiles={'/':['index.html','text/html'],'/index.html':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/md.js':['md.js','text/javascript']};

export function createCloudServer({parentOrigin=process.env.PARENT_ORIGIN||'https://chen-1314-yang.github.io',runTurn=Dlg.runTurn,dailyTurns=Number(process.env.DAILY_TURN_LIMIT||120),newSessionLimit=30,sessionTurns=30,maxActive=2,turnTimeoutMs=90000}={}) {
  // CSP checks every ancestor: the existing Streamlit entry embeds the GitHub main site.
  // This exact outer page is allowed to frame the UI; POST origin checks below remain separate.
  const frameAncestors=[...new Set(["'self'",parentOrigin,'https://waste-heat-demo.streamlit.app'])].join(' ');
  const issued=new Map();
  let day='',dailyCount=0,minute=0,sessionCount=0,active=0;
  return http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy','frame-ancestors '+frameAncestors);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const p=new URL(req.url,'http://localhost').pathname;
    const ownOrigin=(req.headers['x-forwarded-proto']==='https'?'https:':'http:')+'//'+req.headers.host;
    if(req.method==='POST' && req.headers.origin && req.headers.origin!==parentOrigin && req.headers.origin!==ownOrigin) return json(res,403,{error:'不允许的来源'});
    try {
      if(req.method==='GET'&&staticFiles[p]) {
        const [name,mime]=staticFiles[p];
        res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-cache'});
        return res.end(fs.readFileSync(path.join(HERE,'public',name)));
      }
      if(req.method==='GET'&&p==='/api/health') {
        Engine.engineMeta(); const index=Rag.buildIndex();
        return json(res,200,{ok:true,engine:{ok:true},llm:{available:LLM.available(),model:LLM.MODEL},knowledge:{chunks:index.N,sources:Rag.knowledgeBase().map(({title,rel,ok,chunks,forbidden,authority})=>({title,rel,ok,chunks,forbidden,authority}))}});
      }
      if(req.method==='GET'&&p==='/api/meta') {
        const m=Engine.engineMeta();
        const {demandMap,mediumMap,pathKeys,display,indicators,defaultRunHours,heatingSeasonHours,lam0,conds,metaNames}=m;
        return json(res,200,{demandMap,mediumMap,pathKeys,display,indicators,defaultRunHours,heatingSeasonHours,lam0,conds,metaNames,conv:Dlg.CONV,nextActions:Dlg.nextActionCatalog()});
      }
      if(req.method==='POST'&&p==='/api/session') {
        const body=await readBody(req);
        if(Object.keys(body).length) return json(res,400,{error:'会话标识由服务端创建'});
        const current=Math.floor(Date.now()/60000);
        if(current!==minute){minute=current;sessionCount=0;}
        if(sessionCount>=newSessionLimit)return json(res,429,{error:'新对话较多，请稍后再试'},{'Retry-After':'60'});
        sessionCount++;
        for(const [id,s] of issued) if(Date.now()-s.at>7200000){issued.delete(id);Session.dropSession(id);}
        if(issued.size>=180)return json(res,429,{error:'试运行会话已满，请稍后再试'});
        const id=crypto.randomBytes(32).toString('hex');
        Session.createSession(id); issued.set(id,{at:Date.now(),count:0,busy:false});
        return json(res,200,{ok:true,sessionId:id,turns:0});
      }
      if(req.method==='POST'&&p==='/api/session/status') {
        const body=await readBody(req),s=issued.get(body.sessionId);
        return json(res,s&&Session.getSession(body.sessionId)&&Date.now()-s.at<=7200000?200:401,{ok:!!s&&!!Session.getSession(body.sessionId)&&Date.now()-s.at<=7200000});
      }
      if(req.method==='POST'&&p==='/api/chat/stream') {
        const body=await readBody(req),id=body.sessionId,s=issued.get(id);
        if(!s||!Session.getSession(id)||Date.now()-s.at>7200000)return json(res,401,{error:'对话已过期，请点击新对话'});
        if(typeof body.text!=='string'||body.text.length>2000||(!body.text.trim()&&(!body.scene||typeof body.scene!=='object'||Array.isArray(body.scene))))return json(res,400,{error:'请输入有效消息（最多 2000 字）'});
        if(s.busy)return json(res,409,{error:'本轮仍在处理，请等待或停止'});
        const today=new Date().toISOString().slice(0,10);
        if(today!==day){day=today;dailyCount=0;}
        if(dailyCount>=dailyTurns||s.count>=sessionTurns)return json(res,429,{error:'已达到免费试运行请求限额，请稍后再试'},{'Retry-After':'3600'});
        if(active>=maxActive)return json(res,429,{error:'助手正在处理其他请求，请稍后再试'},{'Retry-After':'15'});
        dailyCount++;s.count++;s.busy=true;s.at=Date.now();active++;
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'});
        res.flushHeaders();res.write(': stream open\n\n');
        let closed=false;
        const send=event=>{if(!closed&&!res.destroyed)res.write('data: '+JSON.stringify(event)+'\n\n');};
        res.on('close',()=>{closed=true;});
        const heartbeat=setInterval(()=>{if(!closed)res.write(': hb\n\n');},15000);
        const timer=setTimeout(()=>{send({type:'error',message:'本轮等待较久，请稍后重新提问'});send({type:'done'});closed=true;res.end();},turnTimeoutMs);
        try {
          for await(const event of runTurn({text:body.text,sessionId:id,scene:body.scene||null,noPolish:!!body.noPolish})) {
            if(closed)break;
            send(event.type==='error'?{type:'error',message:'本轮处理失败，请稍后重试'}:event);
          }
        }catch{send({type:'error',message:'本轮处理失败，请稍后重试'});send({type:'done'});}
        finally{clearInterval(heartbeat);clearTimeout(timer);s.busy=false;active--;if(!res.destroyed)res.end();}
        return;
      }
      return json(res,404,{error:'页面或接口不存在'});
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'服务暂不可用'});else res.end();}
  });
}
