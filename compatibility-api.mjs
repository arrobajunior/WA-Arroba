import {randomBytes} from 'node:crypto';
import QRCode from 'qrcode';
import {mediaInput,multipart} from './media-input.mjs';
import {MAX_MEDIA_BYTES} from './media-relay.mjs';
import {readSettings,parseSettings,publicJid,whatsappJid} from './instance-settings.mjs';

export function createCompatibilityApi({store,transport,relay,baseUrl,legacy,json,fail,text,keys,body,webhookUrl}){
 const {db,encrypt,decrypt}=store;
 const mediaKinds=['image','audio','voice','video','document','sticker'];
 const numberId=id=>db.prepare('SELECT api_id FROM api_messages WHERE message_id=?').get(id)?.api_id;
 const priority=value=>{const n=Number(value??10);if(!Number.isInteger(n)||n<0||n>10)throw fail(400,'invalid_priority','priority deve estar entre 0 e 10.');return n;};
 const recipient=value=>{const v=text(value,'to',80);if(!/^\+?\d{6,20}$/.test(v)&&!/^\d[0-9-]*@(c\.us|g\.us|s\.whatsapp\.net|lid)$/.test(v))throw fail(400,'invalid_recipient','Destinatário inválido.');return v;};
 const queue=(id,input,{kind,content='',media,payload={}})=>{
  if(db.prepare("SELECT count(*) AS n FROM messages WHERE instance_id=? AND status IN ('queue','sending')").get(id).n>=1000)throw fail(429,'queue_full','Fila cheia.');
  const to=recipient(input.to),ref=text(input.referenceId??'','referenceId',255,false),rank=priority(input.priority);
  const messageId=randomBytes(12).toString('hex'),now=new Date().toISOString();
  const key=media?relay.put(id,media.bytes,media.mimetype,media.filename||'file'):null;
  const field=kind==='voice'?'audio':kind;const url=typeof input[field]==='string'&&/^https?:\/\//i.test(input[field])?encrypt(input[field]):'';
  try{db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,media_id,reference_id,priority,filename,payload,source_url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(messageId,id,to,content,kind==='voice'?'ptt':kind,'queue','pending',now,key,ref,rank,media?.filename||'',JSON.stringify(payload),url);}catch(error){if(key)relay.remove(key);throw error;}
  transport.flush(id);return {sent:'true',message:'ok',id:numberId(messageId)};
 };
 async function list(res,id,row,url){
  const p=url.searchParams,status=p.get('status')||'all',page=Number(p.get('page')||1),limit=Number(p.get('limit')||100),sort=p.get('sort')||'asc';
  if(!['all','queue','sent','unsent','invalid','expired','sending','unknown','received'].includes(status))throw fail(400,'invalid_status','Status inválido.');
  if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(sort)||(page-1)*limit>Number.MAX_SAFE_INTEGER)throw fail(400,'invalid_pagination','Paginação inválida.');
  const where=['m.instance_id=?',"m.direction='out'"],args=[id];
  if(status!=='all'){where.push('m.status=?');args.push(status);}
  for(const [param,expression] of [['referenceId','m.reference_id'],['ack','m.ack']])if(p.has(param)&&p.get(param)!==''){where.push(expression+'=?');args.push(p.get(param));}
  if(p.get('id')){where.push('(a.api_id=? OR m.id=?)');args.push(p.get('id'),p.get('id'));}
  if(p.get('from')&&publicJid(p.get('from'))!==publicJid(row.phone))where.push('0=1');
  if(p.get('to')){where.push("REPLACE(CASE WHEN instr(m.recipient,'@')=0 THEN ltrim(m.recipient,'+')||'@c.us' ELSE m.recipient END,'@s.whatsapp.net','@c.us')=?");args.push(publicJid(p.get('to')));}
  const sql=where.join(' AND '),total=db.prepare(`SELECT count(*) AS n FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE ${sql}`).get(...args).n;
  const messages=db.prepare(`SELECT m.*,a.api_id FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE ${sql} ORDER BY a.api_id ${sort==='asc'?'ASC':'DESC'} LIMIT ? OFFSET ?`).all(...args,limit,(page-1)*limit).map(m=>({id:m.api_id,referenceId:m.reference_id||null,from:publicJid(row.phone),to:publicJid(m.recipient),body:m.body,priority:m.priority,status:m.status,ack:m.ack,type:m.type,created_at:Math.floor(Date.parse(m.created_at)/1000),sent_at:m.sent_at||0,metadata:{}}));
  return json(res,200,{total,pages:Math.ceil(total/limit),limit,page,messages});
 }
 const supported=new Set(['instance/clear','instance/status','instance/qr','instance/qrCode','instance/settings','instance/me','instance/restart','instance/logout','instance/takeover','messages','messages/statistics','messages/delete','messages/clear','messages/resendById','messages/resendByStatus','media/upload',...mediaKinds.map(k=>'messages/'+k),...['chat','link','contact','location','vcard','reaction'].map(k=>'messages/'+k),'groups','groups/ids','groups/group','contacts/ids','contacts/image','contacts/invalid','chats/ids','contacts','contacts/contact','contacts/check','contacts/blocked','contacts/block','contacts/unblock','chats','chats/messages','chats/read','chats/archive','chats/unarchive','chats/delete','chats/clearMessages']);
 return async function handle(req,res,id,action,url){
  const method=req.method,row=db.prepare('SELECT * FROM instances WHERE id=?').get(id);
  const mediaSend=mediaKinds.some(k=>action==='messages/'+k)||action==='media/upload';
  const input=method==='POST'?(mediaSend&&(req.headers['content-type']||'').startsWith('multipart/form-data')?await multipart(req):await body(req,mediaSend?Math.ceil(MAX_MEDIA_BYTES*4/3)+32768:65536)):{};
  const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null,token=bearer||input.token||url.searchParams.get('token');
  if(!row||!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(row.owner_id)||typeof token!=='string'||!store.equalToken(token,decrypt(row.token)))throw fail(401,'invalid_token','Token ou instância inválidos.');
  if(action.startsWith('media/')&&method==='GET'){
   const fileId=action.slice(6),object=db.prepare('SELECT object_key FROM media_objects WHERE instance_id=? AND message_id=?').get(id,fileId);
   if(object&&legacy()){res.writeHead(302,{Location:await legacy().url(object.object_key),'Cache-Control':'no-store'});return res.end();}
   const file=db.prepare('SELECT mimetype,data FROM media WHERE instance_id=? AND message_id=?').get(id,fileId);if(!file)throw fail(404,'media_expired','Mídia indisponível.');
   res.writeHead(200,{'Content-Type':file.mimetype,'Content-Length':file.data.length,'Cache-Control':'no-store'});return res.end(file.data);
  }
  db.prepare("UPDATE messages SET status='expired',error='Mensagem expirou após 24 horas na fila.' WHERE instance_id=? AND status='queue' AND COALESCE(queued_at,CAST(strftime('%s',created_at) AS INTEGER))<?").run(id,Math.floor(Date.now()/1000)-86400);
  if(!supported.has(action))throw fail(501,'not_implemented','Operação ainda não implementada nesta API.');
  if(action==='instance/status'&&method==='GET'){const s=transport.state(id);return json(res,200,{status:{accountStatus:s.status==='qr'?'qr':s.status}});}
  if(['instance/qr','instance/qrCode'].includes(action)&&method==='GET'){
   let s=transport.state(id);if(s.status==='disconnected'){transport.connect(id);s=transport.state(id);}
   if(action==='instance/qrCode')return json(res,200,{qrCode:s.qr||null});
   if(!s.qr)throw fail(409,'qr_unavailable','QR ainda não disponível.');res.writeHead(200,{'Content-Type':'image/png'});return res.end(await QRCode.toBuffer(s.qr,{width:280}));
  }
  if(action==='instance/settings'){
   if(method==='GET')return json(res,200,readSettings(row));
   if(method==='POST'){
    keys(input,['token','sendDelay','sendDelayMax','webhook_url','webhook_message_received','webhook_message_create','webhook_message_ack','webhook_message_download_media']);
    const settings=parseSettings(input,row),hook=input.webhook_url===undefined?row.webhook_url:webhookUrl(input.webhook_url);delete settings.webhook_url;
    db.prepare('UPDATE instances SET settings=?,webhook_url=?,updated_at=? WHERE id=?').run(JSON.stringify(settings),hook,new Date().toISOString(),id);return json(res,200,{success:'true',message:'ok'});
   }
  }
  if(action==='instance/clear'&&method==='POST'){keys(input,['token']);await transport.reset(id);return json(res,200,{success:'true',message:'ok'});}
  if(action==='instance/me'&&method==='GET')return json(res,200,await transport.me(id));
  if(['instance/restart','instance/takeover'].includes(action)&&method==='POST'){keys(input,['token']);await transport.restart(id);return json(res,200,{success:'true',message:'ok'});}
  if(action==='instance/logout'&&method==='POST'){keys(input,['token']);await transport.disconnect(id);return json(res,200,{success:'true',message:'ok'});}
  if(action==='messages'&&method==='GET')return await list(res,id,row,url);
  if(action==='messages/statistics'&&method==='GET'){
   const result={sent:0,queue:0,unsent:0,invalid:0,expired:0};for(const s of db.prepare("SELECT status,count(*) AS n FROM messages WHERE instance_id=? AND direction='out' GROUP BY status").all(id))if(Object.hasOwn(result,s.status))result[s.status]=s.n;
   return json(res,200,result);
  }
  if(action==='messages/clear'&&method==='POST'){
   keys(input,['token','status']);if(!['queue','sent','unsent','invalid','expired','all'].includes(input.status))throw fail(400,'invalid_status','Status inválido.');
   const selected=db.prepare("SELECT id,media_id FROM messages WHERE instance_id=? AND direction='out' AND status<>'sending' AND (?='all' OR status=?)").all(id,input.status,input.status);
   db.exec('BEGIN');try{for(const m of selected)db.prepare('DELETE FROM messages WHERE id=?').run(m.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   for(const m of selected)if(m.media_id)relay.remove(m.media_id);return json(res,200,{success:'true',message:'ok'});
  }
  if(['messages/resendById','messages/resendByStatus'].includes(action)&&method==='POST'){
   keys(input,['token',action.endsWith('ById')?'id':'status']);
   if(action.endsWith('ById'))text(String(input.id??''),'id',128);
   let selected;if(action.endsWith('ById'))selected=db.prepare("SELECT m.* FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE m.instance_id=? AND m.direction='out' AND (a.api_id=? OR m.id=?)").all(id,input.id,input.id);
   else{if(!['unsent','expired'].includes(input.status))throw fail(400,'invalid_status','Use unsent ou expired.');selected=db.prepare("SELECT * FROM messages WHERE instance_id=? AND direction='out' AND status=?").all(id,input.status);}
   if(!selected.length)throw fail(404,'not_found','Mensagem não encontrada.');
   if(selected.some(m=>['sending','queue'].includes(m.status)))throw fail(409,'already_pending','Mensagem já em processamento.');
   if(selected.some(m=>mediaKinds.includes(m.type)||m.type==='ptt'))for(const m of selected)if((mediaKinds.includes(m.type)||m.type==='ptt')&&!relay.get(id,m.media_id)&&!m.source_url)throw fail(409,'media_expired','Arquivo temporário expirou; o cliente precisa reenviar a mídia.');
   const pending=db.prepare("SELECT count(*) AS n FROM messages WHERE instance_id=? AND status IN ('queue','sending')").get(id).n;if(pending+selected.length>1000)throw fail(429,'queue_full','Fila cheia.');
   db.exec('BEGIN');try{for(const m of selected)db.prepare("UPDATE messages SET status='queue',ack='pending',provider_id=NULL,error=NULL,sent_at=NULL,queued_at=? WHERE id=?").run(Math.floor(Date.now()/1000),m.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   transport.flush(id);return json(res,200,{success:'true',message:'ok'});
  }
  if(action==='media/upload'&&method==='POST'){
   keys(input,['token','file','filename','_file']);const media=await mediaInput({...input,document:input.file,filename:input.filename||'file'},'document');const key=relay.put(id,media.bytes,media.mimetype,media.filename);return json(res,200,{url:relay.url(baseUrl,id,key)});
  }
  if(mediaKinds.some(k=>action==='messages/'+k)&&method==='POST'){
   const kind=action.split('/')[1],field=kind==='voice'?'audio':kind;keys(input,['token','to',field,'base64','caption','ptt','_file','filename','priority','referenceId','nocache']);recipient(input.to);priority(input.priority);
   const caption=input.caption===undefined?'':text(input.caption,'caption',1024,false);
   // A URL returned by media/upload points at this same process; resolve it without a network fetch.
   let prepared=input;
   if(typeof input[field]==='string'&&input[field].startsWith(baseUrl+'/instance'+id+'/media/')){const u=new URL(input[field]);const entry=relay.get(id,u.pathname.split('/').pop());if(entry)prepared={...input,_file:entry.bytes};}
   const media=await mediaInput(prepared,kind);return json(res,200,queue(id,input,{kind:media.ptt?'voice':kind,content:caption,media}));
  }
  if(['messages/chat','messages/link','messages/contact','messages/location','messages/vcard'].includes(action)&&method==='POST'){
   const kind=action.split('/')[1];let content='',payload={};
   const fields={chat:['body'],link:['link'],contact:['contact'],location:['address','lat','lng'],vcard:['vcard']}[kind];keys(input,['token','to','priority','referenceId',...fields]);
   if(kind==='chat')content=text(input.body,'body',4096);
   if(kind==='link'){content=text(input.link,'link',4096);let u;try{u=new URL(content);}catch{throw fail(400,'invalid_link','Link inválido.');}if(!['http:','https:'].includes(u.protocol))throw fail(400,'invalid_link','Link inválido.');}
   if(kind==='vcard'){content=text(input.vcard,'vcard',4096);if(!content.includes('BEGIN:VCARD')||!content.includes('END:VCARD'))throw fail(400,'invalid_vcard','vCard inválido.');payload={vcard:content};}
   if(kind==='contact'){
    const value=Array.isArray(input.contact)?input.contact.join(','):input.contact;content=text(value,'contact',300);const ids=content.split(',').map(v=>recipient(v.trim()));if(ids.length>15)throw fail(400,'invalid_contact','Limite de 15 contatos.');
    payload={contacts:ids.map(v=>{const phone=publicJid(v).split('@')[0];if(!/^\d+$/.test(phone))throw fail(400,'invalid_contact','Contato inválido.');return {displayName:phone,vcard:`BEGIN:VCARD\nVERSION:3.0\nFN:${phone}\nTEL;type=CELL;waid=${phone}:${phone}\nEND:VCARD`};})};
   }
   if(kind==='location'){content=text(input.address,'address',300);const lat=Number(input.lat),lng=Number(input.lng);if(input.lat==null||input.lng==null||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)throw fail(400,'invalid_location','Coordenadas inválidas.');payload={lat,lng,address:content};}
   return json(res,200,queue(id,input,{kind,content,payload}));
  }
  if(action==='messages/delete'&&method==='POST'){keys(input,['token','msgId']);await transport.deleteMessage(id,text(input.msgId,'msgId',300));return json(res,200,{success:'true',message:'ok'});}
  if(action==='messages/reaction'&&method==='POST'){keys(input,['token','msgId','emoji']);await transport.react(id,text(input.msgId,'msgId',300),text(input.emoji??'','emoji',32,false));return json(res,200,{success:'true',message:'ok'});}
  if(action.startsWith('contacts')||action.startsWith('chats')||action.startsWith('groups')){
   const params=method==='GET'?Object.fromEntries(url.searchParams):input;return json(res,200,await transport.operation(id,action,method,params));
  }
  throw fail(405,'method_not_allowed','Método não permitido.');
 };
}
