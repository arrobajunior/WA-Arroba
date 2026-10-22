import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { createBranding } from './branding.mjs';
import { openStore } from './store.mjs';
import { passwordHash,passwordValid,digest,equal,sessionToken,publicUser } from './auth.mjs';
import { createTransport } from './transport.mjs';

const directory=path.dirname(fileURLToPath(import.meta.url));
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function text(value,name,max,required=true){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw fail(400,'invalid_field',`Campo ${name} inválido.`);return value;}
function password(value){text(value,'senha',256);if(value.length<12)throw fail(400,'invalid_password','Use uma senha com pelo menos 12 caracteres.');return value;}
function email(value){const v=text(value,'email',254).trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))throw fail(400,'invalid_email','E-mail inválido.');return v;}
function keys(value,allowed){if(Object.keys(value).some(k=>!allowed.includes(k)))throw fail(400,'invalid_field','Campo não reconhecido.');}
function webhookUrl(value){if(value==null)return '';text(value,'webhook_url',2048,false);const v=value.trim();if(!v)return '';let u;try{u=new URL(v);}catch{throw fail(400,'invalid_webhook_url','URL de webhook inválida.');}if(!['http:','https:'].includes(u.protocol))throw fail(400,'invalid_webhook_url','URL de webhook deve usar http ou https.');return v;}
async function body(req,maxBytes=65536){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>maxBytes)throw fail(413,'body_too_large','Arquivo ou corpo da requisição muito grande.');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');if(!raw)return {};const type=(req.headers['content-type']||'').split(';')[0];let parsed;if(type==='application/x-www-form-urlencoded')parsed=Object.fromEntries(new URLSearchParams(raw));else if(type==='application/json'){try{parsed=JSON.parse(raw);}catch{throw fail(400,'invalid_json','JSON inválido.');}}else throw fail(415,'unsupported_type','Use JSON ou formulário.');if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw fail(400,'invalid_body','Envie um objeto.');return parsed;}
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};

export async function createApp({dataDir=path.join(directory,'.data'),port=3210,publicUrl,adminEmail,adminPassword,transportFactory=createTransport,restoreConnections=true}={}) {
  let publicOrigin;
  if(publicUrl){const u=new URL(publicUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('PUBLIC_URL deve conter somente protocolo e domínio.');publicOrigin=u.origin;}
  const store=openStore(dataDir),{db,encrypt,decrypt}=store;
  const branding=createBranding(db);
  try{
    if(!db.prepare("SELECT id FROM users WHERE role='admin'").get()){
      if(!adminEmail||!adminPassword)throw new Error('Primeira execução: defina ADMIN_EMAIL e ADMIN_PASSWORD_FILE (senha de 12+ caracteres).');
      const id=randomBytes(12).toString('hex');
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,'Administrador',email(adminEmail),await passwordHash(password(adminPassword)),'admin',new Date().toISOString());
      db.prepare('UPDATE instances SET owner_id=? WHERE owner_id IS NULL').run(id);
    }
  }catch(e){store.close();throw e;}
  const transport=transportFactory(store),attempts=new Map();
  const dummyHash=await passwordHash(randomBytes(32).toString('hex'));
  const secure=publicOrigin?.startsWith('https:');
  const cookie=(token,maxAge)=>`wa_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure?'; Secure':''}`;
  const lookup=id=>{const row=db.prepare('SELECT * FROM instances WHERE id=?').get(id);if(!row)throw fail(404,'not_found','Instância não encontrada.');return row;};
  const authorize=(user,row)=>{if(user.role!=='admin'&&user.id!==row.owner_id)throw fail(404,'not_found','Instância não encontrada.');};
  const counts=id=>{const result={total:0,queue:0,sent:0,unsent:0,unknown:0,sending:0};for(const r of db.prepare('SELECT status,count(*) AS n FROM messages WHERE instance_id=? GROUP BY status').all(id)){result[r.status]=r.n;result.total+=r.n;}return result;};
  const serialize=(row,secret=false)=>({id:row.id,name:row.name,phone:row.phone,owner_id:row.owner_id,owner_name:db.prepare('SELECT name FROM users WHERE id=?').get(row.owner_id)?.name,created_at:row.created_at,status:transport.state(row.id).status,error:transport.state(row.id).error,message_counts:counts(row.id),webhook_url:row.webhook_url||'',...(secret?{token:decrypt(row.token)}:{})});
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
        if(pathname==='/api/users') {
          if(session.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
          if(method==='GET')return json(res,200,{users:db.prepare('SELECT id,name,email,role,created_at,active FROM users ORDER BY created_at').all()});
          if(method==='POST'){
            const input=await body(req);keys(input,['name','email','password']);const name=text(input.name,'nome',120).trim(),mail=email(input.email),pass=password(input.password);
            if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fail(409,'email_exists','E-mail já cadastrado.');
            const hash=await passwordHash(pass),id=randomBytes(12).toString('hex');
            try{db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(id,name,mail,hash,'user',new Date().toISOString());}catch(e){if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))throw fail(409,'email_exists','E-mail já cadastrado.');throw e;}
            return json(res,201,{user:publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id))});
          }
        }
        if(pathname==='/api/branding'&&method==='PATCH'){
          if(session.role!=='admin')throw fail(403,'forbidden','Somente o Admin Master pode alterar a identidade visual.');
          return json(res,200,{branding:await branding.update(await body(req,4500000))});
        }
        const userMatch=pathname.match(/^\/api\/users\/([a-f0-9]{24})$/);
        if(userMatch&&method==='PATCH'){
          if(session.role!=='admin')throw fail(403,'forbidden','Acesso Admin Master necessário.');
          const target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
          if(!target)throw fail(404,'not_found','Usuário não encontrado.');
          const input=await body(req);keys(input,['name','email','password','active']);
          if(input.active!==undefined&&typeof input.active!=='boolean')throw fail(400,'invalid_field','Status inválido.');
          if(target.role==='admin'&&input.active===false)throw fail(400,'master_protected','O acesso do Admin Master não pode ser bloqueado.');
          const name=input.name===undefined?target.name:text(input.name,'nome',120).trim();
          const mail=input.email===undefined?target.email:email(input.email);
          const hash=input.password===undefined?target.password_hash:await passwordHash(password(input.password));
          const active=input.active===undefined?target.active:Number(input.active);
          if(db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(mail,target.id))throw fail(409,'email_exists','E-mail já cadastrado.');
          db.exec('BEGIN');try{
            db.prepare('UPDATE users SET name=?,email=?,password_hash=?,active=? WHERE id=?').run(name,mail,hash,active,target.id);
            if(!active||input.password!==undefined||mail!==target.email)db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
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
          db.prepare('INSERT INTO instances(id,name,phone,token,settings,created_at,updated_at,owner_id,token_encrypted,auto_connect) VALUES(?,?,?,?,?,?,?,?,1,0)').run(id,name,'',encrypt(randomBytes(32).toString('hex')),'{}',now,now,owner);
          return json(res,201,{instance:serialize(lookup(id),true)});
        }
        if(['/api/instances','/api/dashboard'].includes(pathname)&&method==='GET'){
          const rows=session.role==='admin'?db.prepare('SELECT * FROM instances ORDER BY created_at DESC').all():db.prepare('SELECT * FROM instances WHERE owner_id=? ORDER BY created_at DESC').all(session.id);
          const items=rows.map(r=>serialize(r));
          if(pathname==='/api/instances')return json(res,200,{instances:items});
          const c={instances:items.length,connected:0,queue:0,sent:0,messages:0};for(const i of items){if(i.status==='authenticated')c.connected++;c.queue+=i.message_counts.queue;c.sent+=i.message_counts.sent;c.messages+=i.message_counts.total;}return json(res,200,{counts:c,instances:items});
        }
        const match=pathname.match(/^\/api\/instances\/([a-f0-9]{8})(?:\/(qr|connect|disconnect|token|messages))?$/);
        if(match){const [,id,action]=match,row=lookup(id);authorize(session,row);
          if(!action&&method==='GET')return json(res,200,{instance:serialize(row,true)});
          if(!action&&method==='PATCH'){
            const input=await body(req);keys(input,['name','webhook_url']);
            const sets=[],args=[];
            if('name'in input){sets.push('name=?');args.push(text(input.name,'nome',120).trim());}
            if('webhook_url'in input){sets.push('webhook_url=?');args.push(webhookUrl(input.webhook_url));}
            if(!sets.length)throw fail(400,'invalid_field','Informe ao menos um campo para atualizar.');
            sets.push('updated_at=?');args.push(new Date().toISOString(),id);
            db.prepare(`UPDATE instances SET ${sets.join(',')} WHERE id=?`).run(...args);
            return json(res,200,{instance:serialize(lookup(id),true)});
          }
          if(action==='token'&&method==='POST'){keys(await body(req),[]);db.prepare('UPDATE instances SET token=? WHERE id=?').run(encrypt(randomBytes(32).toString('hex')),id);return json(res,200,{instance:serialize(lookup(id),true)});}
          if(action==='connect'&&method==='POST'){keys(await body(req),[]);transport.connect(id);return json(res,202,{instance:serialize(row,true)});}
          if(action==='disconnect'&&method==='POST'){keys(await body(req),[]);await transport.disconnect(id);return json(res,200,{instance:serialize(lookup(id),true)});}
          if(action==='qr'&&method==='GET'){const s=transport.state(id);return json(res,200,{status:s.status,error:s.error,qr:s.qr?await QRCode.toDataURL(s.qr,{width:280,margin:2}):null});}
          if(action==='messages'&&method==='GET')return listMessages(res,id,url);
        }
        throw fail(404,'not_found','Endpoint não encontrado.');
      }
      const compat=pathname.match(/^\/instance([a-f0-9]{8})\/(instance\/status|instance\/qr|instance\/qrCode|messages\/chat|messages)$/);
      if(compat){
        const [,id,action]=compat;const row=db.prepare('SELECT * FROM instances WHERE id=?').get(id);const input=method==='POST'?await body(req):{};
        const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null;
        const token=bearer||input.token||url.searchParams.get('token');
        if(!row||!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(row.owner_id)||typeof token!=='string'||!equal(token,decrypt(row.token)))throw fail(401,'invalid_token','Token ou instância inválidos.');
        if(action==='instance/status'&&method==='GET')return json(res,200,{status:{accountStatus:transport.state(id).status}});
        if(['instance/qr','instance/qrCode'].includes(action)&&method==='GET'){const s=transport.state(id);if(action==='instance/qrCode')return json(res,200,{status:s.status,qrCode:s.qr});if(!s.qr)throw fail(409,'qr_unavailable','Gere o QR Code pelo painel.');res.writeHead(200,{'Content-Type':'image/png'});return res.end(await QRCode.toBuffer(s.qr,{width:280}));}
        if(action==='messages'&&method==='GET')return listMessages(res,id,url);
        if(action==='messages/chat'&&method==='POST'){
          keys(input,['token','to','body']);const recipient=text(input.to,'destino',80),message=text(input.body,'mensagem',4096);
          if(!/^\+?\d{6,20}$/.test(recipient)&&!/^[0-9-]+@(c\.us|g\.us|s\.whatsapp\.net)$/.test(recipient))throw fail(400,'invalid_recipient','Use telefone internacional ou ID de grupo/contato.');
          if(db.prepare("SELECT count(*) AS n FROM messages WHERE instance_id=? AND status IN ('queue','sending')").get(id).n>=1000)throw fail(429,'queue_full','Fila cheia; aguarde o processamento.');
          const messageId=randomBytes(12).toString('hex');db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run(messageId,id,recipient,message,'chat','queue','pending',new Date().toISOString());
          transport.flush(id);return json(res,202,{id:messageId,status:'queue',sent:false,message:'Mensagem aceita para processamento. Consulte o histórico para acompanhar o envio.'});
        }
        throw fail(405,'method_not_allowed','Método não permitido.');
      }
      if(pathname.startsWith('/instance'))throw fail(404,'not_found','Endpoint não encontrado.');
      if(!['GET','HEAD'].includes(method))throw fail(405,'method_not_allowed','Método não permitido.');
      const publicDir=path.join(directory,'public');const target=path.resolve(publicDir,`.${decoded==='/'?'/index.html':decoded}`);
      if(!target.startsWith(publicDir+path.sep))throw fail(403,'invalid_path','Caminho não permitido.');
      let resolved;try{resolved=await realpath(target);}catch{throw fail(404,'not_found','Arquivo não encontrado.');}
      if(!resolved.startsWith(await realpath(publicDir)+path.sep))throw fail(403,'invalid_path','Caminho não permitido.');
      const data=await readFile(resolved);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'})[path.extname(resolved)]||'application/octet-stream'});res.end(method==='HEAD'?undefined:data);
    }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.code||'internal_error',message:e.status?e.message:'Não foi possível concluir a operação. Tente novamente.'});else res.end();}
  });
  function listMessages(res,id,url){const status=url.searchParams.get('status')||'',query=url.searchParams.get('query')||'';text(query,'busca',4096,false);if(status&&!['queue','sent','sending','unsent','unknown','received'].includes(status))throw fail(400,'invalid_status','Status inválido.');const where="instance_id=? AND (?='' OR status=?) AND (?='' OR instr(body,?)>0 OR instr(recipient,?)>0)";const args=[id,status,status,query,query,query];const rows=db.prepare(`SELECT id,recipient AS "to",body,status,ack,created_at,error FROM messages WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT 100`).all(...args);const total=db.prepare(`SELECT count(*) AS n FROM messages WHERE ${where}`).get(...args).n;return json(res,200,{messages:rows,total,limit:100});}
  server.requestTimeout=30000;server.headersTimeout=15000;
  let stop;
  server.shutdown=()=>stop||=(async()=>{shuttingDown=true;const drained=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();await drained;await transport.close();store.close();})();
  if(restoreConnections)transport.restore();
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
