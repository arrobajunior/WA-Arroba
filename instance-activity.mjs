import {randomBytes,createHash} from 'node:crypto';

const fail=(message)=>Object.assign(new Error(message),{status:400,code:'invalid_filter'});
const system={id:'',name:'Sistema',email:'',role:'system',kind:'system'};
const safeCode=value=>/^[a-zA-Z0-9_]{1,60}$/.test(value||'')?value:'operation_failed';
export function webhookFingerprint(value){
 if(!value)return {configured:false};
 try{const url=new URL(value);return {configured:true,origin:url.origin,fingerprint:createHash('sha256').update(value).digest('hex')};}catch{return {configured:true,origin:'URL não disponível'};}
}
export function createInstanceActivity(db,{now=Date.now}={}){
 const userActor=user=>({id:user.id,name:user.name,email:user.email,role:user.role,kind:'user'});
 const apiActor=id=>({id:'api:'+id,name:'Integração da instância '+id,email:'',role:'integration',kind:'api'});
 const snapshot=row=>{
   let settings={};try{settings=JSON.parse(row.settings||'{}');}catch{}
   const allowed={};for(const key of ['sendDelay','sendDelayMax','webhook_message_received','webhook_message_create','webhook_message_ack','webhook_message_download_media'])if(Object.hasOwn(settings,key))allowed[key]=settings[key];
   return {name:row.name,owner_id:row.owner_id,webhook:webhookFingerprint(row.webhook_url||''),settings:allowed};
 };
 function record({instance,actor=system,action,outcome='observed',source='system',request_id='',before={},after={},details={},peer_ip=''}){
   return Number(db.prepare('INSERT INTO instance_activity(created_at,instance_id,instance_name,actor_id,actor_name,actor_email,actor_role,actor_kind,action,outcome,source,request_id,before_value,after_value,details,peer_ip) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(new Date(now()).toISOString(),instance?.id||null,instance?.name||'',actor.id||'',actor.name,actor.email||'',actor.role||'',actor.kind,action,outcome,source,request_id,JSON.stringify(before),JSON.stringify(after),JSON.stringify(details),String(peer_ip).slice(0,64)).lastInsertRowid);
 }
 function begin({instance,actor,action,source='panel',before={},details={},peer_ip=''}){
   const context={instance_id:instance?.id||null,actor,request_id:randomBytes(12).toString('hex')};
   record({instance,actor,action,outcome:'requested',source,before,details,peer_ip,request_id:context.request_id});
   return {...context,instance,action,source,before,details,peer_ip};
 }
 const finish=(context,{after={},error,status}={})=>record({instance:context.instance,actor:context.actor,action:context.action,outcome:error?'failed':'success',source:context.source,request_id:context.request_id,before:context.before,after,details:{...context.details,...(error?{error_code:safeCode(error.code),http_status:status||error.status||500}:{})},peer_ip:context.peer_ip});
 async function run(options,operation,after=()=>({})){
   const context=begin(options);try{const result=await operation(context);finish(context,{after:after(result)});return result;}catch(error){finish(context,{error});throw error;}
 }
 function connectionState(id,status,reason,metadata={}){
   const instance=db.prepare('SELECT * FROM instances WHERE id=?').get(id);if(!instance)return;
   const context=metadata.auditContext?.instance_id===id?metadata.auditContext:null;
   const actor=context?.actor||system,source=context?.source||(['whatsapp','startup_reconcile','transport_start','manual_disconnect'].includes(metadata.source)?metadata.source:'system');
   const details={status,...(context?{attribution:'linked_to_connection_request'}:{}),...(reason?{reason:String(reason).slice(0,500)}:{}),...(Number.isInteger(metadata.code)?{code:metadata.code}:{}),...(Number.isInteger(metadata.reconnectAttempt)?{reconnect_attempt:metadata.reconnectAttempt}:{}),...(metadata.detected_at?{detected_at:metadata.detected_at,grace_seconds:metadata.grace_seconds}:{})};
   const action={authenticated:'connection_established',disconnected:'connection_lost',retrying:'connection_retry',qr:'connection_qr'}[status];if(!action)return;
   if(status==='authenticated'){
     const phone=typeof metadata.phone==='string'&&/^\d{6,20}$/.test(metadata.phone)?metadata.phone:(/^\d{6,20}$/.test(instance.phone)?instance.phone:'');
     const previous=instance.last_connected_phone||'';
     db.exec('BEGIN');try{
       if(!metadata.suppressConnectionEvent||context)record({instance,actor,action,outcome:'observed',source,request_id:context?.request_id,after:phone?{phone}:{},details});
       if(phone&&previous&&phone!==previous)record({instance,actor,action:'connection_number_changed',outcome:'observed',source,request_id:context?.request_id,before:{phone:previous},after:{phone},details:{attribution:context?'linked_to_connection_request':'system_observation'}});
       if(phone)db.prepare('UPDATE instances SET last_connected_phone=? WHERE id=?').run(phone,id);
       db.exec('COMMIT');
     }catch(e){db.exec('ROLLBACK');throw e;}
   }else record({instance,actor,action,outcome:'observed',source,request_id:context?.request_id,details});
 }
 function list(params=new URLSearchParams(),instanceId=null){
   const page=Number(params.get('page')||1),limit=Number(params.get('limit')||25);if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Paginação inválida.');
   const conditions=[],args=[];const instance=instanceId||params.get('instance_id')||'',actor=params.get('actor_id')||'',action=params.get('action')||'',outcome=params.get('outcome')||'',kind=params.get('actor_kind')||'';
   if(instance){if(!/^[a-f0-9]{8}$/.test(instance))throw fail('Instância inválida.');conditions.push('instance_id=?');args.push(instance);}
   if(actor){if(actor.length>80)throw fail('Usuário inválido.');conditions.push('actor_id=?');args.push(actor);}
   if(action){if(!/^[a-zA-Z0-9_.]{1,100}$/.test(action))throw fail('Ação inválida.');conditions.push('action=?');args.push(action);}
   if(outcome){if(!['requested','success','failed','observed','denied'].includes(outcome))throw fail('Resultado inválido.');conditions.push('outcome=?');args.push(outcome);}
   if(kind){if(!['user','api','system','legacy'].includes(kind))throw fail('Origem inválida.');conditions.push('actor_kind=?');args.push(kind);}
   const from=params.get('from')||'',to=params.get('to')||'';
   const boundary=(value,end=false)=>{const date=new Date(value+'T00:00:00-03:00');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw fail('Data inválida.');return new Date(date.getTime()+(end?86400000:0)).toISOString();};
   if(from){conditions.push('created_at>=?');args.push(boundary(from));}if(to){conditions.push('created_at<?');args.push(boundary(to,true));}if(from&&to&&from>to)throw fail('Intervalo de datas inválido.');
   const where=conditions.length?conditions.join(' AND '):'1=1',total=db.prepare('SELECT count(*) AS n FROM instance_activity WHERE '+where).get(...args).n;
   const events=db.prepare('SELECT * FROM instance_activity WHERE '+where+' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...args,limit,(page-1)*limit).map(e=>({...e,before:JSON.parse(e.before_value),after:JSON.parse(e.after_value),details:JSON.parse(e.details),before_value:undefined,after_value:undefined}));
   // Scope filter choices too: an instance owner must not learn about other instances' actors.
   const scope=instanceId?' WHERE instance_id=?':'',scopeArgs=instanceId?[instanceId]:[];
   const actors=db.prepare('SELECT actor_id AS id,MAX(actor_name) AS name,MAX(actor_email) AS email FROM instance_activity'+(instanceId?" WHERE instance_id=? AND actor_id<>''":" WHERE actor_id<>''")+' GROUP BY actor_id ORDER BY name').all(...scopeArgs);
   const actions=db.prepare('SELECT DISTINCT action FROM instance_activity'+scope+' ORDER BY action').all(...scopeArgs).map(r=>r.action);
   const instances=instanceId?[]:db.prepare("SELECT instance_id AS id,COALESCE((SELECT i.name FROM instances i WHERE i.id=instance_id),MAX(instance_name)) AS name FROM instance_activity WHERE instance_id IS NOT NULL GROUP BY instance_id ORDER BY name").all();
   return {events,total,page,limit,pages:Math.ceil(total/limit),actors,actions,instances,time_zone:'America/Sao_Paulo'};
 }
 return {record,begin,finish,run,snapshot,userActor,apiActor,connectionState,list};
}
