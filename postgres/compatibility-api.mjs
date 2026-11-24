const routineMessageActions=new Set(['media/upload',...['chat','link','contact','location','vcard','image','audio','voice','video','document','sticker'].map(k=>'messages/'+k)]);
import {randomBytes} from 'node:crypto';
import QRCode from 'qrcode';
import {equal} from '../auth.mjs';
import {mediaInput,multipart} from '../media-input.mjs';
import {MAX_MEDIA_BYTES} from '../media-relay.mjs';
import {readSettings,parseSettings,publicJid} from '../instance-settings.mjs';
import {fail,text,keys,webhookUrl} from './validation.mjs';
import {body,json} from './http.mjs';

const mediaKinds=['image','audio','voice','video','document','sticker'];
const states=['all','queue','sent','unsent','invalid','expired','sending','unknown','received'];
const ok=data=>({status:200,data});
const success=()=>ok({success:'true',message:'ok'});
const priority=value=>{const n=Number(value??10);if(!Number.isInteger(n)||n<0||n>10)throw fail(400,'invalid_priority','priority deve estar entre 0 e 10.');return n;};
const recipient=value=>{const v=text(value,'to',80);if(!/^\+?\d{6,20}$/.test(v)&&!/^\d[0-9-]*@(c\.us|g\.us|s\.whatsapp\.net|lid)$/.test(v))throw fail(400,'invalid_recipient','Destinatário inválido.');return v;};
const supported=new Set(['instance/clear','instance/status','instance/qr','instance/qrCode','instance/settings','instance/me','instance/restart','instance/logout','instance/takeover','messages','messages/statistics','messages/delete','messages/clear','messages/resendById','messages/resendByStatus','media/upload',...mediaKinds.map(k=>'messages/'+k),...['chat','link','contact','location','vcard','reaction'].map(k=>'messages/'+k),'groups','groups/ids','groups/group','contacts/ids','contacts/image','contacts/invalid','chats/ids','contacts','contacts/contact','contacts/check','contacts/blocked','contacts/block','contacts/unblock','chats','chats/messages','chats/read','chats/archive','chats/unarchive','chats/delete','chats/clearMessages']);

export function createPostgresCompatibilityApi({store,transport,relay,baseUrl,legacy=()=>null,activity,now=Date.now,mediaLoader=mediaInput}={}){
  const {db,encrypt,decrypt}=store;
  const kick=id=>{void Promise.resolve().then(()=>transport.flush(id)).catch(()=>console.error('[queue] Falha ao processar fila.'));};
  async function authenticate(tx,id,token,lock=false){
    const row=await tx.get('SELECT i.* FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1 AND u.active=1'+(lock?' FOR SHARE OF i,u':''),[id]);
    if(!row||typeof token!=='string'||!equal(token,decrypt(row.token)))throw fail(401,'invalid_token','Token ou instância inválidos.');
    if(!row.active)throw fail(409,'instance_disabled','Instância desativada. Reative no painel antes de usar a API.');return row;
  }
  async function list(id,row,p){
    const status=p.get('status')||'all',page=Number(p.get('page')||1),limit=Number(p.get('limit')||100),sort=p.get('sort')||'asc';
    if(!states.includes(status))throw fail(400,'invalid_status','Status inválido.');
    if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(sort)||!Number.isSafeInteger((page-1)*limit))throw fail(400,'invalid_pagination','Paginação inválida.');
    const args=[id],conditions=['m.instance_id=$1',"m.direction='out'"],bind=v=>{args.push(v);return '$'+args.length;};
    if(status!=='all')conditions.push('m.status='+bind(status));
    for(const [name,column] of [['referenceId','m.reference_id'],['ack','m.ack']])if(p.get(name))conditions.push(column+'='+bind(p.get(name)));
    if(p.get('id')){const key=bind(p.get('id'));conditions.push(`(a.api_id::text=${key} OR m.id=${key})`);}
    if(p.get('from')&&publicJid(p.get('from'))!==publicJid(row.phone))conditions.push('FALSE');
    if(p.get('to'))conditions.push("REPLACE(CASE WHEN strpos(m.recipient,'@')=0 THEN ltrim(m.recipient,'+')||'@c.us' ELSE m.recipient END,'@s.whatsapp.net','@c.us')="+bind(publicJid(p.get('to'))));
    const where=conditions.join(' AND ');
    return db.transaction(async tx=>{
      const total=(await tx.get(`SELECT count(*) AS n FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE ${where}`,args)).n;
      const rows=await tx.all(`SELECT m.*,a.api_id FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE ${where} ORDER BY a.api_id ${sort==='asc'?'ASC':'DESC'} LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,limit,(page-1)*limit]);
      return ok({total,pages:Math.ceil(total/limit),limit,page,messages:rows.map(m=>({id:m.api_id,referenceId:m.reference_id||null,from:publicJid(row.phone),to:publicJid(m.recipient),body:m.body,priority:m.priority,status:m.status,ack:m.ack,type:m.type,created_at:Math.floor(Date.parse(m.created_at)/1000),sent_at:m.sent_at||0,metadata:{}}))});
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  return async function handle(req,res,id,action,url){
    const method=req.method;if(!['GET','POST'].includes(method))throw fail(405,'method_not_allowed','Método não permitido.');
    const mediaSend=mediaKinds.some(k=>action==='messages/'+k)||action==='media/upload';
    const input=method==='POST'?(mediaSend&&(req.headers['content-type']||'').startsWith('multipart/form-data')?await multipart(req):await body(req,mediaSend?Math.ceil(MAX_MEDIA_BYTES*4/3)+32768:65536)):{};
    const bearer=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):null,token=bearer||input.token||url.searchParams.get('token');
    const row=await authenticate(db,id,token);let auditContext,auditDone=false;
    const startsConnection=method==='GET'&&['instance/qr','instance/qrCode'].includes(action)&&transport.state(id).status==='disconnected';
    if(activity&&(startsConnection||(method==='POST'&&!routineMessageActions.has(action))))auditContext=await activity.begin({instance:row,actor:activity.apiActor(id),action:'api.'+action.replaceAll('/','.'),source:'api',before:action==='instance/settings'?activity.snapshot(row):{},details:{method},peer_ip:req.socket.remoteAddress||''});
    const finish=async(error,current=row)=>{if(auditContext)await activity.finish(auditContext,{after:!error&&action==='instance/settings'?activity.snapshot(current):{},...(error?{error,status:error.status||500}:{})});};
    // Credentials/quota are checked again after any awaited media processing, inside the mutation.
    async function mutation(operation){
      const result=await db.transaction(async tx=>{
        const current=await authenticate(tx,id,token,true);await tx.get('SELECT pg_advisory_xact_lock(97313,hashtext($1))',[id]);
        const output=await operation(tx,current);await finish(null,action==='instance/settings'?await tx.get('SELECT * FROM instances WHERE id=$1',[id]):current);return output;
      });auditDone=true;return result;
    }
    async function enqueue({kind,content='',media,payload={}}){
      const to=recipient(input.to),reference=text(input.referenceId??'','referenceId',255,false),rank=priority(input.priority);let key;
      try{
        const result=await mutation(async tx=>{
          if((await tx.get("SELECT count(*) AS n FROM messages WHERE instance_id=$1 AND status IN ('queue','sending')",[id])).n>=1000)throw fail(429,'queue_full','Fila cheia.');
          key=media?relay.put(id,media.bytes,media.mimetype,media.filename||'file'):null;
          const field=kind==='voice'?'audio':kind,source=typeof input[field]==='string'&&/^https?:\/\//i.test(input[field])?encrypt(input[field]):'',messageId=randomBytes(12).toString('hex');
          await tx.run('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,media_id,reference_id,priority,filename,payload,source_url) VALUES($1,$2,$3,$4,$5,\'queue\',\'pending\',$6,$7,$8,$9,$10,$11,$12)',[messageId,id,to,content,kind==='voice'?'ptt':kind,new Date(now()).toISOString(),key,reference,rank,media?.filename||'',JSON.stringify(payload),source]);
          return ok({sent:'true',message:'ok',id:(await tx.get('SELECT api_id FROM api_messages WHERE message_id=$1',[messageId])).api_id});
        });kick(id);return result;
      }catch(error){if(key)relay.remove(key);throw error;}
    }
    async function dispatch(){
      if(action.startsWith('media/')&&method==='GET'){
        const fileId=action.slice(6),object=await db.get('SELECT object_key FROM media_objects WHERE instance_id=$1 AND message_id=$2',[id,fileId]);
        if(object&&legacy())return {status:302,headers:{Location:await legacy().url(object.object_key)},bytes:Buffer.alloc(0)};
        const file=await db.get('SELECT mimetype,data FROM media WHERE instance_id=$1 AND message_id=$2',[id,fileId]);if(!file)throw fail(404,'media_expired','Mídia indisponível.');return {status:200,headers:{'Content-Type':file.mimetype,'Content-Length':file.data.length},bytes:file.data};
      }
      if(!supported.has(action))throw fail(501,'not_implemented','Operação ainda não implementada nesta API.');
      await db.run("UPDATE messages SET status='expired',error='Mensagem expirou após 24 horas na fila.' WHERE instance_id=$1 AND status='queue' AND COALESCE(queued_at,FLOOR(EXTRACT(EPOCH FROM created_at::timestamptz))::bigint)<$2",[id,Math.floor(now()/1000)-86400]);
      if(action==='instance/status'&&method==='GET'){const s=transport.state(id);return ok({status:{accountStatus:s.status==='qr'?'qr':s.status}});}
      if(['instance/qr','instance/qrCode'].includes(action)&&method==='GET'){
        let s=transport.state(id);if(s.status==='disconnected'){await authenticate(db,id,token);await transport.connect(id,0,auditContext);s=transport.state(id);}
        if(action==='instance/qrCode')return ok({qrCode:s.qr||null});if(!s.qr)throw fail(409,'qr_unavailable','QR ainda não disponível.');return {status:200,headers:{'Content-Type':'image/png'},bytes:await QRCode.toBuffer(s.qr,{width:280})};
      }
      if(action==='instance/settings'){
        if(method==='GET')return ok(readSettings(row));
        if(method==='POST'){
          keys(input,['token','sendDelay','sendDelayMax','webhook_url','webhook_message_received','webhook_message_create','webhook_message_ack','webhook_message_download_media']);
          return mutation(async(tx,current)=>{const settings=parseSettings(input,current),hook=input.webhook_url===undefined?current.webhook_url:webhookUrl(input.webhook_url);delete settings.webhook_url;await tx.run('UPDATE instances SET settings=$1,webhook_url=$2,updated_at=$3 WHERE id=$4',[JSON.stringify(settings),hook,new Date(now()).toISOString(),id]);return success();});
        }
      }
      if(action==='instance/clear'&&method==='POST'){keys(input,['token']);await transport.reset(id,auditContext);return success();}
      if(action==='instance/me'&&method==='GET')return ok(await transport.me(id));
      if(['instance/restart','instance/takeover'].includes(action)&&method==='POST'){keys(input,['token']);await transport.restart(id,auditContext);return success();}
      if(action==='instance/logout'&&method==='POST'){keys(input,['token']);await transport.disconnect(id,auditContext);return success();}
      if(action==='messages'&&method==='GET')return list(id,row,url.searchParams);
      if(action==='messages/statistics'&&method==='GET'){
        const result={sent:0,queue:0,unsent:0,invalid:0,expired:0};for(const r of await db.all("SELECT status,count(*) AS n FROM messages WHERE instance_id=$1 AND direction='out' GROUP BY status",[id]))if(Object.hasOwn(result,r.status))result[r.status]=r.n;return ok(result);
      }
      if(action==='messages/clear'&&method==='POST'){
        keys(input,['token','status']);if(!['queue','sent','unsent','invalid','expired','all'].includes(input.status))throw fail(400,'invalid_status','Status inválido.');let selected=[];
        const result=await mutation(async tx=>{selected=await tx.all("DELETE FROM messages WHERE instance_id=$1 AND direction='out' AND status<>'sending' AND ($2='all' OR status=$2) RETURNING id,media_id",[id,input.status]);return success();});for(const m of selected)if(m.media_id)relay.remove(m.media_id);return result;
      }
      if(['messages/resendById','messages/resendByStatus'].includes(action)&&method==='POST'){
        const byId=action.endsWith('ById');keys(input,['token',byId?'id':'status']);if(byId)text(String(input.id??''),'id',128);else if(!['unsent','expired'].includes(input.status))throw fail(400,'invalid_status','Use unsent ou expired.');
        const result=await mutation(async tx=>{
          const rows=byId?await tx.all("SELECT m.* FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE m.instance_id=$1 AND m.direction='out' AND (a.api_id::text=$2 OR m.id=$2) ORDER BY m.id FOR UPDATE OF m",[id,String(input.id)]):await tx.all("SELECT * FROM messages WHERE instance_id=$1 AND direction='out' AND status=$2 ORDER BY id FOR UPDATE",[id,input.status]);
          if(!rows.length)throw fail(404,'not_found','Mensagem não encontrada.');if(rows.some(m=>['sending','queue'].includes(m.status)))throw fail(409,'already_pending','Mensagem já em processamento.');
          for(const m of rows)if((mediaKinds.includes(m.type)||m.type==='ptt')&&!relay.get(id,m.media_id)&&!m.source_url)throw fail(409,'media_expired','Arquivo temporário expirou; o cliente precisa reenviar a mídia.');
          const pending=(await tx.get("SELECT count(*) AS n FROM messages WHERE instance_id=$1 AND status IN ('queue','sending')",[id])).n;if(pending+rows.length>1000)throw fail(429,'queue_full','Fila cheia.');
          for(const m of rows)await tx.run("UPDATE messages SET status='queue',ack='pending',provider_id=NULL,error=NULL,sent_at=NULL,queued_at=$1 WHERE id=$2",[Math.floor(now()/1000),m.id]);return success();
        });kick(id);return result;
      }
      if(action==='media/upload'&&method==='POST'){
        keys(input,['token','file','filename','_file']);const media=await mediaLoader({...input,document:input.file,filename:input.filename||'file'},'document');let key;
        try{return await mutation(async()=>{key=relay.put(id,media.bytes,media.mimetype,media.filename);return ok({url:relay.url(baseUrl,id,key)});});}catch(error){if(key)relay.remove(key);throw error;}
      }
      if(mediaKinds.some(k=>action==='messages/'+k)&&method==='POST'){
        const kind=action.split('/')[1],field=kind==='voice'?'audio':kind;keys(input,['token','to',field,'base64','caption','ptt','_file','filename','priority','referenceId','nocache']);recipient(input.to);priority(input.priority);
        const caption=input.caption===undefined?'':text(input.caption,'caption',1024,false);let prepared=input;
        if(typeof input[field]==='string'&&input[field].startsWith(baseUrl+'/instance'+id+'/media/')){const parsed=new URL(input[field]),entry=relay.get(id,parsed.pathname.split('/').pop());if(entry)prepared={...input,_file:entry.bytes};}
        const media=await mediaLoader(prepared,kind);return enqueue({kind:media.ptt?'voice':kind,content:caption,media});
      }
      if(['messages/chat','messages/link','messages/contact','messages/location','messages/vcard'].includes(action)&&method==='POST'){
        const kind=action.split('/')[1];let content='',payload={};const fields={chat:['body'],link:['link'],contact:['contact'],location:['address','lat','lng'],vcard:['vcard']}[kind];keys(input,['token','to','priority','referenceId',...fields]);
        if(kind==='chat')content=text(input.body,'body',4096);
        if(kind==='link'){content=text(input.link,'link',4096);let parsed;try{parsed=new URL(content);}catch{throw fail(400,'invalid_link','Link inválido.');}if(!['http:','https:'].includes(parsed.protocol))throw fail(400,'invalid_link','Link inválido.');}
        if(kind==='vcard'){content=text(input.vcard,'vcard',4096);if(!content.includes('BEGIN:VCARD')||!content.includes('END:VCARD'))throw fail(400,'invalid_vcard','vCard inválido.');payload={vcard:content};}
        if(kind==='contact'){const value=Array.isArray(input.contact)?input.contact.join(','):input.contact;content=text(value,'contact',300);const ids=content.split(',').map(v=>recipient(v.trim()));if(ids.length>15)throw fail(400,'invalid_contact','Limite de 15 contatos.');payload={contacts:ids.map(v=>{const phone=publicJid(v).split('@')[0];if(!/^\d+$/.test(phone))throw fail(400,'invalid_contact','Contato inválido.');return {displayName:phone,vcard:`BEGIN:VCARD\nVERSION:3.0\nFN:${phone}\nTEL;type=CELL;waid=${phone}:${phone}\nEND:VCARD`};})};}
        if(kind==='location'){content=text(input.address,'address',300);const lat=Number(input.lat),lng=Number(input.lng);if(input.lat==null||input.lng==null||!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lng)||Math.abs(lng)>180)throw fail(400,'invalid_location','Coordenadas inválidas.');payload={lat,lng,address:content};}
        return enqueue({kind,content,payload});
      }
      if(action==='messages/delete'&&method==='POST'){keys(input,['token','msgId']);await transport.deleteMessage(id,text(input.msgId,'msgId',300));return success();}
      if(action==='messages/reaction'&&method==='POST'){keys(input,['token','msgId','emoji']);await transport.react(id,text(input.msgId,'msgId',300),text(input.emoji??'','emoji',32,false));return success();}
      if(action.startsWith('contacts')||action.startsWith('chats')||action.startsWith('groups'))return ok(await transport.operation(id,action,method,method==='GET'?Object.fromEntries(url.searchParams):input));
      throw fail(405,'method_not_allowed','Método não permitido.');
    }
    try{
      const response=await dispatch();if(!auditDone){await finish();auditDone=true;}
      if(response.bytes!==undefined){res.writeHead(response.status,{'Cache-Control':'no-store',...response.headers});res.end(response.bytes);}else json(res,response.status,response.data);
    }catch(error){if(!auditDone)try{await finish(error);}catch{console.error('[audit] Falha ao concluir registro da API.');}throw error;}
  };
}
