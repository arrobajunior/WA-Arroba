import {randomBytes} from 'node:crypto';
import {fail,text,keys,webhookUrl} from './validation.mjs';

export function createPostgresInstances(store,{activity,state=()=>({status:'disconnected'}),now=Date.now,perOwnerLimit=50}={}){
  const {db,encrypt,decrypt}=store;
  if(!Number.isInteger(perOwnerLimit)||perOwnerLimit<1||perOwnerLimit>10000)throw fail(500,'invalid_instance_limit','Limite inválido.');
  const actorFor=async(tx,actor,lock=false)=>{
    const user=await tx.get('SELECT * FROM users WHERE id=$1 AND active=1'+(lock?' FOR SHARE':''),[actor?.id||'']);if(!user)throw fail(401,'unauthorized','Faça login para continuar.');return user;
  };
  const allowed=(actor,row)=>actor.role==='admin'||actor.id===row.owner_id;
  async function authorized(actor,id){
    const user=await actorFor(db,actor),row=await db.get('SELECT * FROM instances WHERE id=$1',[id]);
    if(!row)throw fail(404,'not_found','Instância não encontrada.');
    if(!allowed(user,row)){
      await activity.record({instance:row,actor:activity.userActor(user),action:'instance_access_denied',outcome:'denied',source:'panel'});
      throw fail(404,'not_found','Instância não encontrada.');
    }
    return {row,user};
  }
  const emptyCounts=()=>({total:0,queue:0,sent:0,unsent:0,unknown:0,sending:0});
  async function serialize(row,{secret=false,tx=db,preloaded}={}){
    const counts=preloaded?preloaded.counts:emptyCounts();
    if(!preloaded)for(const r of await tx.all('SELECT status,count(*) AS n FROM messages WHERE instance_id=$1 GROUP BY status',[row.id])){counts[r.status]=r.n;counts.total+=r.n;}
    const owner=preloaded?{name:row.owner_name}:await tx.get('SELECT name FROM users WHERE id=$1',[row.owner_id]);
    const connection=row.active?state(row.id):{status:'disabled',error:null};
    const alert=row.active?(preloaded?preloaded.alert:await tx.get('SELECT id,opened_at,reason,notification_status FROM connection_incidents WHERE instance_id=$1 AND resolved_at IS NULL',[row.id])):null;
    return {id:row.id,name:row.name,phone:row.phone,owner_id:row.owner_id,owner_name:owner?.name,created_at:row.created_at,active:Boolean(row.active),disabled_at:row.disabled_at,disabled_by:row.disabled_by,status:connection.status,error:connection.error??null,first_connected_at:row.first_connected_at,last_connected_at:row.last_connected_at,connection_alert:alert||null,message_counts:counts,webhook_url:row.webhook_url||'',...(secret?{token:decrypt(row.token)}:{})};
  }
  async function create(actor,input,{peer_ip=''}={}){
    keys(input,['name','owner_id']);const name=text(input.name,'nome',120).trim();
    const row=await db.transaction(async tx=>{
      const user=await actorFor(tx,actor,true),owner=user.role==='admin'?(input.owner_id||user.id):user.id;
      if(input.owner_id&&user.role!=='admin'&&input.owner_id!==user.id)throw fail(403,'forbidden','Não é possível criar para outro usuário.');
      if(typeof owner!=='string')throw fail(400,'invalid_owner','Usuário não encontrado.');
      // Serialize per-owner count+insert so simultaneous requests cannot exceed the configured limit.
      await tx.get('SELECT pg_advisory_xact_lock(97311,hashtext($1))',[owner]);
      if(!await tx.get('SELECT id FROM users WHERE id=$1 AND active=1 FOR SHARE',[owner]))throw fail(400,'invalid_owner','Usuário não encontrado.');
      if((await tx.get('SELECT count(*) AS n FROM instances WHERE owner_id=$1',[owner])).n>=perOwnerLimit)throw fail(409,'instance_limit',`Limite de ${perOwnerLimit} instâncias por usuário nesta versão.`);
      const date=new Date(now()).toISOString();let inserted;
      for(let attempt=0;attempt<3&&!inserted;attempt++)inserted=await tx.get('INSERT INTO instances(id,name,token,settings,created_at,updated_at,owner_id,token_encrypted,auto_connect) VALUES($1,$2,$3,$4,$5,$5,$6,1,0) ON CONFLICT(id) DO NOTHING RETURNING *',[randomBytes(4).toString('hex'),name,encrypt(randomBytes(32).toString('hex')),'{}',date,owner]);
      if(!inserted)throw fail(503,'id_allocation_failed','Tente novamente.');
      await activity.record({instance:inserted,actor:activity.userActor(user),action:'instance_created',outcome:'success',source:'panel',after:{name,owner_id:owner},peer_ip});
      return inserted;
    });
    return serialize(row,{secret:true});
  }
  const get=async(actor,id)=>serialize((await authorized(actor,id)).row,{secret:true});
  async function list(actor,{filter='active',dashboard=false}={}){
    if(dashboard)filter='active';if(!['active','disabled','all'].includes(filter))throw fail(400,'invalid_state','Filtro de instâncias inválido.');
    return db.transaction(async tx=>{
      const user=await actorFor(tx,actor),visible=await tx.all('SELECT i.*,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE ($1::boolean OR i.owner_id=$2) ORDER BY i.created_at DESC,i.id',[user.role==='admin',user.id]);
      const totals={active:visible.filter(r=>r.active===1).length,disabled:visible.filter(r=>r.active===0).length},items=[];
      const selected=visible.filter(row=>filter==='all'||row.active===(filter==='active'?1:0)),ids=selected.map(r=>r.id),counters=new Map(ids.map(id=>[id,emptyCounts()]));
      const stats=await tx.all('SELECT instance_id,status,count(*) AS n FROM messages WHERE instance_id=ANY($1::text[]) GROUP BY instance_id,status',[ids]);
      for(const r of stats){const counts=counters.get(r.instance_id);counts[r.status]=r.n;counts.total+=r.n;}
      const alerts=await tx.all('SELECT instance_id,id,opened_at,reason,notification_status FROM connection_incidents WHERE instance_id=ANY($1::text[]) AND resolved_at IS NULL',[ids]);
      const byId=new Map(alerts.map(({instance_id,...alert})=>[instance_id,alert]));
      for(const row of selected)items.push(await serialize(row,{tx,preloaded:{counts:counters.get(row.id),alert:byId.get(row.id)}}));
      if(!dashboard)return {instances:items,totals};
      const counts={instances:items.length,disabled:totals.disabled,connected:0,queue:0,sent:0,messages:0,alerts:0};
      for(const i of items){if(i.connection_alert)counts.alerts++;if(i.status==='authenticated')counts.connected++;counts.queue+=i.message_counts.queue;counts.sent+=i.message_counts.sent;counts.messages+=i.message_counts.total;}
      return {counts,instances:items};
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  async function mutate(actor,id,action,input,operation,{peer_ip=''}={}){
    const initial=await authorized(actor,id);
    const row=await activity.run({instance:initial.row,actor:activity.userActor(initial.user),action,before:action==='instance_updated'?activity.snapshot(initial.row):{},source:'panel',peer_ip},async()=>db.transaction(async tx=>{
      const user=await actorFor(tx,actor,true),current=await tx.get('SELECT * FROM instances WHERE id=$1 FOR UPDATE',[id]);
      if(!current||!allowed(user,current))throw fail(404,'not_found','Instância não encontrada.');
      return operation(tx,current,input);
    }),result=>action==='instance_updated'?activity.snapshot(result):{token_rotated:true});
    return serialize(row,{secret:true});
  }
  const patch=(actor,id,input,metadata)=>mutate(actor,id,'instance_updated',input,async(tx,row,value)=>{
    keys(value,['name','webhook_url']);const updates=[],args=[],bind=v=>{args.push(v);return '$'+args.length;};
    if('name'in value)updates.push('name='+bind(text(value.name,'nome',120).trim()));
    if('webhook_url'in value)updates.push('webhook_url='+bind(webhookUrl(value.webhook_url)));
    if(!updates.length)throw fail(400,'invalid_field','Informe ao menos um campo para atualizar.');
    updates.push('updated_at='+bind(new Date(now()).toISOString()));
    return tx.get(`UPDATE instances SET ${updates.join(',')} WHERE id=${bind(row.id)} RETURNING *`,args);
  },metadata);
  const rotate=(actor,id,input={},metadata)=>mutate(actor,id,'token_rotated',input,async(tx,row,value)=>{
    keys(value,[]);return tx.get('UPDATE instances SET token=$1,token_encrypted=1 WHERE id=$2 RETURNING *',[encrypt(randomBytes(32).toString('hex')),row.id]);
  },metadata);
  return {create,get,list,patch,rotate,authorized,serialize};
}
