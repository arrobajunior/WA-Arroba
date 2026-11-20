import http from 'node:http';
import {once,EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {postgresFixture} from './test-fixture.mjs';
import {passwordHash} from '../auth.mjs';
import {createMediaRelay} from '../media-relay.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createPostgresConnectionAlerts} from './connection-alerts.mjs';
import {createPostgresTransport} from './transport.mjs';
import {createPostgresControlApi} from './control-api.mjs';
import {createPostgresCompatibilityApi} from './compatibility-api.mjs';
import {json} from './http.mjs';

// HTTP/SQL integration harness with embedded PostgreSQL and fake WhatsApp/SMTP.
// This is not a production server or a connection to a Railway database.
export async function apiFixture(t,{mediaLoader,legacy=()=>null,transportOptions={}}={}){
  const f=await postgresFixture(),password='synthetic-password-long',hash=await passwordHash(password),tokens=new Map(),sockets=[],socketById=new Map(),hooks=[],mail=[];
  await f.db.run('UPDATE users SET password_hash=$1',[hash]);
  const other={id:'c'.repeat(24),name:'Other',email:'other@example.test',role:'user'};await f.db.run('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[other.id,other.name,other.email,hash,'user',new Date().toISOString()]);await f.db.run('UPDATE instances SET owner_id=$1 WHERE id=$2',[other.id,f.ids[1]]);
  for(const id of f.ids){const token=randomBytes(32).toString('hex');tokens.set(id,token);await f.db.run('UPDATE instances SET token=$1,settings=$2 WHERE id=$3',[f.store.encrypt(token),'{"sendDelay":0,"sendDelayMax":0}',id]);}
  const relay=createMediaRelay(),activity=createPostgresInstanceActivity(f.db),alerts=createPostgresConnectionAlerts(f.store,{mailReady:()=>true,sendEmail:async value=>{mail.push(value);return {messageId:'synthetic'};},onConnectionEvent:activity.connectionState});
  const ownership={active:()=>true,assert:async()=>{},onLost:()=>()=>{}};
  let base;
  const transport=createPostgresTransport(f.store,{ownership,mediaRelay:relay,legacyStorage:legacy,mediaBaseUrl:'https://synthetic.example.test',webhookRetryMs:1,socketFactory:config=>{
    const socket={config,ev:new EventEmitter(),user:{id:'5511000000000@s.whatsapp.net',name:'Synthetic'},sends:[],ends:0,logouts:0,end(){this.ends++;},async logout(){this.logouts++;},async sendMessage(jid,content,options){this.sends.push({jid,content,options});this.ev.emit('messages.update',[{key:{id:options.messageId,remoteJid:jid,fromMe:true},update:{status:3}}]);return {};},profilePictureUrl:async()=>'',updateMediaMessage:async()=>{}};sockets.push(socket);return socket;
  },...transportOptions,onConnectionState:alerts.stateChanged,webhookSender:async(url,payload)=>hooks.push({url,payload})});
  let control,compatibility;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try{
      if(await control(req,res))return;
      const url=new URL(req.url,base),media=url.pathname.match(/^\/instance([a-f0-9]{8})\/media\/([a-f0-9]{48})$/);
      if(media&&req.method==='GET'){
        const entry=relay.get(media[1],media[2]),row=await f.db.get('SELECT i.active,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1',[media[1]]);
        if(!entry||!row?.active||!row.owner_active){json(res,404,{error:'media_expired'});return;}res.writeHead(200,{'Content-Type':entry.mimetype,'Content-Disposition':'attachment'});res.end(entry.bytes);return;
      }
      const match=url.pathname.match(/^\/instance([a-f0-9]{8})\/(.+)$/);if(match){await compatibility(req,res,match[1],match[2],url);return;}
      json(res,404,{error:'not_found'});
    }catch(error){const status=Number.isInteger(error.status)?error.status:500;json(res,status,{error:error.code||'internal_error',message:status<500?error.message:'Erro interno.'});}
  });
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await transport.close();await alerts.close();await f.close();});
  server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
  control=await createPostgresControlApi({store:f.store,origin:base,transport,alerts,relay,legacy});
  compatibility=createPostgresCompatibilityApi({store:f.store,transport,relay,baseUrl:base,legacy,activity,...(mediaLoader?{mediaLoader}:{})});
  async function request(route,{method='GET',cookie,data,form,headers={}}={}){
    const res=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...(route.startsWith('/api/')&&['POST','PATCH'].includes(method)?{'X-Requested-With':'wa-platform',Origin:base}:{}),...headers},body:form??(data===undefined?undefined:JSON.stringify(data))});
    const type=res.headers.get('content-type')||'';return {status:res.status,body:type.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer()),headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const api=(action,{id=f.ids[0],token=tokens.get(id),method='GET',data,params={},headers={}}={})=>request('/instance'+id+'/'+action+(method==='GET'?'?'+new URLSearchParams({...(token?{token}:{}),...params}):''),{method,data:method==='POST'?{...(token?{token}:{}),...data}:undefined,headers});
  const login=async user=>{const r=await request('/api/auth/login',{method:'POST',data:{email:(user||f.root).email,password}});if(r.status!==200)throw new Error('TEST_LOGIN_FAILED');return r.cookie;};
  const connect=async(id=f.ids[0])=>{const before=sockets.length;await transport.connect(id);const socket=sockets.length>before?sockets.at(-1):socketById.get(id)||sockets.at(-1);socketById.set(id,socket);socket.ev.emit('creds.update',{registered:true});socket.ev.emit('connection.update',{connection:'open'});await transport.idle();return socket;};
  return {...f,other,tokens,request,api,login,connect,transport,sockets,hooks,mail,relay,alerts,activity,base};
}
