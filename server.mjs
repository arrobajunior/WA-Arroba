import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {createMediaRelay,MAX_MEDIA_BYTES} from './media-relay.mjs';
import {createMediaStorage} from './media-storage.mjs';
import {createCompatibilityApi} from './compatibility-api.mjs';
import { createBranding } from './branding.mjs';
import { openStore } from './store.mjs';
import { passwordHash,passwordValid,digest,equal,sessionToken,publicUser } from './auth.mjs';
import { createTransport } from './transport.mjs';
import {createConnectionAlerts} from './connection-alerts.mjs';
import {createIncidentHistory} from './incident-history.mjs';
import {createInstanceActivity} from './instance-activity.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function text(value,name,max,required=true){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fail(400,'invalid_field',`Campo ${name} inválido.`);return value;}
function priority(value=10){const n=Number(value);if(!Number.isInteger(n)||n<0||n>10)throw fail(400,'invalid_priority','priority deve estar entre 0 e 10.');return n;}
function password(value){text(value,'senha',256);if(value.length<12)throw fail(400,'invalid_password','Use uma senha com pelo menos 12 caracteres.');return value;}
function email(value){const v=text(value,'email',254).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw fail(400,'invalid_email','E-mail inválido.');return v;}
function keys(value,allowed){if(Object.keys(value).some(k=>!allowed.includes(k)))throw fail(400,'invalid_field','Campo não reconhecido.');}
function webhookUrl(value){if(value==null)return '';text(value,'webhook_url',2048,false);const v=value.trim();if(!v)return '';let u;try{u=new URL(v);}catch{throw fail(400,'invalid_webhook_url','URL de webhook inválida.');}if(!['http:','https:'].includes(u.protocol))throw fail(400,'invalid_webhook_url','URL de webhook deve usar http ou https.');return v;}
async function body(req,maxBytes=65536){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw fail(413,'body_too_large','Arquivo ou corpo da requisição muito grande.');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');if(!raw)return {};const type=(req.headers['content-type']||'').split(';')[0];let parsed;if(type==='application/x-www-form-urlencoded')parsed=Object.fromEntries(new URLSearchParams(raw));else if(type==='application/json'){try{parsed=JSON.parse(raw);}catch{throw fail(400,'invalid_json','JSON inválido.');}}else throw fail(415,'unsupported_type','Use JSON ou formulário.');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw fail(400,'invalid_body','Envie um objeto.');return parsed;}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};

export async function createApp({dataDir=path.join(directory,'.data'),port=3210,publicUrl,adminEmail,adminPassword,transportFactory=createTransport,restoreConnections=true,mediaStorage=null,mediaRelay=createMediaRelay(),alertOptions={}}={}) {
  let publicOrigin;
  if(publicUrl){const u=new URL(publicUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('PUBLIC_URL deve conter somente protocolo e domínio.');publicOrigin=u.origin;}
  // S3 is only read on demand to preserve access to files from older releases.
  let legacyStorage=mediaStorage;const legacy=()=>legacyStorage??=(process.env.S3_BUCKET?createMediaStorage():null);
  console.log('Mídia: retransmissão temporária em memória; sem novas gravações no S3 ou SQLite.');
  const store=openStore(dataDir),{db,encrypt,decrypt}=store;
  const branding=createBranding(db);
  try{
    if(!db.prepare("SELECT id FROM users WHERE is_master=1").get()){
      if(!adminEmail||!adminPassword)throw new Error('Primeira execução: defina ADMIN_EMAIL e ADMIN_PASSWORD_FILE (senha de 12+ caracteres).');
      const id=randomBytes(12).toString('hex');
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,'Administrador',email(adminEmail),await passwordHash(password(adminPassword)),'admin',new Date().toISOString());
      db.prepare('UPDATE users SET is_master=1 WHERE id=?').run(id);
      db.prepare('UPDATE instances SET owner_id=? WHERE owner_id IS NULL').run(id);
    }
  }catch(e){store.close();throw e;}
  const mediaBaseUrl=publicOrigin||`http://127.0.0.1:${port}`;
  const activity=createInstanceActivity(db);
  const alerts=createConnectionAlerts(store,{publicUrl:publicOrigin,appName:()=>branding.read().name,...alertOptions,onConnectionEvent:activity.connectionState});
  const incidentHistory=createIncidentHistory(db);
  const transport=transportFactory(store,{mediaBaseUrl,mediaRelay,legacyStorage:legacy,onConnectionState:alerts.stateChanged}),attempts=new Map();
  const dummyHash=await passwordHash(randomBytes(32).toString('hex'));
  const secure=publicOrigin?.startsWith('https:');
  const cookie=(token,maxAge)=>`wa_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  const lookup=id=>{const row=db.prepare('SELECT * FROM instances WHERE id=?').get(id);if(!row)throw fail(404,'not_found','Instância não encontrada.');return row;};
  const authorize=(user,row)=>{if(user.role!=='admin'&&user.id!==row.owner_id){activity.record({instance:row,actor:activity.userActor(user),action:'instance_access_denied',outcome:'denied',source:'panel'});throw fail(404,'not_found','Instância não encontrada.');}};
  const audited=(user,req,row,action,before,operation,after)=>activity.run({instance:row,actor:activity.userActor(user),action,before,source:'panel',peer_ip:req.socket.remoteAddress||''},operation,after);
  const counts=id=>{const result={total:0,queue:0,sent:0,unsent:0,unknown:0,sending:0};for(const r of db.prepare('SELECT status,count(*) AS n FROM messages WHERE instance_id=? GROUP BY status').all(id)){result[r.status]=r.n;result.total+=r.n;}return result;};
  const serialize=(row,secret=false)=>({id:row.id,name:row.name,phone:row.phone,owner_id:row.owner_id,owner_name:db.prepare('SELECT name FROM users WHERE id=?').get(row.owner_id)?.name,created_at:row.created_at,active:Boolean(row.active),disabled_at:row.disabled_at,disabled_by:row.disabled_by,status:row.active?transport.state(row.id).status:'disabled',error:row.active?transport.state(row.id).error:null,first_connected_at:row.first_connected_at,last_connected_at:row.last_connected_at,connection_alert:row.active?(db.prepare('SELECT id,opened_at,reason,notification_status FROM connection_incidents WHERE instance_id=? AND resolved_at IS NULL').get(row.id)||null):null,message_counts:counts(row.id),webhook_url:row.webhook_url||'',...(secret?{token:decrypt(row.token)}:{})});
  const compatibility=createCompatibilityApi({store:{...store,equalToken:equal},transport,relay:mediaRelay,baseUrl:mediaBaseUrl,legacy,json,fail,text,keys,body,webhookUrl,activity});
  let shuttingDown=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(shuttingDown)throw fail(503,'shutting_down','Servidor reiniciando.');
      const actualPort=server.address()?.port||port;
      const host=req.headers.host;
      const origins=publicOrigin?[publicOrigin]:[`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`];
      const allowedHosts=origins.map(o=>new URL(o).host);
      // Railway uses its own healthcheck Host; this endpoint exposes no account data.
      if(req.url==='/api/health'&&req.method==='GET')return json(res,200,{ok:true});
      if(!allowedHosts.includes(host))throw fail(403,'invalid_host','Host não permitido.');
      let decoded;try{decoded=decodeURIComponent(req.url.split('?')[0]);}catch{throw fail(400,'invalid_path','Caminho inválido.');}
      if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').includes('..'))throw fail(403,'invalid_path','Caminho não permitido.');
      const url=new URL(req.url,origins[0]),pathname=url.pathname,method=req.method;
      if(!['GET','HEAD','POST','PATCH'].includes(method))throw fail(405,'method_not_allowed','Método não permitido.');
      if(pathname.startsWith('/api/')&&['POST','PATCH'].includes(method)) {
        if((req.headers.origin&&!origins.includes(req.headers.origin))||req.headers['x-requested-with']!=='wa-platform')throw fail(403,'csrf_rejected','Origem não permitida.');
      }
      if(pathname==='/api/health'&&method==='GET')return json(res,200,{ok:true});
      if(pathname==='/api/branding'&&method==='GET')return json(res,200,{branding:branding.read()});
      const brandAsset=pathname.match(/^\/brand-assets\/(positive|negative|favicon)\.png$/);
      if(brandAsset&&method==='GET'){const data=branding.asset(brandAsset[1]);if(!data)throw fail(404,'not_found','Imagem não encontrada.');res.writeHead(200,{'Content-Type':'image/png'});return res.end(data);}
      if(pathname==='/api/auth/login'&&method==='POST') {
        const input=await body(req);keys(input,['email','password']);const login=email(input.email);text(input.password,'senha',256);
        const now=Date.now();for(const [key,value] of attempts)if(value.expires<now)attempts.delete(key);
        const limitKeys=[`user:${login}`,`ip:${req.socket.remoteAddress}`];
        for(const key of limitKeys){const entry=attempts.get(key);if(entry?.count>=20){res.setHeader('Retry-After','900');throw fail(429,'rate_limited','Muitas tentativas. Aguarde 15 minutos.');}}
        if(attempts.size>10000)throw fail(429,'rate_limited','Aguarde para tentar novamente.');
        for(const key of limitKeys){const entry=attempts.get(key)||{count:0,expires:now+900000};entry.count++;attempts.set(key,entry);}
        const user=db.prepare('SELECT * FROM users WHERE email=?').get(login);
        const valid=await passwordValid(input.password,user?.password_hash||dummyHash);
        if(!user||!valid||!user.active)throw fail(401,'invalid_credentials','E-mail ou senha inválidos.');
        attempts.delete(`user:${login}`);
        // Keep IP failures bounded, but successful logins do not consume its quota.
        const ipEntry=attempts.get(limitKeys[1]);if(ipEntry)ipEntry.count--;
        db.prepare('DELETE FROM sessions WHERE expires_at < ? OR id=?').run(now,digest(sessionToken(req)));
        const token=randomBytes(32).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,now+43200000);
        res.setHeader('Set-Cookie',cookie(token,43200));return json(res,200,{user:publicUser(user)});
      }
      const session=db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE sessions.id=? AND sessions.expires_at>? AND users.active=1').get(digest(sessionToken(req)),Date.now());
      if(pathname.startsWith('/api/')) {
        if(!session)throw fail(401,'unauthorized','Faça login para continuar.');
        if(pathname==='/api/auth/me'&&method==='GET')return json(res,200,{user:publicUser(session)});
        if(pathname==='/api/auth/logout'&&method==='POST'){db.prepare('DELETE FROM sessions WHERE id=?').run(digest(sessionToken(req)));res.setHeader('Set-Cookie',cookie('',0));return json(res,200,{ok:true});}
        if(pathname.startsWith('/api/general-admin')){
          if(session.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
          if(pathname==='/api/general-admin/activity'&&method==='GET')return json(res,200,activity.list(url.searchParams));
          if(pathname==='/api/general-admin/incidents'&&method==='GET')return json(res,200,incidentHistory.list(url.searchParams));
          const incidentMatch=pathname.match(/^\/api\/general-admin\/incidents\/(\d+)$/);
          if(incidentMatch&&method==='GET')return json(res,200,incidentHistory.detail(incidentMatch[1],url.searchParams));
          if(pathname==='/api/general-admin'&&method==='GET')return json(res,200,{settings:alerts.settings(),smtp_ready:alerts.mailReady(),audit:db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 100').all(),incidents:db.prepare('SELECT c.*,c.instance_phone AS phone FROM connection_incidents c ORDER BY c.id DESC LIMIT 100').all()});
          if(pathname==='/api/general-admin'&&method==='PATCH'){
            const input=await body(req);keys(input,['alert_email']);
            // A single plain address, never SMTP headers, lists or display names.
            const raw=text(input.alert_email,'email de alerta',254).trim();
            if(!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(raw))throw fail(400,'invalid_email','Informe um único endereço de e-mail válido.');
            const saved=await audited(session,req,null,'alert_email_updated',{alert_email:alerts.settings().alert_email},()=>alerts.updateEmail(session,raw),result=>({alert_email:result.alert_email}));
            return json(res,200,{settings:saved});
          }
          if(pathname==='/api/general-admin/test-email'&&method==='POST'){keys(await body(req),[]);await audited(session,req,null,'alert_email_test',{},()=>alerts.sendTest(session));return json(res,200,{ok:true});}
          throw fail(404,'not_found','Endpoint não encontrado.');
        }
        if(pathname==='/api/users') {
          if(session.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
          if(method==='GET')return json(res,200,{users:db.prepare('SELECT id,name,email,role,created_at,active,is_master FROM users ORDER BY created_at').all()});
          if(method==='POST'){
            const input=await body(req);keys(input,['name','email','password','role']);const role=input.role??'user';if(!['user','admin'].includes(role))throw fail(400,'invalid_role','Perfil inválido.');const name=text(input.name,'nome',120).trim(),mail=email(input.email),pass=password(input.password);
            if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fail(409,'email_exists','E-mail já cadastrado.');
            const hash=await passwordHash(pass),id=randomBytes(12).toString('hex');
            try{db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,name,mail,hash,role,new Date().toISOString());}catch(e){if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fail(409,'email_exists','E-mail já cadastrado.');throw e;}
            return json(res,201,{user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
          }
        }
        if(pathname==='/api/branding'&&method==='PATCH'){
          if(!session.is_master)throw fail(403,'forbidden','Somente o Admin Master pode alterar a identidade visual.');
          return json(res,200,{branding:await branding.update(await body(req,4500000))});
        }
        const userMatch=pathname.match(/^\/api\/users\/([a-f0-9]{24})$/);
        if(userMatch&&method==='PATCH'){
          if(session.role!=='admin')throw fail(403,'forbidden','Acesso Admin Master necessário.');
          const target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
          if(!target)throw fail(404,'not_found','Usuário não encontrado.');
          if(target.is_master&&session.id!==target.id)throw fail(403,'master_protected','Somente o próprio Admin Master pode editar sua conta.');
          const input=await body(req);keys(input,['name','email','password','active','role']);
          const role=input.role??target.role;
          if(!['user','admin'].includes(role))throw fail(400,'invalid_role','Perfil inválido.');
          if(input.active!==undefined&&typeof input.active!=='boolean')throw fail(400,'invalid_field','Status inválido.');
          if(target.is_master&&(input.active===false||role!=='admin'))throw fail(400,'master_protected','O acesso do Admin Master não pode ser bloqueado.');
          const name=input.name===undefined?target.name:text(input.name,'nome',120).trim();
          const mail=input.email===undefined?target.email:email(input.email);
          const hash=input.password===undefined?target.password_hash:await passwordHash(password(input.password));
          const active=input.active===undefined?target.active:Number(input.active);
          if(db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(mail,target.id))throw fail(409,'email_exists','E-mail já cadastrado.');
          db.exec('BEGIN');try{
            db.prepare('UPDATE users SET name=?,email=?,password_hash=?,active=?,role=? WHERE id=?').run(name,mail,hash,active,role,target.id);
            if(!active||input.password!==undefined||mail!==target.email||role!==target.role)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
            db.exec('COMMIT');
          }catch(e){db.exec('ROLLBACK');throw e;}
          if(active)for(const row of db.prepare('SELECT id FROM instances WHERE owner_id=?').all(target.id))transport.flush(row.id);
          return json(res,200,{user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
        }
        if(pathname==='/api/instances'&&method==='POST'){
          const input=await body(req);keys(input,['name','owner_id']);const name=text(input.name,'nome',120).trim();
          const owner=session.role==='admin'?(input.owner_id||session.id):session.id;
          if(input.owner_id&&session.role!=='admin'&&input.owner_id!==session.id)throw fail(403,'forbidden','Não é possível criar para outro usuário.');
          if(typeof owner!=='string'||!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(owner))throw fail(400,'invalid_owner','Usuário não encontrado.');
          if(db.prepare('SELECT count(*) AS n FROM instances WHERE owner_id=?').get(owner).n>=50)throw fail(409,'instance_limit','Limite de 50 instâncias por usuário nesta versão.');
          const id=randomBytes(4).toString('hex'),now=new Date().toISOString();
          db.exec('BEGIN');try{
            db.prepare('INSERT INTO instances(id,name,phone,token,settings,created_at,updated_at,owner_id,token_encrypted,auto_connect) VALUES(?,?,?,?,?,?,?,?,1,0)').run(id,name,'',encrypt(randomBytes(32).toString('hex')),'{}',now,now,owner);
            activity.record({instance:{id,name},actor:activity.userActor(session),action:'instance_created',outcome:'success',source:'panel',after:{name,owner_id:owner},peer_ip:req.socket.remoteAddress||''});
            db.exec('COMMIT');
          }catch(error){db.exec('ROLLBACK');throw error;}
          return json(res,201,{instance:serialize(lookup(id),true)});
        }
        if(['/api/instances','/api/dashboard'].includes(pathname)&&method==='GET'){
          const state=pathname==='/api/dashboard'?'active':url.searchParams.get('state')||'active';
          if(!['active','disabled','all'].includes(state))throw fail(400,'invalid_state','Filtro de instâncias inválido.');
          const visible=session.role==='admin'?db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all():db.prepare('SELECT * FROM instances WHERE owner_id=? ORDER BY created_at DESC').all(session.id);
          const totals={active:visible.filter(r=>r.active===1).length,disabled:visible.filter(r=>r.active===0).length};
          const items=visible.filter(r=>state==='all'||r.active===(state==='active'?1:0)).map(r=>serialize(r));
          if(pathname==='/api/instances')return json(res,200,{instances:items,totals});
          const c={instances:items.length,disabled:totals.disabled,connected:0,queue:0,sent:0,messages:0,alerts:0};for(const i of items){if(i.connection_alert)c.alerts++;if(i.status==='authenticated')c.connected++;c.queue+=i.message_counts.queue;c.sent+=i.message_counts.sent;c.messages+=i.message_counts.total;}return json(res,200,{counts:c,instances:items});
        }
        const match=pathname.match(/^\/api\/instances\/([a-f0-9]{8})(?:\/(qr|connect|disconnect|token|messages|activity|credential-access|lifecycle))?$/);
        if(match){const [,id,action]=match,row=lookup(id);authorize(session,row);
          if(!action&&method==='GET')return json(res,200,{instance:serialize(row,true)});
          if(action==='lifecycle'&&method==='POST'){
            const input=await body(req);keys(input,['active']);if(typeof input.active!=='boolean')throw fail(400,'invalid_field','Informe active como verdadeiro ou falso.');
            const actionName=input.active?'instance_reactivated':'instance_deactivated';
            const updated=await audited(session,req,row,actionName,{active:Boolean(row.active)},async()=>{
              if(Boolean(lookup(id).active)!==input.active)db.prepare('UPDATE instances SET active=?,auto_connect=0,disabled_at=?,disabled_by=?,updated_at=? WHERE id=?').run(Number(input.active),input.active?null:new Date().toISOString(),input.active?null:session.id,new Date().toISOString(),id);
              if(!input.active){try{alerts.deactivate(id);}finally{await transport.suspend(id);}}
              return lookup(id);
            },result=>({active:Boolean(result.active),disabled_at:result.disabled_at}));
            return json(res,200,{instance:serialize(updated,true)});
          }
          if(action==='activity'&&method==='GET')return json(res,200,activity.list(url.searchParams,id));
          if(action==='credential-access'&&method==='POST'){
            const input=await body(req);keys(input,['action']);if(!['reveal','copy'].includes(input.action))throw fail(400,'invalid_field','Ação inválida.');
            activity.record({instance:row,actor:activity.userActor(session),action:input.action==='copy'?'token_copy_requested':'token_reveal_requested',outcome:'requested',source:'panel',peer_ip:req.socket.remoteAddress||''});return json(res,200,{ok:true});
          }
          if(!action&&method==='PATCH'){
            const updated=await audited(session,req,row,'instance_updated',activity.snapshot(row),async()=>{
              const input=await body(req);keys(input,['name','webhook_url']);const sets=[],args=[];
              if('name'in input){sets.push('name=?');args.push(text(input.name,'nome',120).trim());}
              if('webhook_url'in input){sets.push('webhook_url=?');args.push(webhookUrl(input.webhook_url));}
              if(!sets.length)throw fail(400,'invalid_field','Informe ao menos um campo para atualizar.');
              sets.push('updated_at=?');args.push(new Date().toISOString(),id);db.prepare(`UPDATE instances SET ${sets.join(',')} WHERE id=?`).run(...args);return lookup(id);
            },activity.snapshot);return json(res,200,{instance:serialize(updated,true)});
          }
          if(action==='token'&&method==='POST'){await audited(session,req,row,'token_rotated',{},async()=>{keys(await body(req),[]);db.prepare('UPDATE instances SET token=? WHERE id=?').run(encrypt(randomBytes(32).toString('hex')),id);},()=>({token_rotated:true}));return json(res,200,{instance:serialize(lookup(id),true)});}
          if(action==='connect'&&method==='POST'){await audited(session,req,row,'connection_requested',{},async context=>{keys(await body(req),[]);if(!lookup(id).active)throw fail(409,'instance_disabled','Reative a instância antes de conectar.');transport.connect(id,0,context);});return json(res,202,{instance:serialize(row,true)});}
          if(action==='disconnect'&&method==='POST'){await audited(session,req,row,'disconnection_requested',{},async context=>{keys(await body(req),[]);if(!lookup(id).active)throw fail(409,'instance_disabled','Instância desativada.');await transport.disconnect(id,context);});return json(res,200,{instance:serialize(lookup(id),true)});}
          if(action==='qr'&&method==='GET'){if(!row.active)return json(res,200,{status:'disabled',error:null,qr:null});const s=transport.state(id);return json(res,200,{status:s.status,error:s.error,qr:s.qr?await QRCode.toDataURL(s.qr,{width:280,margin:2}):null});}
          if(action==='messages'&&method==='GET'){activity.record({instance:row,actor:activity.userActor(session),action:'messages_viewed',outcome:'observed',source:'panel',peer_ip:req.socket.remoteAddress||''});return await listMessages(res,id,url);}
        }
        throw fail(404,'not_found','Endpoint não encontrado.');
      }
      const relayRoute=pathname.match(/^\/instance([a-f0-9]{8})\/media\/([a-f0-9]{48})$/);
      if(relayRoute&&method==='GET'){
        const [,instanceId,key]=relayRoute,entry=mediaRelay.get(instanceId,key);
        const active=db.prepare('SELECT users.active FROM users JOIN instances ON instances.owner_id=users.id WHERE instances.id=? AND instances.active=1').get(instanceId)?.active;
        if(!entry||active!==1)throw fail(404,'media_expired','Mídia temporária indisponível. O cliente deve salvar o arquivo ao receber o webhook.');
        res.writeHead(200,{'Content-Type':entry.mimetype,'Content-Length':entry.bytes.length,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(entry.filename),'Cache-Control':'no-store'});return res.end(entry.bytes);
      }
      const compat=pathname.match(/^\/instance([a-f0-9]{8})\/(.+)$/);
      if(compat)return await compatibility(req,res,compat[1],compat[2],url);
      if(pathname.startsWith('/instance'))throw fail(404,'not_found','Endpoint não encontrado.');
      if(!['GET','HEAD'].includes(method))throw fail(405,'method_not_allowed','Método não permitido.');
      const publicDir=path.join(directory,'public');const target=path.resolve(publicDir,`.${decoded==='/'?'/index.html':decoded}`);
      if(!target.startsWith(publicDir+path.sep))throw fail(403,'invalid_path','Caminho não permitido.');
      let resolved;try{resolved=await realpath(target);}catch{throw fail(404,'not_found','Arquivo não encontrado.');}
      if(!resolved.startsWith(await realpath(publicDir)+path.sep))throw fail(403,'invalid_path','Caminho não permitido.');
      const data=await readFile(resolved);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'})[path.extname(resolved)]||'application/octet-stream'});res.end(method==='HEAD'?undefined:data);
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.code||'internal_error',message:e.status?e.message:'Não foi possível concluir a operação. Tente novamente.'});else res.end();}
  });
  async function listMessages(res,id,url){
    const status=url.searchParams.get('status')==='all'?'':url.searchParams.get('status')||'',query=url.searchParams.get('query')||'';
    text(query,'busca',4096,false);
    if(status&&!['all','invalid','queue','sent','sending','unsent','unknown','received'].includes(status))throw fail(400,'invalid_status','Status inválido.');
    const page=Number(url.searchParams.get('page')||1),limit=Number(url.searchParams.get('limit')||100),sort=url.searchParams.get('sort')||'desc';
    if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(sort))throw fail(400,'invalid_pagination','Paginação inválida.');
    const where="instance_id=? AND (?='' OR status=?) AND (?='' OR instr(body,?)>0 OR instr(recipient,?)>0)";
    const args=[id,status,status,query,query,query];
    const rows=db.prepare(`SELECT id,recipient AS "to",body,type,status,ack,created_at,error,media_id,provider_id,reference_id,filename FROM messages WHERE ${where} ORDER BY created_at ${sort==='asc'?'ASC':'DESC'},id ${sort==='asc'?'ASC':'DESC'} LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit);
    // sent_at (epoch em segundos) no mesmo formato que o UltraMsg devolve — é o campo
    // que o MF Rural usa para casar a confirmação de entrega com a mensagem salva.
    const messages=await Promise.all(rows.map(async r=>{
      const object=db.prepare('SELECT object_key,mimetype FROM media_objects WHERE instance_id=? AND message_id=?').get(id,r.media_id||r.provider_id);
      const {media_id,provider_id,reference_id,...item}=r;
      const entry=mediaRelay.get(id,media_id);
      if(entry)item.media=mediaRelay.url(mediaBaseUrl,id,media_id);
      return {...item,referenceId:reference_id,sent_at:Math.floor(new Date(r.created_at).getTime()/1000),...(object&&legacy()?{media:await legacy().url(object.object_key),mimetype:object.mimetype}:{})};
    }));
    const total=db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get(...args).n;
    return json(res,200,{messages,total,limit,page});
  }
  server.requestTimeout=30000;server.headersTimeout=15000;
  let stop;
  server.shutdown=()=>stop||=(async()=>{shuttingDown=true;const drained=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();await drained;await transport.close();await alerts.close();mediaRelay.close();legacyStorage?.close?.();store.close();})();
  if(restoreConnections)transport.restore();
  alerts.start(transport.state);
  return server;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||3210),host=process.env.HOST||'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT inválida.');
  if(!['127.0.0.1','::1','localhost'].includes(host)&&!process.env.PUBLIC_URL)throw new Error('PUBLIC_URL é obrigatória para acesso externo.');
  const adminPassword=process.env.ADMIN_PASSWORD_FILE?(await readFile(process.env.ADMIN_PASSWORD_FILE,'utf8')).trimEnd():process.env.ADMIN_PASSWORD;
  const server=await createApp({port,dataDir:process.env.DATA_DIR||path.join(directory,'.data'),publicUrl:process.env.PUBLIC_URL,adminEmail:process.env.ADMIN_EMAIL,adminPassword});
  server.listen(port,host,()=>console.log(`WA Platform: ${process.env.PUBLIC_URL||`http://127.0.0.1:${port}`}`));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.shutdown());
}
