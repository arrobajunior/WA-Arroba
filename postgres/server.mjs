import http from 'node:http';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPostgresStore} from './store.mjs';
import {acquirePostgresTransportOwnership} from './transport-ownership.mjs';
import {createPostgresTransport} from './transport.mjs';
import {createPostgresConnectionAlerts} from './connection-alerts.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createPostgresBranding} from './branding.mjs';
import {createPostgresControlApi} from './control-api.mjs';
import {createPostgresCompatibilityApi} from './compatibility-api.mjs';
import {createMediaRelay} from '../media-relay.mjs';
import {createMediaStorage} from '../media-storage.mjs';
import {json} from './http.mjs';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
// Explicit composition only. Importing this module never opens a database or a socket.
// No backend selection, schema creation, bootstrap admin, or automatic deployment here.
export async function createPostgresApp({publicUrl,storeOptions={},restoreConnections=true,perOwnerLimit=50,publicDir=root,
  openStore=openPostgresStore,acquireOwnership=acquirePostgresTransportOwnership,transportFactory=createPostgresTransport,
  alertFactory=createPostgresConnectionAlerts,transportOptions={},alertOptions={},mediaRelay=createMediaRelay(),mediaStorage=null}={}){
  let origin;
  try{const u=new URL(publicUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();origin=u.origin;}catch{mediaRelay.close();throw Error('INVALID_PUBLIC_ORIGIN');}
  let store,ownership,transport,alerts,unsubscribe,stopPromise,pausePromise,phase='starting',inflight=0;
  let legacyStorage=mediaStorage;const legacy=()=>legacyStorage??=(process.env.S3_BUCKET?createMediaStorage():null);
  const waiters=new Set();
  const drained=()=>inflight?new Promise(resolve=>waiters.add(resolve)):Promise.resolve();
  const finish=()=>{if(--inflight===0){for(const resolve of waiters)resolve();waiters.clear();}};
  let server;
  // Fail closed immediately, including alert scheduling. Already admitted work must drain;
  // do not release the owner connection or database while a writer is still running.
  function pause(){
    if(pausePromise)return pausePromise;
    phase=phase==='failed'?'failed':'paused';
    pausePromise=(async()=>{await drained();await transport?.close();await alerts?.close();mediaRelay.close();})();return pausePromise;
  }
  async function shutdown(){
    if(stopPromise)return stopPromise;
    stopPromise=(async()=>{await pause();if(server?.listening){const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));server.closeIdleConnections();await closed;}unsubscribe?.();await legacyStorage?.close?.();await ownership?.release();await store?.close();phase='stopped';})();return stopPromise;
  }
  try{
    store=await openStore(storeOptions);
    ownership=await acquireOwnership({databaseUrl:storeOptions.databaseUrl,schema:storeOptions.schema,ssl:storeOptions.ssl});
    await ownership.assert(store.db);
    const activity=createPostgresInstanceActivity(store.db),branding=createPostgresBranding(store.db);
    alerts=alertFactory(store,{...alertOptions,publicUrl:origin,appName:async()=>(await branding.read()).name,onConnectionEvent:activity.connectionState});
    transport=transportFactory(store,{...transportOptions,ownership,mediaRelay,mediaBaseUrl:origin,legacyStorage:legacy,onConnectionState:alerts.stateChanged});
    unsubscribe=ownership.onLost(()=>{phase='failed';void alerts.close().catch(()=>{});void transport.close().catch(()=>{});void pause().catch(()=>{});});
    await transport.recoverInterrupted();await alerts.recoverInterrupted();
    const control=await createPostgresControlApi({store,origin,transport,alerts,relay:mediaRelay,legacy,perOwnerLimit,onUserEnabled:async ids=>{for(const id of ids)void transport.flush(id).catch(()=>{});}});
    const compatibility=createPostgresCompatibilityApi({store,transport,relay:mediaRelay,baseUrl:origin,legacy,activity});
    if(restoreConnections)await transport.restore();
    await alerts.start(transport.state);await ownership.assert(store.db);
    if(phase!=='starting')throw fail(503,'startup_interrupted');phase='ready';
    server=http.createServer(async(req,res)=>{
      res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      let admitted=false;
      try{
        // Infrastructure probe may use another Host; no account or session details returned.
        if(['/api/health','/api/ready'].includes(req.url)&&req.method==='GET'){
          let ready=phase==='ready'&&ownership.active();
          if(ready)try{await ownership.assert(store.db);}catch{ready=false;}
          return json(res,ready?200:503,{ok:ready});
        }
        if(phase!=='ready'||!ownership.active())throw fail(503,'service_unavailable');
        inflight++;admitted=true;
        if(req.headers.host!==new URL(origin).host)throw fail(403,'invalid_host');
        const raw=(req.url||'/').split('?')[0];let decoded;
        try{decoded=decodeURIComponent(raw);}catch{throw fail(400,'invalid_path');}
        if(!raw.startsWith('/')||raw.startsWith('//')||decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').includes('..'))throw fail(403,'invalid_path');
        if(!['GET','HEAD','POST','PATCH'].includes(req.method))throw fail(405,'method_not_allowed');
        await ownership.assert(store.db);
        if(await control(req,res))return;
        const url=new URL(req.url,origin),media=url.pathname.match(/^\/instance([a-f0-9]{8})\/media\/([a-f0-9]{48})$/);
        if(media&&req.method==='GET'){
          const entry=mediaRelay.get(media[1],media[2]),row=await store.db.get('SELECT i.active,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1',[media[1]]);
          if(!entry||!row?.active||!row.owner_active)throw fail(404,'media_expired');
          res.writeHead(200,{'Content-Type':entry.mimetype,'Content-Length':entry.bytes.length,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(entry.filename)});res.end(entry.bytes);return;
        }
        const match=url.pathname.match(/^\/instance([a-f0-9]{8})\/(.+)$/);if(match){await compatibility(req,res,match[1],match[2],url);return;}
        if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/instance'))throw fail(404,'not_found');
        if(!['GET','HEAD'].includes(req.method))throw fail(405,'method_not_allowed');
        const base=await realpath(publicDir),target=path.resolve(base,'.'+(decoded==='/'?'/index.html':decoded));
        if(!target.startsWith(base+path.sep))throw fail(403,'invalid_path');
        let resolved;try{resolved=await realpath(target);}catch{throw fail(404,'not_found');}
        if(!resolved.startsWith(base+path.sep))throw fail(403,'invalid_path');
        const data=await readFile(resolved);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[path.extname(resolved)]||'application/octet-stream','Content-Length':data.length});res.end(req.method==='HEAD'?undefined:data);
      }catch(error){if(!res.headersSent)json(res,Number.isInteger(error.status)?error.status:500,{error:Number.isInteger(error.status)?error.code:'internal_error',message:'Não foi possível concluir a operação.'});else res.end();}
      finally{if(admitted)finish();}
    });
    server.requestTimeout=30000;server.headersTimeout=15000;
    server.pause=pause;server.shutdown=shutdown;server.readiness=()=>phase==='ready'&&ownership.active();
    return server;
  }catch(error){phase='failed';try{await shutdown();}catch{throw Error('POSTGRES_STARTUP_CLEANUP_FAILED');}throw error;}
}
