// SPDX-License-Identifier: GPL-3.0-or-later
const BASE_HEADERS={
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
  'X-Frame-Options':'DENY',
  'Strict-Transport-Security':'max-age=31536000',
  'Cross-Origin-Opener-Policy':'same-origin',
  'Cross-Origin-Resource-Policy':'same-origin',
  'Origin-Agent-Cluster':'?1',
  'X-Robots-Tag':'noindex, nofollow',
  'Cache-Control':'no-store'
};
function reply(body,status=200,type='text/html; charset=utf-8',extra={}){return new Response(body,{status,headers:{...BASE_HEADERS,'Content-Type':type,...extra}});}
function json(data,status=200,extra={}){return reply(JSON.stringify(data),status,'application/json; charset=utf-8',extra);}
async function readBounded(request){
  if(Number(request.headers.get('content-length')||0)>12000)throw new Error('too_large');
  const reader=request.body?.getReader();if(!reader)throw new Error('invalid');
  const chunks=[];let total=0;
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>12000){await reader.cancel();throw new Error('too_large');}chunks.push(value);}
  const bytes=new Uint8Array(total);let offset=0;for(const value of chunks){bytes.set(value,offset);offset+=value.length;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function feedback(request,env,now=new Date()){
  const url=new URL(request.url);
  if(request.method!=='POST')return json({error:'Method not allowed.'},405,{'Allow':'POST'});
  if(request.headers.get('origin')!==url.origin)return json({error:'Please submit from the Vellivex website.'},403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'JSON required.'},415);
  let data;try{data=await readBounded(request);}catch(error){return json({error:error.message==='too_large'?'Report is too large.':'Invalid report.'},error.message==='too_large'?413:400);}
  if(!data||typeof data!=='object'||Array.isArray(data))return json({error:'Invalid report.'},400);
  if(data.website)return json({error:'Unable to accept this submission.'},400);
  if(data.safe!=='on'||!Number.isFinite(data.elapsed)||data.elapsed<1500||data.elapsed>86400000)return json({error:'Please complete the safety checkbox and try again.'},400);
  const allowedProduct=['VGuard','VVault','VRelay','VCipher','Website'],allowedKind=['bug','idea','test','security','deletion'],allowedOS=['Android','iPhone/iPad','Desktop','Other'];
  if(!allowedProduct.includes(data.product)||!allowedKind.includes(data.kind)||!allowedOS.includes(data.os)||typeof data.message!=='string'||data.message.trim().length<20||data.message.length>3000||typeof data.id!=='string'||data.id.length!==36||!/^\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b$/i.test(data.id))return json({error:'Check the product, device and report text (20–3,000 characters).'},400);
  if(!env.DB||typeof env.FEEDBACK_RATE_SECRET!=='string'||env.FEEDBACK_RATE_SECRET.length<32)return json({error:'Feedback storage is unavailable. Please keep your report and try again later.'},503);
  const created=now.toISOString(),id=data.id.toLowerCase(),message=data.message.trim();
  const network=request.headers.get('cf-connecting-ip')||'unknown-network';
  const hmacKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.FEEDBACK_RATE_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const rateForDay=async day=>Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmacKey,new TextEncoder().encode(day+'|'+network))),byte=>byte.toString(16).padStart(2,'0')).join('');
  const [rateKey,previousRateKey]=await Promise.all([rateForDay(created.slice(0,10)),rateForDay(new Date(now.getTime()-86400000).toISOString().slice(0,10))]);
  const findExisting=()=>env.DB.prepare('SELECT id, rate_key, product, kind, os, message FROM feedback WHERE id = ?').bind(id).first();
  const priorResult=existing=>{
    if(![rateKey,previousRateKey].includes(existing.rate_key)||existing.product!==data.product||existing.kind!==data.kind||existing.os!==data.os||existing.message!==message)return json({error:'This reference was already used. Keep your edits and submit again as a new report.'},409);
    return json({id,saved:true});
  };
  try{
    const since=new Date(now.getTime()-3600000).toISOString();
    const existing=await findExisting();if(existing)return priorResult(existing);
    const result=await env.DB.prepare('INSERT INTO feedback (id, created_at, product, kind, os, message, rate_key, is_test) SELECT ?, ?, ?, ?, ?, ?, ?, 0 WHERE (SELECT COUNT(*) FROM feedback WHERE rate_key IN (?, ?) AND created_at > ?) < 10').bind(id,created,data.product,data.kind,data.os,message,rateKey,rateKey,previousRateKey,since).run();
    if(!result.meta?.changes){const existing=await findExisting();if(existing)return priorResult(existing);return json({error:'This network has reached the beta feedback limit. Please try again in an hour.'},429,{'Retry-After':'3600'});}
    return json({id,saved:true},201);
  }catch{
    // A concurrent identical retry or an uncertain write acknowledgement can
    // already have committed this exact report. Reconcile once, never resend.
    try{const existing=await findExisting();if(existing)return priorResult(existing);}catch{}
    return json({error:'We could not save your report. Keep this page open and try again later.'},503);
  }
}
export function makeWorker(page,notFound,assets){return {async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(url.protocol!=='https:'){url.protocol='https:';return reply(null,308,'text/plain',{'Location':url.href});}
  if(path==='/api/feedback')return feedback(request,env);
  if(request.method!=='GET'&&request.method!=='HEAD')return reply('Method not allowed',405,'text/plain; charset=utf-8',{'Allow':'GET, HEAD'});
  if(path!== '/'&&path.endsWith('/')){url.pathname=path.slice(0,-1);return reply(null,308,'text/plain',{'Location':url.href});}
  if(path==='/robots.txt')return reply('User-agent: *\nDisallow: /\n',200,'text/plain; charset=utf-8');
  const asset=assets[path];
  if(asset){const body=asset.base64?Uint8Array.from(atob(asset.body),char=>char.charCodeAt(0)):asset.body;return reply(request.method==='HEAD'?null:body,200,asset.type,asset.download?{'Content-Disposition':'attachment; filename="'+asset.download+'"'}:path==='/sw.js'?{'Service-Worker-Allowed':'/apps/'}:asset.offlineDocument?{...(path.startsWith('/offline/cipher/')?{'Permissions-Policy':"camera=(self), microphone=(), geolocation=(), payment=()"}:{}),'Cache-Control':'no-store, no-transform','Content-Security-Policy':BASE_HEADERS['Content-Security-Policy'].replace("connect-src 'self'","connect-src 'none'").replace("form-action 'self'","form-action 'none'")+(path.startsWith('/offline/cipher/')?'; media-src blob:':'')}:{});}
  const content=page(path);
  const cipherTool=path==='/apps/cipher/vault'||path==='/apps/cipher/relay';
  const headers=(path==='/apps/vault'||path==='/apps/relay'||cipherTool)?{'Content-Security-Policy':BASE_HEADERS['Content-Security-Policy'].replace("connect-src 'self'","connect-src 'none'").replace("form-action 'self'","form-action 'none'")} : {};
  if(cipherTool)headers['Content-Security-Policy']+='; media-src blob:';
  if(cipherTool)headers['Permissions-Policy']="camera=(self), microphone=(), geolocation=(), payment=()";
  return reply(request.method==='HEAD'?null:content||notFound(),content?200:404,'text/html; charset=utf-8',headers);
}};}
