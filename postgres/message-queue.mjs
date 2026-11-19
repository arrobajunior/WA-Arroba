import {createSerialTasks} from './serial-tasks.mjs';

const mediaTypes=['image','audio','ptt','video','document','sticker'];
const ackLabels={0:'error',1:'pending',2:'server',3:'device',4:'read',5:'played'};
export function createPostgresMessageQueue(store,{ownership,now=Date.now}={}){
  const {db}=store;if(!ownership?.assert)throw new Error('TRANSPORT_OWNERSHIP_REQUIRED');
  const incoming=createSerialTasks();
  async function claim(instanceId,providerId){
    return db.transaction(async tx=>{
      await ownership.assert(tx);
      const instance=await tx.get('SELECT i.active,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1 FOR SHARE OF i,u',[instanceId]);
      if(!instance?.active||!instance.owner_active)return null;
      await tx.run("UPDATE messages SET status='expired',error='Mensagem expirou após 24 horas na fila.' WHERE instance_id=$1 AND status='queue' AND COALESCE(queued_at,FLOOR(EXTRACT(EPOCH FROM created_at::timestamptz))::bigint)<$2",[instanceId,Math.floor(now()/1000)-86400]);
      const row=await tx.get("SELECT * FROM messages WHERE instance_id=$1 AND status='queue' ORDER BY priority,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[instanceId]);if(!row)return null;
      return tx.get("UPDATE messages SET status='sending',provider_id=$1 WHERE id=$2 AND status='queue' RETURNING *",[providerId,row.id]);
    });
  }
  async function allowed(instanceId){
    await ownership.assert(db);
    const row=await db.get('SELECT i.active,u.active AS owner_active FROM instances i JOIN users u ON u.id=i.owner_id WHERE i.id=$1',[instanceId]);return !!(row?.active&&row.owner_active&&ownership.active());
  }
  async function releaseUnsent(row){
    await ownership.assert(db);await db.run("UPDATE messages SET status='queue',provider_id=NULL WHERE id=$1 AND provider_id=$2 AND status='sending'",[row.id,row.provider_id]);
  }
  async function finish(row,{status='sent',error=null}={}){
    await ownership.assert(db);
    await db.run("UPDATE messages SET status=$1,error=$2,sent_at=CASE WHEN $1='sent' THEN COALESCE(sent_at,$3) ELSE sent_at END WHERE id=$4 AND provider_id=$5 AND status='sending'",[status,error,Math.floor(now()/1000),row.id,row.provider_id]);
  }
  async function acknowledge(instanceId,providerId,level){
    const ack=ackLabels[level];if(!ack)return null;
    return db.transaction(async tx=>{
      await ownership.assert(tx);const old=await tx.get('SELECT * FROM messages WHERE instance_id=$1 AND provider_id=$2 ORDER BY created_at,id LIMIT 1 FOR UPDATE',[instanceId,providerId]);if(!old)return null;
      const oldLevel=Object.keys(ackLabels).find(n=>ackLabels[n]===old.ack);
      if(level>0&&oldLevel!==undefined&&Number(oldLevel)>level)return null;
      return tx.get("UPDATE messages SET ack=$1,status=CASE WHEN $2=0 THEN 'unsent' WHEN $2>=2 THEN 'sent' ELSE status END,sent_at=CASE WHEN $2>=2 THEN COALESCE(sent_at,$3) ELSE sent_at END WHERE id=$4 RETURNING *",[ack,level,Math.floor(now()/1000),old.id]);
    });
  }
  async function recordIncoming(row){
    return incoming.run(row.instance_id+':'+row.provider_id,()=>db.transaction(async tx=>{
      await ownership.assert(tx);await tx.get('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[row.instance_id,row.provider_id]);
      const instance=await tx.get('SELECT active FROM instances WHERE id=$1 FOR SHARE',[row.instance_id]);if(!instance?.active)return null;
      const existing=await tx.get('SELECT * FROM messages WHERE instance_id=$1 AND provider_id=$2 ORDER BY created_at,id LIMIT 1',[row.instance_id,row.provider_id]);if(existing)return existing;
      return tx.get('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,provider_id,direction) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[row.id,row.instance_id,row.recipient,row.body,row.type,row.status,row.ack,row.created_at,row.provider_id,row.direction]);
    }));
  }
  async function recoverInterrupted(instanceId=null){
    return db.transaction(async tx=>{
      await ownership.assert(tx);
      await tx.run("UPDATE messages SET status='unknown',error='Processo interrompido durante envio; confirme o recebimento antes de reenviar.' WHERE status='sending' AND ($1::text IS NULL OR instance_id=$1)",[instanceId]);
      if(instanceId===null)await tx.run("UPDATE messages SET status='unsent',error='Mídia temporária expirada após reinício; reenvie o arquivo pelo cliente.' WHERE type=ANY($1::text[]) AND status='queue' AND media_id IS NOT NULL AND source_url='' AND NOT EXISTS(SELECT 1 FROM media_objects WHERE media_objects.instance_id=messages.instance_id AND media_objects.message_id=messages.media_id)",[mediaTypes]);
    });
  }
  return {claim,allowed,releaseUnsent,finish,acknowledge,recordIncoming,recoverInterrupted};
}
