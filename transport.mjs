import makeWASocket, { BufferJSON, initAuthCreds, proto, DisconnectReason, Browsers, generateMessageID } from '@whiskeysockets/baileys';
import pino from 'pino';
import { randomBytes } from 'node:crypto';

// ── Webhook de recebimento ──────────────────────────────────────────────────
// Entrega best-effort (sem fila/retentativa): se o destino estiver fora do ar,
// o evento é perdido e apenas registrado no log. Formato compatível com o
// payload do UltraMsg (event_type/data), para funcionar sem alterações em
// sistemas que já recebem webhooks daquele provedor.
const WEBHOOK_TIMEOUT_MS=8000;
async function deliverWebhook(url,payload) {
  if(!url)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),WEBHOOK_TIMEOUT_MS);
  try {
    const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    if(!res.ok)console.error(`[webhook] ${url} respondeu ${res.status}`);
  } catch(e) {
    console.error(`[webhook] falha ao entregar para ${url}: ${e.message}`);
  } finally { clearTimeout(timer); }
}
// Extrai tipo e corpo de uma mensagem Baileys. Retorna null para tipos sem
// conteúdo de usuário (reações, recibos, mensagens de protocolo etc.).
function describeMessage(msg) {
  const raw=msg.message||{};
  const core=raw.ephemeralMessage?.message||raw.viewOnceMessage?.message||raw.viewOnceMessageV2?.message||raw;
  if(core.conversation!=null)return {type:'chat',body:core.conversation};
  if(core.extendedTextMessage)return {type:'chat',body:core.extendedTextMessage.text||''};
  if(core.imageMessage)return {type:'image',body:core.imageMessage.caption||''};
  if(core.videoMessage)return {type:'video',body:core.videoMessage.caption||''};
  if(core.audioMessage)return {type:core.audioMessage.ptt?'ptt':'audio',body:''};
  if(core.documentMessage)return {type:'document',body:core.documentMessage.caption||core.documentMessage.fileName||''};
  if(core.stickerMessage)return {type:'sticker',body:''};
  return null;
}

export function createTransport(store, { socketFactory=makeWASocket, retryDelay=2000 }={}) {
  const {db,encrypt,decrypt}=store, entries=new Map(), work=new Map();
  let closed=false;
  const webhookFor=id=>db.prepare('SELECT webhook_url FROM instances WHERE id=?').get(id)?.webhook_url||'';
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
    const e={status:'initialize',qr:null,error:null,socket:null,timer:null};entries.set(id,e);
    const valid=()=>!closed&&entries.get(id)===e;
    const credentials=auth(id,valid);
    e.credentials=credentials.state;
    db.prepare('UPDATE instances SET auto_connect=1 WHERE id=?').run(id);
    try {
      e.socket=socketFactory({auth:credentials.state,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),markOnlineOnConnect:false,syncFullHistory:false,shouldSyncHistoryMessage:()=>false,connectTimeoutMs:30000,defaultQueryTimeoutMs:30000});
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
          db.prepare("UPDATE messages SET ack=?,status=CASE WHEN ?=0 THEN 'unsent' WHEN ?>=2 THEN 'sent' ELSE status END WHERE instance_id=? AND provider_id=?").run(ack,update.status,update.status,id,key.id);
          const url=webhookFor(id);if(url)deliverWebhook(url,{event_type:'message_ack',data:{id:key.id,ack}});
        }
      });
      // ── Mensagens recebidas (e enviadas fora da API) ──────────────────────
      e.socket.ev.on('messages.upsert',({messages,type})=>{
        if(!valid()||type!=='notify')return; // ignora replay de histórico em reconexões
        const url=webhookFor(id);
        for(const msg of messages) {
          const jid=msg.key?.remoteJid||'';
          if(!jid||jid==='status@broadcast'||jid.endsWith('@g.us')||jid.endsWith('@newsletter'))continue;
          const desc=describeMessage(msg);if(!desc)continue;
          const fromMe=!!msg.key.fromMe;
          const ts=Number(msg.messageTimestamp)||Math.floor(Date.now()/1000);
          const self=(e.socket.user?.id||'').split(':')[0].split('@')[0];
          // Evita duplicar no histórico mensagens já registradas pelo envio via API (mesmo provider_id)
          if(!db.prepare('SELECT 1 FROM messages WHERE instance_id=? AND provider_id=?').get(id,msg.key.id)){
            db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,provider_id,direction) VALUES(?,?,?,?,?,?,?,?,?,?)')
              .run(randomBytes(12).toString('hex'),id,jid,desc.body,desc.type,fromMe?'sent':'received','device',new Date(ts*1000).toISOString(),msg.key.id,fromMe?'out':'in');
          }
          if(url)deliverWebhook(url,{event_type:fromMe?'message_create':'message_received',data:{id:msg.key.id,from:fromMe?self:jid,to:fromMe?jid:self,fromMe,body:desc.body,type:desc.type,time:ts,pushname:msg.pushName||''}});
        }
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
        const row=db.prepare("SELECT * FROM messages WHERE instance_id=? AND status='queue' ORDER BY created_at,id LIMIT 1").get(id);if(!row)return;
        const providerId=generateMessageID();
        db.prepare("UPDATE messages SET status='sending',provider_id=? WHERE id=? AND status='queue'").run(providerId,row.id);
        const jid=row.recipient.includes('@')?row.recipient.replace('@c.us','@s.whatsapp.net'):`${row.recipient.replace(/^\+/,'')}@s.whatsapp.net`;
        try {
          await e.socket.sendMessage(jid,{text:row.body},{messageId:providerId});
          // A successful send call alone is not delivery confirmation. Preserve any ACK received during the call.
          if(!closed)db.prepare("UPDATE messages SET status='sent' WHERE id=? AND status='sending'").run(row.id);
        }catch{
          if(!closed)db.prepare("UPDATE messages SET status='unknown',error='Envio sem confirmação; verifique o destinatário antes de reenviar.' WHERE id=? AND status='sending'").run(row.id);
        }
        if(closed)return;
        await new Promise(resolve=>{const timer=setTimeout(resolve,1000);e.wake=()=>{clearTimeout(timer);resolve();};});
      }
    })();
    work.set(id,run);run.catch(()=>{const e=entries.get(id);if(e)e.error='Falha ao processar fila.';}).finally(()=>work.delete(id));
  }
  async function disconnect(id) {
    const e=entries.get(id);
    if(!e?.socket||e.status==='disconnected')throw new Error('Conecte a instância antes de encerrar a sessão pelo painel.');
    const old=e.status;e.status='disconnecting';e.qr=null;clearTimeout(e.timer);
    try{if(e.credentials.creds.registered)await e.socket.logout();}catch{e.status=old;throw new Error('Não foi possível confirmar o logout no WhatsApp. Tente novamente.');}
    entries.delete(id);e.wake?.();e.socket.end(new Error('Logout solicitado.'));
    db.prepare('DELETE FROM wa_keys WHERE instance_id=?').run(id);db.prepare('UPDATE instances SET auto_connect=0,phone=? WHERE id=?').run('',id);
  }
  async function close(){closed=true;for(const e of entries.values()){clearTimeout(e.timer);e.wake?.();e.socket?.end(new Error('Servidor encerrando.'));}await Promise.allSettled([...work.values()]);entries.clear();}
  function restore(){for(const {id} of db.prepare('SELECT id FROM instances WHERE auto_connect=1').all())try{connect(id);}catch{/* visible disconnected state; manual recovery */}}
  return {state,connect,disconnect,flush,restore,close};
}
