import makeWASocket,{DisconnectReason,Browsers,generateMessageID,downloadMediaMessage} from '@whiskeysockets/baileys';
import pino from 'pino';
import {randomBytes} from 'node:crypto';
import {readSettings,publicJid,whatsappJid,webhookId} from '../instance-settings.mjs';
import {mediaInput} from '../media-input.mjs';
import {createMediaRelay} from '../media-relay.mjs';
import {createPostgresAuthState} from './auth-state.mjs';
import {createPostgresMessageQueue} from './message-queue.mjs';
import {createSerialTasks} from './serial-tasks.mjs';

const silentLogger=pino({level:'silent'});
const transportOwners=new WeakSet();
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
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


export function createPostgresTransport(store,{ownership,socketFactory=makeWASocket,retryDelay=2000,mediaBaseUrl,mediaDownloader=downloadMediaMessage,mediaRelay=createMediaRelay(),legacyStorage=()=>null,mediaLoader=mediaInput,onConnectionState=async()=>{},webhookSender=null,webhookRetryMs=1500,now=Date.now}={}){
  if(!ownership?.assert||!ownership?.active||!ownership?.onLost)throw new Error('TRANSPORT_OWNERSHIP_REQUIRED');
  if(!ownership.active())throw new Error('TRANSPORT_OWNERSHIP_LOST');
  if(transportOwners.has(ownership))throw new Error('TRANSPORT_ALREADY_STARTED');transportOwners.add(ownership);
  const {db,decrypt}=store,queue=createPostgresMessageQueue(store,{ownership,now}),commands=createSerialTasks(),entries=new Map(),work=new Map(),rerun=new Set(),hooks=new Set(),controllers=new Set();
  let closed=false,closing=false,closePromise,recovered=false;
  const endSocket=(e,message)=>{if(e.ended)return;e.ended=true;try{e.socket?.end(new Error(message));}catch{console.error('[whatsapp] Falha ao encerrar socket.');}};
  const remember=(map,key,value,max=2000)=>{map.delete(key);map.set(key,value);while(map.size>max)map.delete(map.keys().next().value);};
  const settingsFor=async id=>readSettings(await db.get('SELECT settings,webhook_url FROM instances WHERE id=$1',[id])||{});
  async function webhookFor(id,event){
    const row=await db.get('SELECT i.*,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1',[id]);
    if(!row?.active||!row.owner_active)return '';const s=readSettings(row);return (!event||s['webhook_'+event])?s.webhook_url:'';
  }
  const state=id=>{const e=entries.get(id);return {status:e?.status||'disconnected',qr:e?.qr||null,error:e?.error||null};};
  const valid=e=>!e.invalid&&entries.get(e.id)===e&&ownership.active();
  const logFailure=()=>console.error('[whatsapp] Falha na operação assíncrona; confira o estado da instância.');
  const fire=promise=>{void promise.catch(logFailure);};
  const notify=(...args)=>onConnectionState(...args);
  function failEntry(e){
    e.error='Falha ao persistir evento do WhatsApp. Reconecte após verificar o banco.';e.status='disconnected';e.qr=null;e.invalid=true;e.stopping=true;clearTimeout(e.timer);e.wake?.();
    fire(e.auth?.invalidate()||Promise.resolve());endSocket(e,'Persistência indisponível.');logFailure();
  }
  const unsubscribe=ownership.onLost(()=>{
    for(const c of controllers)c.abort();
    for(const e of entries.values()){e.error='A aplicação perdeu a propriedade da sessão.';e.status='disconnected';e.qr=null;e.invalid=true;e.stopping=true;clearTimeout(e.timer);e.wake?.();fire(e.auth?.invalidate()||Promise.resolve());endSocket(e,'Propriedade da sessão perdida.');}
  });
  async function assertActive(id,{requireOwner=true}={}){
    if(closed||closing)throw fail('shutting_down','Aplicação em encerramento.',503);await ownership.assert(db);
    const row=await db.get('SELECT i.active,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1',[id]);
    if(!row?.active)throw fail('instance_disabled','Reative a instância antes de conectar.');
    if(requireOwner&&!row.owner_active)throw fail('owner_disabled','Proprietário bloqueado.');return row;
  }
  async function sendHook(e,url,payload){
    if(!url||closed||!valid(e))return;
    for(let attempt=1;attempt<=3;attempt++){
      if(closed||!valid(e))return;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);controllers.add(controller);
      try{
        if(webhookSender)await webhookSender(url,payload,{signal:controller.signal});
        else{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});if(!response.ok)throw new Error('WEBHOOK_HTTP_ERROR');}
        return;
      }catch{if(attempt===3){console.error('[webhook] Falha após três tentativas.');return;}}
      finally{clearTimeout(timer);controllers.delete(controller);}
      await new Promise(resolve=>setTimeout(resolve,webhookRetryMs));
    }
  }
  function post(e,url,payload){const task=sendHook(e,url,payload);hooks.add(task);e.hooks.add(task);void task.catch(logFailure).finally(()=>{hooks.delete(task);e.hooks.delete(task);});}
  async function downloadAndStoreMedia(id,msg,mimetype,socket,filename){
    const stream=await mediaDownloader(msg,'stream',{},{logger:silentLogger,reuploadRequest:socket.updateMediaMessage});
    let buffer;if(Buffer.isBuffer(stream))buffer=stream;else{const chunks=[];let size=0;for await(const chunk of stream){size+=chunk.length;if(size>32*1024*1024){stream.destroy?.();throw new Error('MEDIA_TOO_LARGE');}chunks.push(chunk);}buffer=Buffer.concat(chunks);}
    if(buffer.length>32*1024*1024)return null;return mediaRelay.put(id,buffer,mimetype,filename||'file');
  }
  async function teardown(e){
    if(!e)return;e.stopping=true;clearTimeout(e.timer);e.wake?.();
    endSocket(e,'Substituição controlada da conexão.');
    await e.control.idle();await e.messagesQueue.idle();await e.auth?.drain();
    await work.get(e.id)?.catch(()=>{});await Promise.allSettled([...e.hooks]);
    await e.auth?.drain();
    e.invalid=true;if(entries.get(e.id)===e)entries.delete(e.id);await e.auth?.invalidate();
  }
  async function open(id,attempt=0,auditContext=null){
    await assertActive(id);const previous=entries.get(id);
    if(previous&&((!attempt&&['initialize','qr','authenticated','retrying','disconnecting'].includes(previous.status))||(attempt&&previous.sawOpen)))return state(id);
    await teardown(previous);await queue.recoverInterrupted(id);
    const e={id,status:'initialize',qr:null,error:null,socket:null,timer:null,auditContext,invalid:false,stopping:false,sawOpen:false,contacts:new Map(),chats:new Map(),messages:new Map(),webhooked:new Map(),invalidContacts:new Map(),hooks:new Set(),control:createSerialTasks(),messagesQueue:createSerialTasks()};entries.set(id,e);
    const isValid=()=>valid(e);
    try{
      const credentials=await createPostgresAuthState(store,id,{valid:isValid});e.auth=credentials;e.credentials=credentials.state;
      if(attempt>0)await notify(id,'retrying','Tentativa automática de reconexão.',{source:'whatsapp',reconnectAttempt:attempt});
      await db.run('UPDATE instances SET auto_connect=1 WHERE id=$1',[id]);
      if(closed||closing||!isValid())throw fail('shutting_down','Aplicação em encerramento.',503);
      e.socket=socketFactory({auth:credentials.state,logger:silentLogger,browser:Browsers.ubuntu('Chrome'),markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,connectTimeoutMs:30000,defaultQueryTimeoutMs:30000});
      function listen(name,handler){e.socket.ev.on(name,payload=>{
        if(closed||closing||e.stopping||!isValid())return;
        if(name==='connection.update'){if(payload.connection==='open'){e.sawOpen=true;clearTimeout(e.timer);}if(payload.connection==='close')e.sawOpen=false;}
        const serial=name==='connection.update'?e.control:e.messagesQueue;
        void serial.run('events',async()=>{if(!isValid()||(e.stopping&&name==='connection.update'))return;await handler(payload);}).catch(()=>failEntry(e));
      });}
            // Mapeamentos por instância, criptografados junto às chaves da sessão.
      const normalize=value=>typeof value==='string'?value.replace(/:\d+(?=@)/,'').replace('@c.us','@s.whatsapp.net'):'';
      const isPhone=value=>/^\d+@s\.whatsapp\.net$/.test(normalize(value));
      const isLid=value=>/^\d+@lid$/.test(normalize(value));
      async function learnPair(lid,phone) {
        lid=normalize(lid);phone=normalize(phone);
        if(isValid()&&isLid(lid)&&isPhone(phone))await credentials.state.keys.set({'webhook-lid-phone':{[lid]:phone}});
      }
      const learnContact=c=>learnPair(isLid(c.id)?c.id:c.lid,isPhone(c.id)?c.id:c.jid);
      async function resolvePeer(jid,alternate) {
        if(!isLid(jid))return jid;
        if(isPhone(alternate)){await learnPair(jid,alternate);return normalize(alternate);}
        const key=normalize(jid),saved=await credentials.state.keys.get('webhook-lid-phone',[key]);
        if(isPhone(saved[key]))return saved[key];
        try {
          const mapped=await e.socket.signalRepository?.lidMapping?.getPNForLID?.(key);
          if(isPhone(mapped)){await learnPair(key,mapped);return normalize(mapped);}
        } catch {/* Ausência do mapeamento não deve perder a mensagem. */}
        return jid;
      }
      listen('chats.phoneNumberShare',pair=>{if(isValid())learnPair(pair.lid,pair.jid).catch(()=>{});});
      const cacheMessages=messages=>{for(const msg of messages||[]){const jid=msg.key?.remoteJid;if(!jid||!msg.key?.id)continue;const desc=describeMessage(msg);if(desc)remember(e.messages,msg.key.id,{key:msg.key,messageTimestamp:Number(msg.messageTimestamp)||Math.floor(Date.now()/1000),description:desc});}};
      listen('contacts.upsert',contacts=>{if(isValid())for(const c of contacts){remember(e.contacts,c.id,c);learnContact(c).catch(()=>{});}});
      listen('contacts.update',contacts=>{if(isValid())for(const c of contacts){const merged={...e.contacts.get(c.id),...c};remember(e.contacts,c.id,merged);learnContact(merged).catch(()=>{});}});
      listen('chats.upsert',chats=>{if(isValid())for(const c of chats)remember(e.chats,c.id,c);});
      listen('chats.update',chats=>{if(isValid())for(const c of chats)remember(e.chats,c.id,{...e.chats.get(c.id),...c});});
      listen('chats.delete',ids=>{if(isValid())for(const jid of ids)e.chats.delete(jid);});
      listen('messaging-history.set',snapshot=>{if(!isValid())return;for(const c of snapshot.contacts||[]){remember(e.contacts,c.id,c);learnContact(c).catch(()=>{});}for(const c of snapshot.chats||[])remember(e.chats,c.id,c);cacheMessages(snapshot.messages);});

      e.socket.ev.on('creds.update',update=>{if(closed||e.stopping||!isValid())return;Object.assign(credentials.state.creds,update);void credentials.save().catch(()=>failEntry(e));});
      listen('connection.update',async update=>{
        if(!isValid())return;
        if(update.qr){e.qr=update.qr;e.status='qr';await notify(id,'qr','A sessão precisa de uma nova leitura do QR Code.',{source:'whatsapp',reconnectAttempt:attempt,auditContext:e.auditContext});}
        if(update.connection==='open'){
          clearTimeout(e.timer);e.timer=null;e.status='authenticated';e.qr=null;e.error=null;attempt=0;
          const phone=(e.socket.user?.id||'').split(':')[0].split('@')[0];
          await db.run('UPDATE instances SET phone=$1,updated_at=$2 WHERE id=$3',[phone,new Date(now()).toISOString(),id]);
          await notify(id,'authenticated',undefined,{source:'whatsapp',phone,auditContext:e.auditContext});e.auditContext=null;fire(flush(id));
        }
        if(update.connection==='close'){
          e.qr=null;if(e.status==='disconnecting')return;const reason=update.lastDisconnect?.error?.output?.statusCode;
          await notify(id,'disconnected',reason===DisconnectReason.loggedOut?'A sessão foi encerrada no WhatsApp. É necessário ler um novo QR Code.':reason===DisconnectReason.connectionReplaced?'A conexão foi substituída por outra sessão.':'Conexão com o WhatsApp interrompida. O sistema tentará reconectar quando possível.',{source:'whatsapp',code:reason,reconnectAttempt:attempt,terminal:reason===DisconnectReason.loggedOut||reason===DisconnectReason.connectionReplaced||attempt>=5});
          if(reason===DisconnectReason.loggedOut){
            e.status='disconnected';e.error='Sessão encerrada no WhatsApp. Gere um novo QR Code.';e.invalid=true;await credentials.invalidate();
            await db.transaction(async tx=>{await ownership.assert(tx);await tx.run('DELETE FROM wa_keys WHERE instance_id=$1',[id]);await tx.run('UPDATE instances SET auto_connect=0 WHERE id=$1',[id]);});return;
          }
          if(reason===DisconnectReason.connectionReplaced||attempt>=5){e.status='disconnected';e.error=reason===DisconnectReason.connectionReplaced?'Conexão substituída por outra sessão.':'Não foi possível reconectar. Tente conectar novamente.';await db.run('UPDATE instances SET auto_connect=0 WHERE id=$1',[id]);return;}
          e.status='retrying';e.timer=setTimeout(()=>{if(!closed&&isValid()&&!e.sawOpen){fire(connect(id,attempt+1,e.auditContext));}},reason===DisconnectReason.restartRequired?500:Math.min(retryDelay*2**attempt,30000));e.timer.unref();
        }
      });
      listen('messages.update',async updates=>{
        for(const {key,update} of updates){
          if(update.status==null||!isValid())continue;const row=await queue.acknowledge(id,key.id,update.status);if(!row)continue;
          const url=await webhookFor(id,'message_ack');if(url)post(e,url,{event_type:'message_ack',instanceId:id,data:{id:webhookId(key.remoteJid||whatsappJid(row.recipient),key.id,key.fromMe??true),ack:row.ack,...(row.reference_id?{referenceId:row.reference_id}:{})}});
        }
      });
      async function handleIncoming(msg){
        if(!isValid())return;const jid=msg.key?.remoteJid||'';if(!jid||jid==='status@broadcast'||jid.endsWith('@newsletter'))return;
        const desc=describeMessage(msg);if(!desc||e.webhooked.has(msg.key.id))return;remember(e.webhooked,msg.key.id,true);
        const fromMe=!!msg.key.fromMe,peer=await resolvePeer(jid,msg.key.remoteJidAlt||(!fromMe?msg.key.senderPn:undefined)),author=await resolvePeer(msg.key.participant||'',msg.key.participantAlt||msg.key.participantPn);
        if(!isValid())return;const ts=Number(msg.messageTimestamp)||Math.floor(now()/1000),self=(e.socket.user?.id||'').split(':')[0].split('@')[0];
        const stored=await queue.recordIncoming({id:randomBytes(12).toString('hex'),instance_id:id,recipient:jid,body:desc.body,type:desc.type,status:fromMe?'sent':'received',ack:'device',created_at:new Date(ts*1000).toISOString(),provider_id:msg.key.id,direction:fromMe?'out':'in'});if(!stored)return;
        let media=null;
        if(desc.mimetype&&mediaBaseUrl&&(await settingsFor(id)).webhook_message_download_media){
          try{const key=await downloadAndStoreMedia(id,msg,desc.mimetype,e.socket,desc.filename);if(key&&isValid()){media=mediaRelay.url(mediaBaseUrl,id,key);await db.run('UPDATE messages SET media_id=$1 WHERE instance_id=$2 AND provider_id=$3',[key,id,msg.key.id]);}}catch{console.error('[media] Falha ao baixar mídia.');}
        }
        if(!isValid())return;
        const tracked=await db.get('SELECT m.reference_id,a.api_id FROM messages m JOIN api_messages a ON a.message_id=m.id WHERE m.instance_id=$1 AND m.provider_id=$2',[id,msg.key.id]);
        const url=await webhookFor(id,fromMe?'message_create':'message_received'),context=Object.values(msg.message||{}).find(v=>v?.contextInfo)?.contextInfo||{};
        if(url)post(e,url,{event_type:fromMe?'message_create':'message_received',instanceId:id,id:fromMe?(tracked?.api_id||''):'',referenceId:tracked?.reference_id||'',data:{id:webhookId(jid,msg.key.id,fromMe),from:publicJid(fromMe?self:peer),to:publicJid(fromMe?peer:self),author:publicJid(author),...(isLid(jid)?{remoteJid:publicJid(jid),phoneResolved:isPhone(peer)}:{}),fromMe,body:desc.body,type:desc.type,ack:'',time:ts,pushname:msg.pushName||'',media:media||'',isForwarded:Boolean(context.isForwarded),isMentioned:(context.mentionedJid||[]).some(j=>publicJid(j)===publicJid(e.socket.user?.id||'')),quotedMsg:context.stanzaId?{id:context.stanzaId,body:context.quotedMessage?.conversation||context.quotedMessage?.extendedTextMessage?.text||''}:{},mentionedIds:(context.mentionedJid||[]).map(publicJid)}});
      }
      listen('messages.upsert',async({messages,type})=>{if(type!=='notify')return;cacheMessages(messages);for(const msg of messages)await handleIncoming(msg);});
    }catch(error){e.status='disconnected';e.error='Falha ao iniciar conexão WhatsApp.';e.invalid=true;await e.auth?.invalidate();if(ownership.active()){await db.run('UPDATE instances SET auto_connect=0 WHERE id=$1',[id]);await notify(id,'disconnected',e.error,{source:'transport_start',reconnectAttempt:attempt});}throw error;}
    return state(id);
  }
  const connect=(id,attempt=0,context=null)=>commands.run(id,()=>open(id,attempt,context));
  async function runQueue(id){
    while(!closed&&!closing){
      const e=entries.get(id);if(!e||e.stopping||!valid(e)||e.status!=='authenticated')return;
      const row=await queue.claim(id,generateMessageID());if(!row)return;
      const jid=row.recipient.includes('@')?row.recipient.replace('@c.us','@s.whatsapp.net'):`${row.recipient.replace(/^\+/,'')}@s.whatsapp.net`;
      let attempted=false;
      try{
        let content={text:row.body};const payload=JSON.parse(row.payload||'{}');
        if(['image','audio','ptt','video','document','sticker'].includes(row.type)){
          const entry=mediaRelay.get(id,row.media_id);let bytes=entry?.bytes,mimetype=entry?.mimetype;
          if(!bytes&&row.source_url)try{const kind=row.type==='ptt'?'voice':row.type,field=kind==='voice'?'audio':kind,loaded=await mediaLoader({[field]:decrypt(row.source_url),filename:row.filename},kind);bytes=loaded.bytes;mimetype=loaded.mimetype;}catch{}
          if(!bytes){const object=await db.get('SELECT * FROM media_objects WHERE instance_id=$1 AND message_id=$2',[id,row.media_id]);if(object&&legacyStorage())try{bytes=await legacyStorage().get(object.object_key);mimetype=object.mimetype;}catch{}}
          if(!bytes){await queue.finish(row,{status:'unsent',error:'Mídia temporária indisponível; reenvie pelo sistema cliente.'});continue;}
          if(row.type==='image')content={image:bytes,caption:row.body,mimetype};else if(row.type==='video')content={video:bytes,caption:row.body,mimetype};else if(row.type==='document')content={document:bytes,caption:row.body,mimetype,fileName:row.filename||'file'};else if(row.type==='sticker')content={sticker:bytes};else content={audio:bytes,mimetype,ptt:row.type==='ptt'};
        }else if(row.type==='link')content={text:row.body,linkPreview:null};else if(row.type==='location')content={location:{degreesLatitude:payload.lat,degreesLongitude:payload.lng,address:payload.address}};else if(row.type==='vcard')content={contacts:{displayName:'Contato',contacts:[{vcard:payload.vcard}]}};else if(row.type==='contact')content={contacts:{displayName:'Contatos',contacts:payload.contacts}};
        if(closed||closing||!valid(e)||e.stopping||e.status!=='authenticated'||!await queue.allowed(id)){await queue.releaseUnsent(row);return;}
        attempted=true;await e.socket.sendMessage(jid,content,{messageId:row.provider_id});await queue.finish(row);
        if(!e.webhooked.has(row.provider_id)){
          remember(e.webhooked,row.provider_id,true);const hook=await webhookFor(id,'message_create');
          if(hook){const apiId=(await db.get('SELECT api_id FROM api_messages WHERE message_id=$1',[row.id]))?.api_id||'',entry=row.media_id?mediaRelay.get(id,row.media_id):null;
            post(e,hook,{event_type:'message_create',instanceId:id,id:apiId,referenceId:row.reference_id||'',data:{id:webhookId(jid,row.provider_id,true),from:publicJid(e.socket.user?.id||''),to:publicJid(jid),author:'',pushname:e.socket.user?.name||'',ack:'pending',type:row.type,body:row.body,media:entry&&mediaBaseUrl?mediaRelay.url(mediaBaseUrl,id,row.media_id):'',fromMe:true,isForwarded:false,isMentioned:false,quotedMsg:{},mentionedIds:[],time:Math.floor(now()/1000)}});
          }
        }
      }catch(error){
        if(!ownership.active())return;
        if(attempted)await queue.finish(row,{status:'unknown',error:'Envio sem confirmação; verifique o destinatário antes de reenviar.'});else await queue.finish(row,{status:'unsent',error:'Não foi possível preparar a mensagem; revise os dados antes de reenviar.'});
        if(error.code==='TRANSPORT_OWNERSHIP_LOST')return;
      }
      if(closed||e.stopping)return;
      const pending=(await db.get("SELECT count(*) AS n FROM messages WHERE instance_id=$1 AND status='queue'",[id])).n;if(!pending)return;
      const settings=await settingsFor(id);await new Promise(resolve=>{const timer=setTimeout(resolve,(pending>=10?settings.sendDelayMax:settings.sendDelay)*1000);e.wake=()=>{clearTimeout(timer);resolve();};});
    }
  }
  function flush(id){
    if(closed||closing)return Promise.resolve();if(work.has(id)){rerun.add(id);return work.get(id);}
    const task=Promise.resolve().then(()=>runQueue(id));work.set(id,task);
    void task.catch(()=>{const e=entries.get(id);if(e)e.error='Falha ao processar fila.';logFailure();}).finally(()=>{if(work.get(id)===task)work.delete(id);if(rerun.delete(id)&&!closed)fire(flush(id));});return task;
  }
  const required=async id=>{await assertActive(id);const e=entries.get(id);if(!e||!valid(e)||e.stopping||e.status!=='authenticated')throw fail('not_authenticated','WhatsApp não está conectado.');return e;};
    const checkedJid=value=>{if(typeof value!=='string'||!/^\+?\d[0-9-]*(?:@(c\.us|g\.us|s\.whatsapp\.net|lid))?$/.test(value))throw Object.assign(new Error('chatId inválido.'),{status:400,code:'invalid_chat'});return whatsappJid(value);};
  async function me(id){const e=await required(id),user=e.socket.user||{},jid=publicJid(user.id||'');let image='';try{image=await e.socket.profilePictureUrl(whatsappJid(jid),'image');}catch{}return {id:jid,name:user.name||user.verifiedName||'',number:jid.split('@')[0],image};}
  function messageKey(e,msgId){
    const found=e.messages.get(msgId)||[...e.messages.values()].find(m=>webhookId(m.key.remoteJid,m.key.id,m.key.fromMe)===msgId);
    let key=found?.key;
    if(!key){const match=msgId.match(/^(true|false)_([^_]+)_(.+)$/);if(match)key={remoteJid:checkedJid(match[2]),id:match[3],fromMe:match[1]==='true'};}
    if(!key)throw Object.assign(new Error('msgId inválido ou indisponível.'),{status:400,code:'invalid_message_id'});
    return key;
  }
  async function react(id,msgId,emoji){const e=await required(id),key=messageKey(e,msgId);await e.socket.sendMessage(key.remoteJid,{react:{text:emoji,key}});}
  async function deleteMessage(id,msgId){const e=await required(id),key=messageKey(e,msgId);await e.socket.sendMessage(key.remoteJid,{delete:key});}
  async function operation(id,action,method,params){
    const e=await required(id),socket=e.socket;
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

  const restart=(id,context=null)=>commands.run(id,async()=>{await assertActive(id);await teardown(entries.get(id));return open(id,0,context);});
  async function disconnectInternal(id,context){
    await assertActive(id,{requireOwner:false});const e=entries.get(id);if(!e?.socket||e.status==='disconnected')throw fail('not_authenticated','A instância já está desconectada.');
    const old=e.status;e.status='disconnecting';e.qr=null;clearTimeout(e.timer);
    try{if(e.credentials.creds.registered)await e.socket.logout();}catch{e.status=old;throw fail('logout_failed','Não foi possível confirmar o logout no WhatsApp. Tente novamente.',502);}
    await notify(id,'disconnected','A instância foi desconectada pelo painel ou pela API.',{source:'manual_disconnect',auditContext:context});
    await teardown(e);await db.transaction(async tx=>{await ownership.assert(tx);await tx.run('DELETE FROM wa_keys WHERE instance_id=$1',[id]);await tx.run("UPDATE instances SET auto_connect=0,phone='' WHERE id=$1",[id]);});
  }
  const disconnect=(id,context=null)=>commands.run(id,()=>disconnectInternal(id,context));
  const suspend=id=>commands.run(id,async()=>{if(closed||closing)throw fail('shutting_down','Aplicação em encerramento.',503);await teardown(entries.get(id));await ownership.assert(db);await db.run('UPDATE instances SET auto_connect=0 WHERE id=$1',[id]);});
  const reset=(id,context=null)=>commands.run(id,async()=>{
    await assertActive(id);const e=entries.get(id);if(e?.status==='authenticated')await disconnectInternal(id,context);else await teardown(e);
    await db.transaction(async tx=>{await ownership.assert(tx);await tx.run('DELETE FROM messages WHERE instance_id=$1',[id]);await tx.run('DELETE FROM wa_keys WHERE instance_id=$1',[id]);await tx.run("UPDATE instances SET settings='{}',webhook_url='',phone='',auto_connect=0 WHERE id=$1",[id]);});mediaRelay.removeInstance(id);return open(id,0,context);
  });
  async function restore(){if(closed||closing)throw fail('shutting_down','Aplicação em encerramento.',503);await ownership.assert(db);for(const row of await db.all('SELECT i.id FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.auto_connect=1 AND i.active=1 AND u.active=1'))try{await connect(row.id);}catch{logFailure();}}
  async function idle(){
    do{await commands.idle();for(const e of entries.values()){await e.control.idle();await e.messagesQueue.idle();await e.auth?.drain();}await Promise.allSettled([...work.values(),...hooks]);}
    while(commands.size()||work.size||hooks.size||[...entries.values()].some(e=>e.control.size()||e.messagesQueue.size()));
  }
  function close(){
    if(closePromise)return closePromise;closing=true;for(const e of entries.values()){e.stopping=true;clearTimeout(e.timer);e.wake?.();endSocket(e,'Servidor encerrando.');}
    closePromise=(async()=>{await commands.idle();for(const e of [...entries.values()])await teardown(e);await Promise.allSettled([...work.values(),...hooks]);closed=true;entries.clear();mediaRelay.close();unsubscribe();transportOwners.delete(ownership);})();return closePromise;
  }
  return {state,connect,disconnect,flush,restore,close,idle,me,restart,react,deleteMessage,operation,reset,suspend,recoverInterrupted:async()=>{if(closed||closing)throw fail('shutting_down','Aplicação em encerramento.',503);if(entries.size||work.size||commands.size())throw fail('recovery_requires_idle_transport','Recuperação permitida somente antes de restaurar conexões.');if(!recovered){await queue.recoverInterrupted();recovered=true;}}};
}
