import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { z, ZodError } from 'zod';
import { createInvestigation } from '@codethread/trace-engine';
import { tokenMatch, registerRepository, requestScan, uuid, querySymbols } from './config.ts';
import type { Database } from './database.ts';
import { loadSnapshot } from './persistence.ts';
import { ScanService, ServiceError } from './service.ts';

const MAX_BODY=64*1024;
const MAX_RESPONSE=1024*1024;
const queryInventory=z.strictObject({offset:z.number().int().min(0).max(1000).default(0)});
export function makeApi(db: Database, service: ScanService, secret: string, port: number) {
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    try {
      if (!req.url || !req.method) throw new ServiceError(400,'INVALID_REQUEST','Missing method or URL');
      if (req.headers.host !== '127.0.0.1:'+port)
        throw new ServiceError(403,'INVALID_HOST','Localhost host header required');
      if (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:'+port)
        throw new ServiceError(403,'INVALID_ORIGIN','Cross-origin requests are disabled');
      if (!tokenMatch(req.headers.authorization,secret))
        throw new ServiceError(401,'UNAUTHORIZED','Bearer token required');
      const url=new URL(req.url,'http://127.0.0.1:'+port);
      const p=url.pathname.split('/').filter(Boolean);
      const is=(method:string,...components:string[])=>req.method===method &&
        p.length===components.length && p.every((part,i)=>components[i]==='*' || part===components[i]);
      let result:unknown;
      if (is('GET','v1','health')) result={ready:true};
      else if (is('POST','v1','repositories')) {
        const input=registerRepository.parse(await readJson(req));
        result=await service.register(input.locator);
      } else if (is('GET','v1','repositories')) result=await service.repositories();
      else if (is('GET','v1','repositories','*')) result=await service.repository(uuid.parse(p[2]));
      else if (is('POST','v1','repositories','*','scans')) {
        const input=requestScan.parse(await readJson(req));
        result=await service.accept(uuid.parse(p[2]),input.revision,input.idempotencyKey);
      } else if (is('GET','v1','scans','*')) result=await service.job(uuid.parse(p[2]));
      else if (is('POST','v1','scans','*','cancel')) result=await service.cancel(uuid.parse(p[2]));
      else if (is('GET','v1','scans','*','projects')) result=await service.projects(uuid.parse(p[2]));
      else if (is('GET','v1','scans','*','files')) {
        const offset=Number(url.searchParams.get('offset')??0);
        result=await service.files(uuid.parse(p[2]),queryInventory.parse({offset}).offset);
      } else if (p.length===6 && p[0]==='v1' && p[1]==='scans' &&
        p[3]==='projects' && req.method==='GET' && p[5]==='symbols') {
        const id=await service.publishedSnapshot(uuid.parse(p[2]),p[4]!);
        const {facts}=await loadSnapshot(db,id);
        const params=querySymbols.parse({
          query:url.searchParams.get('query')??'',
          offset:Number(url.searchParams.get('offset')??0)
        });
        const q=params.query.toLowerCase();
        const filtered=facts.symbols.filter(s=>s.name.toLowerCase().includes(q) ||
          s.filePath.toLowerCase().includes(q));
        result={snapshotId:id,items:filtered.slice(params.offset,params.offset+50),
          total:filtered.length,nextOffset:params.offset+50<filtered.length?params.offset+50:null};
      } else if (p.length===6 && p[0]==='v1' && p[1]==='scans' &&
        p[3]==='projects' && req.method==='POST' &&
        ['neighbors','paths','evidence'].includes(p[5]!)) {
        const snapshotId=await service.publishedSnapshot(uuid.parse(p[2]),p[4]!);
        const snapshot=await loadSnapshot(db,snapshotId);
        const request=await readJson(req);
        const trace=createInvestigation(snapshot.facts,snapshot.source,{resourceProfile:'repository'});
        result=p[5]==='neighbors'?trace.neighbors(request):
          p[5]==='paths'?trace.paths(request):trace.sourceEvidence(request);
      } else throw new ServiceError(404,'NOT_FOUND','Endpoint not found');
      send(res,200,result);
    } catch(e) {
      if(e instanceof ZodError) send(res,400,{error:{code:'INVALID_REQUEST',message:'Invalid request payload'}});
      else if(e instanceof ServiceError) send(res,e.status,{error:{code:e.code,message:e.message}});
      else {
        console.error('API error',e);
        send(res,500,{error:{code:'INTERNAL_ERROR',message:'Request failed'}});
      }
    }
  });
  return server;
}
async function readJson(req:IncomingMessage):Promise<unknown>{
  const media=req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if(media!=='application/json') throw new ServiceError(415,'INVALID_MEDIA_TYPE','JSON body required');
  const n=Number(req.headers['content-length']??0);
  if(n>MAX_BODY) throw new ServiceError(413,'REQUEST_TOO_LARGE','Request exceeds size limit');
  const parts:Buffer[]=[];
  let used=0;
  for await (const chunk of req){
    const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    used+=bytes.length;
    if(used>MAX_BODY) throw new ServiceError(413,'REQUEST_TOO_LARGE','Request exceeds size limit');
    parts.push(bytes);
  }
  if(!used) throw new ServiceError(400,'INVALID_REQUEST','JSON body required');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
  catch{throw new ServiceError(400,'INVALID_JSON','Malformed JSON');}
}
function send(res:ServerResponse,status:number,data:unknown){
  if(res.headersSent) {res.destroy();return;}
  let bytes=Buffer.from(JSON.stringify(data));
  if(bytes.length>MAX_RESPONSE) {
    status=413;
    bytes=Buffer.from(JSON.stringify({error:{code:'RESPONSE_TOO_LARGE',
      message:'Result exceeds API response limit'}}));
  }
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',
    'Content-Length':bytes.length});
  res.end(bytes);
}
