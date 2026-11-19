import {randomBytes} from 'node:crypto';
import {webhookFingerprint} from '../instance-activity.mjs';

const fail=message=>Object.assign(new Error(message),{status:400,code:'invalid_filter'});
const system={id:'',name:'Sistema',email:'',role:'system',kind:'system'};
const safeCode=value=>/^[a-zA-Z0-9_]{1,60}$/.test(value||'')?value:'operation_failed';
export function createPostgresInstanceActivity(db,{now=Date.now}={}){
  const userActor=user=>({id:user.id,name:user.name,email:user.email,role:user.role,kind:'user'});
  const apiActor=id=>({id:'api:'+id,name:'Integração da instância '+id,email:'',role:'integration',kind:'api'});
  const snapshot=row=>{
    let settings={};try{settings=JSON.parse(row.settings||'{}');}catch{}
    const allowed={};for(const key of ['sendDelay','sendDelayMax','webhook_message_received','webhook_message_create','webhook_message_ack','webhook_message_download_media'])if(Object.hasOwn(settings,key))allowed[key]=settings[key];
    return {name:row.name,owner_id:row.owner_id,active:Boolean(row.active),webhook:webhookFingerprint(row.webhook_url||''),settings:allowed};
  };
  async function record({instance,actor=system,action,outcome='observed',source='system',request_id='',before={},after={},details={},peer_ip=''}){
    const row=await db.get('INSERT INTO instance_activity(created_at,instance_id,instance_name,actor_id,actor_name,actor_email,actor_role,actor_kind,action,outcome,source,request_id,before_value,after_value,details,peer_ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id',[new Date(now()).toISOString(),instance?.id||null,instance?.name||'',actor.id||'',actor.name,actor.email||'',actor.role||'',actor.kind,action,outcome,source,request_id,JSON.stringify(before),JSON.stringify(after),JSON.stringify(details),String(peer_ip).slice(0,64)]);
    return row.id;
  }
  async function begin({instance,actor,action,source='panel',before={},details={},peer_ip=''}){
    const context={instance_id:instance?.id||null,actor,request_id:randomBytes(12).toString('hex')};
    await record({instance,actor,action,outcome:'requested',source,before,details,peer_ip,request_id:context.request_id});
    return {...context,instance,action,source,before,details,peer_ip};
  }
  const finish=(context,{after={},error,status}={})=>record({instance:context.instance,actor:context.actor,action:context.action,outcome:error?'failed':'success',source:context.source,request_id:context.request_id,before:context.before,after,details:{...context.details,...(error?{error_code:safeCode(error.code),http_status:status||error.status||500}:{})},peer_ip:context.peer_ip});
  async function run(options,operation,after=()=>({})){
    const context=await begin(options);let result;
    try{result=await operation(context);}catch(error){await finish(context,{error});throw error;}
    // A failed audit write must not label an already successful operation as failed or repeat it.
    await finish(context,{after:await after(result)});return result;
  }
  async function connectionState(id,status,reason,metadata={}){
    const action={authenticated:'connection_established',disconnected:'connection_lost',retrying:'connection_retry',qr:'connection_qr'}[status];if(!action)return;
    return db.transaction(async tx=>{
      const instance=await tx.get('SELECT * FROM instances WHERE id=$1 FOR UPDATE',[id]);if(!instance)return;
      const context=metadata.auditContext?.instance_id===id?metadata.auditContext:null;
      const actor=context?.actor||system,source=context?.source||(['whatsapp','startup_reconcile','transport_start','manual_disconnect'].includes(metadata.source)?metadata.source:'system');
      const details={status,...(context?{attribution:'linked_to_connection_request'}:{}),...(reason?{reason:String(reason).slice(0,500)}:{}),...(Number.isInteger(metadata.code)?{code:metadata.code}:{}),...(Number.isInteger(metadata.reconnectAttempt)?{reconnect_attempt:metadata.reconnectAttempt}:{}),...(metadata.detected_at?{detected_at:metadata.detected_at,grace_seconds:metadata.grace_seconds}:{})};
      if(status==='authenticated'){
        const phone=typeof metadata.phone==='string'&&/^\d{6,20}$/.test(metadata.phone)?metadata.phone:(/^\d{6,20}$/.test(instance.phone)?instance.phone:'');
        const previous=instance.last_connected_phone||'';
        if(!metadata.suppressConnectionEvent||context)await record({instance,actor,action,outcome:'observed',source,request_id:context?.request_id,after:phone?{phone}:{},details});
        if(phone&&previous&&phone!==previous)await record({instance,actor,action:'connection_number_changed',outcome:'observed',source,request_id:context?.request_id,before:{phone:previous},after:{phone},details:{attribution:context?'linked_to_connection_request':'system_observation'}});
        if(phone)await tx.run('UPDATE instances SET last_connected_phone=$1 WHERE id=$2',[phone,id]);
      }else await record({instance,actor,action,outcome:'observed',source,request_id:context?.request_id,details});
    });
  }
  async function list(params=new URLSearchParams(),instanceId=null){
    const page=Number(params.get('page')||1),limit=Number(params.get('limit')||25);
    if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Paginação inválida.');
    const conditions=[],args=[],bind=value=>{args.push(value);return '$'+args.length;};
    const instance=instanceId||params.get('instance_id')||'',actor=params.get('actor_id')||'',action=params.get('action')||'',outcome=params.get('outcome')||'',kind=params.get('actor_kind')||'';
    if(instance){if(!/^[a-f0-9]{8}$/.test(instance))throw fail('Instância inválida.');conditions.push('instance_id='+bind(instance));}
    if(actor){if(actor.length>80)throw fail('Usuário inválido.');conditions.push('actor_id='+bind(actor));}
    if(action){if(!/^[a-zA-Z0-9_.]{1,100}$/.test(action))throw fail('Ação inválida.');conditions.push('action='+bind(action));}
    if(outcome){if(!['requested','success','failed','observed','denied'].includes(outcome))throw fail('Resultado inválido.');conditions.push('outcome='+bind(outcome));}
    if(kind){if(!['user','api','system','legacy'].includes(kind))throw fail('Origem inválida.');conditions.push('actor_kind='+bind(kind));}
    const from=params.get('from')||'',to=params.get('to')||'';
    const boundary=(value,end=false)=>{const date=new Date(value+'T00:00:00-03:00');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw fail('Data inválida.');return new Date(date.getTime()+(end?86400000:0)).toISOString();};
    if(from)conditions.push('created_at>='+bind(boundary(from)));if(to)conditions.push('created_at<'+bind(boundary(to,true)));if(from&&to&&from>to)throw fail('Intervalo de datas inválido.');
    const where=conditions.length?conditions.join(' AND '):'TRUE';
    return db.transaction(async tx=>{
      const total=(await tx.get('SELECT count(*) AS n FROM instance_activity WHERE '+where,args)).n;
      const events=(await tx.all(`SELECT * FROM instance_activity WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${args.length+1} OFFSET $${args.length+2}`,[...args,limit,(page-1)*limit])).map(e=>({...e,before:JSON.parse(e.before_value),after:JSON.parse(e.after_value),details:JSON.parse(e.details),before_value:undefined,after_value:undefined}));
      const scope=instanceId?' WHERE instance_id=$1':'',scopeArgs=instanceId?[instanceId]:[];
      const actors=await tx.all('SELECT actor_id AS id,MAX(actor_name) AS name,MAX(actor_email) AS email FROM instance_activity'+(instanceId?" WHERE instance_id=$1 AND actor_id<>''":" WHERE actor_id<>''")+' GROUP BY actor_id ORDER BY name',scopeArgs);
      const actions=(await tx.all('SELECT DISTINCT action FROM instance_activity'+scope+' ORDER BY action',scopeArgs)).map(r=>r.action);
      const instances=instanceId?[]:await tx.all('SELECT a.instance_id AS id,COALESCE(i.name,MAX(a.instance_name)) AS name FROM instance_activity a LEFT JOIN instances i ON i.id=a.instance_id WHERE a.instance_id IS NOT NULL GROUP BY a.instance_id,i.name ORDER BY name');
      return {events,total,page,limit,pages:Math.ceil(total/limit),actors,actions,instances,time_zone:'America/Sao_Paulo'};
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  return {record,begin,finish,run,snapshot,userActor,apiActor,connectionState,list};
}
