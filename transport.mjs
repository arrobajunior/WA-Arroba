import makeWASocket, { BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, generateMessageID, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import {readSettings,publicJid,whatsappJid,webhookId} from './instance-settings.mjs';
import {mediaInput} from './media-input.mjs';
import {createMediaRelay} from './media-relay.mjs';
import { randomBytes } from 'node:crypto';

const silentLogger=pino({level:'silent'});

// ── Webhook de recebimento ──────────────────────────────────────────────────
// Entrega com até 3 tentativas (backoff curto) antes de desistir e só então
// registrar a falha no log — perder uma mensagem por uma falha de rede
// isolada era o próprio problema que esta retentativa resolve. Formato
// compatível com o payload do UltraMsg (event_type/data), para funcionar sem
// alterações em sistemas que já recebem webhooks daquele provedor.
const WEBHOOK_TIMEOUT_MS=8000;
const WEBHOOK_MAX_ATTEMPTS=3;
const WEBHOOK_RETRY_DELAY_MS=1500;
async function deliverWebhook(url,payload,attempt=1) {
  if(!url)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),WEBHOOK_TIMEOUT_MS);
  try {
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
  } catch(e) {
    if(attempt<WEBHOOK_MAX_ATTEMPTS)setTimeout(()=>deliverWebhook(url,payload,attempt+1),WEBHOOK_RETRY_DELAY_MS);
    else console.error(`[webhook] falha ao entregar para ${url} após ${attempt} tentativas: ${e.message}`);
  } finally { clearTimeout(timer); }
}
// Extrai tipo, corpo e (quando houver) mimetype de uma mensagem Baileys.
// Retorna null para tipos sem conteúdo de usuário (reações, recibos, mensagens
// de protocolo etc.).
function describeMessage(msg) {
  const raw=msg.message||{};
  let core=raw;for(let depth=0;depth<5;depth++){const inner=core.ephemeralMessage?.message||core.viewOnceMessage?.message||core.viewOnceMessageV2?.message||core.documentWithCaptionMessage?.message;if(!inner)break;core=inner;}
  if(core.conversation!=null)return {type:'chat',body:core.conversation};
  if(core.extendedTextMessage)return {type:'chat',body:core.extendedTextMessage.text||''};
  if(core.imageMessage)return {type:'image',body:core.imageMessage.caption||'',mimetype:core.imageMessage.mimetype||'image/jpeg'};
  if(core.videoMessage)return {type:'video',body:core.videoMessage.caption||'',mimetype:core.videoMessage.mimetype||'video/mp4'};
  if(core.audioMessage)return {type:core.audioMessage.ptt?'ptt':'audio',body:'',mimetype:core.audioMessage.mimetype||'audio/ogg'};
  if(core.documentMessage)return {type:'document',body:core.documentMessage.caption||core.documentMessage.fileName||'',mimetype:core.documentMessage.mimetype||'application/octet-stream',filename:core.documentMessage.fileName||'file'};
  if(core.stickerMessage)return {type:'sticker',body:'',mimetype:core.stickerMessage.mimetype||'image/webp'};
  return null;
}
/* Mídia baixada é guardada só até ser rehospedada por quem recebe o webhook
// (o MF Rural, por exemplo, já faz isso automaticamente). 24h é folga suficiente
// e evita que o banco cresça sem limite.
const MEDIA_TTL_MS=24*60*60*1000;
const MAX_MEDIA_BYTES=20*1024*1024; */

export function createTransport(store, { socketFactory=makeWASocket, retryDelay=2000, mediaBaseUrl, mediaDownloader=downloadMediaMessage, mediaRelay=createMediaRelay(), legacyStorage=()=>null, mediaLoader=mediaInput }={}) {
  const {db,encrypt,decrypt}=store, entries=new Map(), work=new Map();
  let closed=false;
  const settingsFor=id=>readSettings(db.prepare('SELECT settings,webhook_url FROM instances WHERE id=?').get(id)||{});
  const webhookFor=(id,event)=>{const s=settingsFor(id);return (!event||s['webhook_'+event])?s.webhook_url:'';};
  const remember=(map,key,value,max=2000)=>{map.delete(key);map.set(key,value);while(map.size>max)map.delete(map.keys().next().value);};
  async function downloadAndStoreMedia(id,msg,mimetype,socket,filename) {
    const stream=await mediaDownloader(msg,'stream',{},{logger:silentLogger,reuploadRequest:socket.updateMediaMessage});
    let buffer;if(Buffer.isBuffer(stream))buffer=stream;else{const chunks=[];let size=0;for await(const chunk of stream){size+=chunk.length;if(size>32*1024*1024){stream.destroy?.();throw new Error('Mídia excede 32 MB.');}chunks.push(chunk);}buffer=Buffer.concat(chunks);}
    if(buffer.length>32*1024*1024)return null;
    return mediaRelay.put(id,buffer,mimetype,filename||'file');
  }
  const state=id=>{const e=entries.get(id);return {status:e?.status||'disconnected',qr:e?.qr||null,error:e?.error||null};};
  function auth(id,valid) {
    const read=(kind,key)=>{const r=db.prepare('SELECT value FROM wa_keys WHERE instance_id=? AND kind=? AND key_id=?').get(id,kind,key);return r?JSON.parse(decrypt(r.value),BufferJSON.reviver):null;};
    const write=(kind,key,value)=>{if(!valid())return;if(value==null)db.prepare('DELETE FROM wa_keys WHERE instance_id=? AND kind=? AND key_id=?').run(id,kind,key);else db.prepare('INSERT OR REPLACE INTO wa_keys VALUES(?,?,?,?)').run(id,kind,key,encrypt(JSON.stringify(value,BufferJSON.replacer)));};
    const creds=read('creds','main')||initAuthCreds();
    return {state:{creds,keys:{
      get:async(type,ids)=>!valid()?{}:Object.fromEntries(ids.map(key=>{let value=read(type,key);if(type==='app-state-sync-key'&&value)value=proto.Message.AppStateSyncKeyData.fromObject(value);return [key,value];})),
      set:async(data)=>{if(!valid())return;db.exec('BEGIN');try{for(const [type,values] of Object.entries(data))for(const [key,value] of Object.entries(values))write(type,key,value);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
    }},save:()=>write('creds','main',creds)};
  }
  function connect(id,attempt=0) {
    if(closed)throw new Error('Aplicação em encerramento.');
    const previous=entries.get(id);
    if(previous&&['initialize','qr','authenticated','retrying','disconnecting'].includes(previous.status)&&!attempt)return state(id);
    if(previous){clearTimeout(previous.timer);previous.socket?.end(new Error('Substituição controlada da conexão.'));}
    const e={status:'initialize',qr:null,error:null,socket:null,timer:null,contacts:new Map(),chats:new Map(),messages:new Map(),webhooked:new Map(),invalidContacts:new Map()};entries.set(id,e);
    const valid=()=>!closed&&entries.get(id)===e;
    const credentials=auth(id,valid);
    e.credentials=credentials.state;
    db.prepare('UPDATE instances SET auto_connect=1 WHERE id=?').run(id);
    try {
      e.socket=socketFactory({auth:credentials.state,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,connectTimeoutMs:30000,defaultQueryTimeoutMs:30000});
      const cacheMessages=messages=>{for(const msg of messages||[]){const jid=msg.key?.remoteJid;if(!jid||!msg.key?.id)continue;const desc=describeMessage(msg);if(desc)remember(e.messages,msg.key.id,{key:msg.key,messageTimestamp:Number(msg.messageTimestamp)||Math.floor(Date.now()/1000),description:desc});}};
      e.socket.ev.on('contacts.upsert',contacts=>{if(valid())for(const c of contacts)remember(e.contacts,c.id,c);});
      e.socket.ev.on('contacts.update',contacts=>{if(valid())for(const c of contacts)remember(e.contacts,c.id,{...e.contacts.get(c.id),...c});});
      e.socket.ev.on('chats.upsert',chats=>{if(valid())for(const c of chats)remember(e.chats,c.id,c);});
      e.socket.ev.on('chats.update',chats=>{if(valid())for(const c of chats)remember(e.chats,c.id,{...e.chats.get(c.id),...c});});
      e.socket.ev.on('chats.delete',ids=>{if(valid())for(const jid of ids)e.chats.delete(jid);});
      e.socket.ev.on('messaging-history.set',snapshot=>{if(!valid())return;for(const c of snapshot.contacts||[])remember(e.contacts,c.id,c);for(const c of snapshot.chats||[])remember(e.chats,c.id,c);cacheMessages(snapshot.messages);});
      e.socket.ev.on('creds.update',()=>{if(valid())credentials.save();});
      e.socket.ev.on('connection.update',update=>{
        if(!valid())return;
        if(update.qr){e.qr=update.qr;e.status='qr';}
        if(update.connection==='open'){
          e.status='authenticated';e.qr=null;e.error=null;attempt=0;
          const phone=(e.socket.user?.id||'').split(':')[0].split('@')[0];
          db.prepare('UPDATE instances SET phone=?,updated_at=? WHERE id=?').run(phone,new Date().toISOString(),id);
          flush(id);
        }
        if(update.connection==='close') {
          e.qr=null;
          if(e.status==='disconnecting')return;
          const reason=update.lastDisconnect?.error?.output?.statusCode;
          if(reason===DisconnectReason.loggedOut){db.prepare('DELETE FROM wa_keys WHERE instance_id=?').run(id);db.prepare('UPDATE instances SET auto_connect=0 WHERE id=?').run(id);e.status='disconnected';e.error='Sessão encerrada no WhatsApp. Gere um novo QR Code.';return;}
          if(reason===DisconnectReason.connectionReplaced||attempt>=5){e.status='disconnected';e.error=reason===DisconnectReason.connectionReplaced?'Conexão substituída por outra sessão.':'Não foi possível reconectar. Tente conectar novamente.';db.prepare('UPDATE instances SET auto_connect=0 WHERE id=?').run(id);return;}
          e.status='retrying';
          e.timer=setTimeout(()=>{if(valid()){e.status='disconnected';connect(id,attempt+1);}},reason===DisconnectReason.restartRequired?500:Math.min(retryDelay*2**attempt,30000));e.timer.unref();
        }
      });
      e.socket.ev.on('messages.update',updates=>{
        if(!valid())return;
        const labels={0:'error',1:'pending',2:'server',3:'device',4:'read',5:'played'};
        for(const {key,update} of updates){
          if(update.status==null)continue;
          const ack=labels[update.status];if(!ack)continue;
          const old=db.prepare('SELECT ack FROM messages WHERE instance_id=? AND provider_id=?').get(id,key.id)?.ack;const oldLevel=Object.keys(labels).find(level=>labels[level]===old);if(update.status>0&&oldLevel!==undefined&&Number(oldLevel)>update.status)continue;
          db.prepare("UPDATE messages SET ack=?,status=CASE WHEN ?=0 THEN 'unsent' WHEN ?>=2 THEN 'sent' ELSE status END,sent_at=CASE WHEN ?>=2 THEN COALESCE(sent_at,?) ELSE sent_at END WHERE instance_id=? AND provider_id=?").run(ack,update.status,update.status,update.status,Math.floor(Date.now()/1000),id,key.id);
          const row=db.prepare('SELECT recipient,reference_id FROM messages WHERE instance_id=? AND provider_id=?').get(id,key.id);const url=webhookFor(id,'message_ack');if(url)deliverWebhook(url,{event_type:'message_ack',instanceId:id,data:{id:webhookId(key.remoteJid||whatsappJid(row?.recipient||''),key.id,key.fromMe??true),ack,...(row?.reference_id?{referenceId:row.reference_id}:{})}});
        }
      });
      // ── Mensagens recebidas (e enviadas fora da API) ──────────────────────
      async function handleIncoming(msg) {
        if(!valid())return;
        const jid=msg.key?.remoteJid||'';
        if(!jid||jid==='status@broadcast'||jid.endsWith('@newsletter'))return;
        const desc=describeMessage(msg);if(!desc)return;
        if(e.webhooked.has(msg.key.id))return;remember(e.webhooked,msg.key.id,true);
        const fromMe=!!msg.key.fromMe;
        const ts=Number(msg.messageTimestamp)||Math.floor(Date.now()/1000);
        const self=(e.socket.user?.id||'').split(':')[0].split('@')[0];
        // Evita duplicar no histórico mensagens já registradas pelo envio via API (mesmo provider_id)
        if(!db.prepare('SELECT 1 FROM messages WHERE instance_id=? AND provider_id=?').get(id,msg.key.id)){
          db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,provider_id,direction) VALUES(?,?,?,?,?,?,?,?,?,?)')
            .run(randomBytes(12).toString('hex'),id,jid,desc.body,desc.type,fromMe?'sent':'received','device',new Date(ts*1000).toISOString(),msg.key.id,fromMe?'out':'in');
        }
        let media=null;
        if(desc.mimetype&&mediaBaseUrl&&settingsFor(id).webhook_message_download_media) {
          try {
            const stored=await downloadAndStoreMedia(id,msg,desc.mimetype,e.socket,desc.filename);
            if(stored&&valid()){media=mediaRelay.url(mediaBaseUrl,id,stored);db.prepare('UPDATE messages SET media_id=? WHERE instance_id=? AND provider_id=?').run(stored,id,msg.key.id);}
          } catch(err) { console.error(`[media] falha ao baixar mídia ${msg.key.id}: ${err.message}`); }
        }
        if(!valid())return;
        const tracked=db.prepare('SELECT m.reference_id,a.api_id FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE m.instance_id=? AND m.provider_id=?').get(id,msg.key.id);const referenceId=tracked?.reference_id||'';
        const url=webhookFor(id,fromMe?'message_create':'message_received');
        const context=Object.values(msg.message||{}).find(v=>v?.contextInfo)?.contextInfo||{};
        if(url)deliverWebhook(url,{event_type:fromMe?'message_create':'message_received',instanceId:id,id:fromMe?(tracked?.api_id||''):'',referenceId,data:{id:webhookId(jid,msg.key.id,fromMe),from:publicJid(fromMe?self:jid),to:publicJid(fromMe?jid:self),author:publicJid(msg.key.participant||''),fromMe,body:desc.body,type:desc.type,ack:'',time:ts,pushname:msg.pushName||'',media:media||'',isForwarded:Boolean(context.isForwarded),isMentioned:(context.mentionedJid||[]).some(j=>publicJid(j)===publicJid(e.socket.user?.id||'')),quotedMsg:context.stanzaId?{id:context.stanzaId,body:context.quotedMessage?.conversation||context.quotedMessage?.extendedTextMessage?.text||''}:{},mentionedIds:(context.mentionedJid||[]).map(publicJid)}});
      }
      e.socket.ev.on('messages.upsert',({messages,type})=>{
        if(!valid()||type!=='notify')return; // ignora replay de histórico em reconexões
        cacheMessages(messages);for(const msg of messages)handleIncoming(msg).catch(err=>console.error(`[webhook] erro ao processar mensagem: ${err.message}`));
      });
    }catch(error){e.status='disconnected';e.error='Falha ao iniciar conexão WhatsApp.';db.prepare('UPDATE instances SET auto_connect=0 WHERE id=?').run(id);throw error;}
    return state(id);
  }
  function flush(id) {
    if(closed||work.has(id))return;
    const run=(async()=>{
      while(!closed){
        const e=entries.get(id);if(e?.status!=='authenticated')return;
        if(db.prepare('SELECT users.active FROM users JOIN instances ON instances.owner_id=users.id WHERE instances.id=?').get(id)?.active!==1)return;
        db.prepare("UPDATE messages SET status='expired',error='Mensagem expirou após 24 horas na fila.' WHERE instance_id=? AND status='queue' AND COALESCE(queued_at,CAST(strftime('%s',created_at) AS INTEGER))<?").run(id,Math.floor(Date.now()/1000)-86400);
        const row=db.prepare("SELECT * FROM messages WHERE instance_id=? AND status='queue' ORDER BY priority,created_at,id LIMIT 1").get(id);if(!row)return;
        const providerId=generateMessageID();
        db.prepare("UPDATE messages SET status='sending',provider_id=? WHERE id=? AND status='queue'").run(providerId,row.id);
        const jid=row.recipient.includes('@')?row.recipient.replace('@c.us','@s.whatsapp.net'):`${row.recipient.replace(/^\+/,'')}@s.whatsapp.net`;
        try {
          let content={text:row.body};
          const payload=JSON.parse(row.payload||'{}');
          if(['image','audio','ptt','video','document','sticker'].includes(row.type)){
            const entry=mediaRelay.get(id,row.media_id);
            let bytes=entry?.bytes,mimetype=entry?.mimetype;
            if(!bytes&&row.source_url)try{const kind=row.type==='ptt'?'voice':row.type,field=kind==='voice'?'audio':kind;const media=await mediaLoader({[field]:decrypt(row.source_url),filename:row.filename},kind);bytes=media.bytes;mimetype=media.mimetype;}catch{/* classify below, before send */}
            if(!bytes){
              const object=db.prepare('SELECT * FROM media_objects WHERE instance_id=? AND message_id=?').get(id,row.media_id);
              if(object&&legacyStorage())try{bytes=await legacyStorage().get(object.object_key);mimetype=object.mimetype;}catch{/* explicit unsent below */}
            }
            if(!bytes){db.prepare("UPDATE messages SET status='unsent',error='Mídia temporária indisponível; reenvie pelo sistema cliente.' WHERE id=?").run(row.id);continue;}
            if(row.type==='image')content={image:bytes,caption:row.body,mimetype};
            else if(row.type==='video')content={video:bytes,caption:row.body,mimetype};
            else if(row.type==='document')content={document:bytes,caption:row.body,mimetype,fileName:row.filename||'file'};
            else if(row.type==='sticker')content={sticker:bytes};
            else content={audio:bytes,mimetype,ptt:row.type==='ptt'};
          }
          else if(row.type==='link')content={text:row.body,linkPreview:null};
          else if(row.type==='location')content={location:{degreesLatitude:payload.lat,degreesLongitude:payload.lng,address:payload.address}};
          else if(row.type==='vcard')content={contacts:{displayName:'Contato',contacts:[{vcard:payload.vcard}]}};
          else if(row.type==='contact')content={contacts:{displayName:'Contatos',contacts:payload.contacts}};
          await e.socket.sendMessage(jid,content,{messageId:providerId});
          // A successful send call alone is not delivery confirmation. Preserve any ACK received during the call.
          if(!closed)db.prepare("UPDATE messages SET status='sent',sent_at=COALESCE(sent_at,?) WHERE id=? AND status='sending'").run(Math.floor(Date.now()/1000),row.id);
          if(!closed&&!e.webhooked.has(providerId)){
            remember(e.webhooked,providerId,true);const hook=webhookFor(id,'message_create');
            if(hook){const apiId=db.prepare('SELECT api_id FROM api_messages WHERE message_id=?').get(row.id)?.api_id||'',self=publicJid(e.socket.user?.id||'');const entry=row.media_id?mediaRelay.get(id,row.media_id):null;
              deliverWebhook(hook,{event_type:'message_create',instanceId:id,id:apiId,referenceId:row.reference_id||'',data:{id:webhookId(jid,providerId,true),from:self,to:publicJid(jid),author:'',pushname:e.socket.user?.name||'',ack:'pending',type:row.type,body:row.body,media:entry&&mediaBaseUrl?mediaRelay.url(mediaBaseUrl,id,row.media_id):'',fromMe:true,isForwarded:false,isMentioned:false,quotedMsg:{},mentionedIds:[],time:Math.floor(Date.now()/1000)}});
            }
          }
          // Keep only in-memory bytes until their TTL so webhook consumers can download them.

        }catch{
          if(!closed)db.prepare("UPDATE messages SET status='unknown',error='Envio sem confirmação; verifique o destinatário antes de reenviar.' WHERE id=? AND status='sending'").run(row.id);
        }
        if(closed)return;
        await new Promise(resolve=>{const settings=settingsFor(id),pending=db.prepare("SELECT count(*) AS n FROM messages WHERE instance_id=? AND status='queue'").get(id).n;const timer=setTimeout(resolve,(pending>=10?settings.sendDelayMax:settings.sendDelay)*1000);e.wake=()=>{clearTimeout(timer);resolve();};});
      }
    })();
    work.set(id,run);run.catch(()=>{const e=entries.get(id);if(e)e.error='Falha ao processar fila.';}).finally(()=>work.delete(id));
  }
  const required=id=>{const e=entries.get(id);if(e?.status!=='authenticated')throw Object.assign(new Error('WhatsApp não está conectado.'),{status:409,code:'not_authenticated'});return e;};
  const checkedJid=value=>{if(typeof value!=='string'||!/^\+?\d[0-9-]*(?:@(c\.us|g\.us|s\.whatsapp\.net|lid))?$/.test(value))throw Object.assign(new Error('chatId inválido.'),{status:400,code:'invalid_chat'});return whatsappJid(value);};
  async function me(id){const e=required(id),user=e.socket.user||{},jid=publicJid(user.id||'');let image='';try{image=await e.socket.profilePictureUrl(whatsappJid(jid),'image');}catch{}return {id:jid,name:user.name||user.verifiedName||'',number:jid.split('@')[0],image};}
  async function restart(id){const e=entries.get(id);if(e){entries.delete(id);clearTimeout(e.timer);e.wake?.();e.socket?.end(new Error('Reinício solicitado.'));}await work.get(id);return connect(id);}
  function messageKey(e,msgId){
    const found=e.messages.get(msgId)||[...e.messages.values()].find(m=>webhookId(m.key.remoteJid,m.key.id,m.key.fromMe)===msgId);
    let key=found?.key;
    if(!key){const match=msgId.match(/^(true|false)_([^_]+)_(.+)$/);if(match)key={remoteJid:checkedJid(match[2]),id:match[3],fromMe:match[1]==='true'};}
    if(!key)throw Object.assign(new Error('msgId inválido ou indisponível.'),{status:400,code:'invalid_message_id'});
    return key;
  }
  async function react(id,msgId,emoji){const e=required(id),key=messageKey(e,msgId);await e.socket.sendMessage(key.remoteJid,{react:{text:emoji,key}});}
  async function deleteMessage(id,msgId){const e=required(id),key=messageKey(e,msgId);await e.socket.sendMessage(key.remoteJid,{delete:key});}
  async function operation(id,action,method,params){
    const e=required(id),socket=e.socket;
    const contact=c=>({id:publicJid(c.id),name:c.name||c.notify||c.verifiedName||'',number:publicJid(c.id).split('@')[0],pushname:c.notify||'',isBusiness:Boolean(c.verifiedName),isGroup:c.id?.endsWith('@g.us')||false});
    if(action.startsWith('groups')&&method==='GET'){
      const convert=g=>({id:g.id,name:g.subject||'',owner:publicJid(g.owner||''),creation:g.creation||0,desc:g.desc||'',participants:(g.participants||[]).map(p=>({id:publicJid(p.id),isAdmin:p.admin==='admin'||p.admin==='superadmin',isSuperAdmin:p.admin==='superadmin'}))});
      if(action==='groups/group'){const groupId=checkedJid(params.groupId);if(!groupId.endsWith('@g.us'))throw Object.assign(new Error('groupId inválido.'),{status:400,code:'invalid_group'});return convert(await socket.groupMetadata(groupId));}
      const groups=Object.values(await socket.groupFetchAllParticipating());return action==='groups/ids'?groups.map(g=>g.id):groups.map(convert);
    }
    if(action==='contacts/ids'&&method==='GET')return [...e.contacts.keys()].map(publicJid);
    if(action==='chats/ids'&&method==='GET')return [...e.chats.keys()].map(publicJid);
    if(action==='contacts/invalid'&&method==='GET'){const list=[...e.invalidContacts.keys()];if(['1','true',true].includes(params.clear))e.invalidContacts.clear();return list;}
    if(action==='contacts'&&method==='GET')return [...e.contacts.values()].map(contact);
    if(action==='contacts/blocked'&&method==='GET')return (await socket.fetchBlocklist()).map(publicJid);
    if(action==='chats'&&method==='GET')return [...e.chats.values()].map(c=>({id:publicJid(c.id),name:c.name||c.subject||'',isGroup:c.id?.endsWith('@g.us')||false,unreadCount:c.unreadCount||0,archived:Boolean(c.archived),timestamp:Number(c.conversationTimestamp)||0}));
    const jid=checkedJid(params.chatId);
    if(action==='contacts/check'&&method==='GET'){const result=await socket.onWhatsApp(jid);const exists=Boolean(result?.[0]?.exists);if(!exists)remember(e.invalidContacts,publicJid(jid),true);else e.invalidContacts.delete(publicJid(jid));return {status:exists?'valid':'invalid',chatId:exists?publicJid(result[0].jid):publicJid(jid)};}
    if(action==='contacts/image'&&method==='GET'){let image='';try{image=await socket.profilePictureUrl(jid,'image');}catch{}return {image};}
    if(action==='contacts/contact'&&method==='GET')return contact(e.contacts.get(jid)||{id:jid});
    if(['contacts/block','contacts/unblock'].includes(action)&&method==='POST'){await socket.updateBlockStatus(jid,action.endsWith('/block')?'block':'unblock');return {success:'true',message:'ok'};}
    const messages=[...e.messages.values()].filter(m=>m.key.remoteJid===jid).sort((a,b)=>b.messageTimestamp-a.messageTimestamp),last=messages[0];
    if(action==='chats/messages'&&method==='GET'){
      const limit=Number(params.limit||100);if(!Number.isInteger(limit)||limit<1||limit>1000)throw Object.assign(new Error('limit inválido.'),{status:400,code:'invalid_limit'});
      return messages.slice(0,limit).map(m=>({id:webhookId(jid,m.key.id,m.key.fromMe),fromMe:Boolean(m.key.fromMe),from:publicJid(m.key.fromMe?socket.user.id:jid),to:publicJid(m.key.fromMe?jid:socket.user.id),time:m.messageTimestamp,type:m.description.type,body:m.description.body}));
    }
    if(method==='POST'&&['chats/read','chats/archive','chats/unarchive','chats/delete','chats/clearMessages'].includes(action)){
      if(!last)throw Object.assign(new Error('Conversa ainda não sincronizada nesta sessão.'),{status:409,code:'chat_not_synced'});
      if(action==='chats/read')await socket.readMessages([last.key]);
      else{const lastMessages=[{key:last.key,messageTimestamp:last.messageTimestamp}];let modification;
        if(action==='chats/delete')modification={delete:true,lastMessages};
        else if(action==='chats/clearMessages')modification={clear:{messages:messages.map(m=>({id:m.key.id,fromMe:Boolean(m.key.fromMe),timestamp:m.messageTimestamp}))}};
        else modification={archive:action==='chats/archive',lastMessages};
        await socket.chatModify(modification,jid);
      }
      return {success:'true',message:'ok'};
    }
    throw Object.assign(new Error('Operação não implementada.'),{status:501,code:'not_implemented'});
  }
  async function reset(id){
    const e=entries.get(id);if(e?.status==='authenticated')await disconnect(id);
    else if(e){entries.delete(id);clearTimeout(e.timer);e.wake?.();e.socket?.end(new Error('Reset solicitado.'));}
    await work.get(id);
    db.exec('BEGIN');try{db.prepare('DELETE FROM messages WHERE instance_id=?').run(id);db.prepare('DELETE FROM wa_keys WHERE instance_id=?').run(id);db.prepare("UPDATE instances SET settings='{}',webhook_url='',phone='',auto_connect=0 WHERE id=?").run(id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    mediaRelay.removeInstance(id);return connect(id);
  }
  async function disconnect(id) {
    const e=entries.get(id);
    if(!e?.socket||e.status==='disconnected')throw Object.assign(new Error('A instância já está desconectada.'),{status:409,code:'not_authenticated'});
    const old=e.status;e.status='disconnecting';e.qr=null;clearTimeout(e.timer);
    try{if(e.credentials.creds.registered)await e.socket.logout();}catch{e.status=old;throw new Error('Não foi possível confirmar o logout no WhatsApp. Tente novamente.');}
    entries.delete(id);e.wake?.();e.socket.end(new Error('Logout solicitado.'));
    db.prepare('DELETE FROM wa_keys WHERE instance_id=?').run(id);db.prepare('UPDATE instances SET auto_connect=0,phone=? WHERE id=?').run('',id);
  }
  async function close(){closed=true;for(const e of entries.values()){clearTimeout(e.timer);e.wake?.();e.socket?.end(new Error('Servidor encerrando.'));}await Promise.allSettled([...work.values()]);entries.clear();mediaRelay.close();}
  function restore(){for(const {id} of db.prepare('SELECT id FROM instances WHERE auto_connect=1').all())try{connect(id);}catch{/* visible disconnected state; manual recovery */}}
  return {state,connect,disconnect,flush,restore,close,me,restart,react,deleteMessage,operation,reset};
}
