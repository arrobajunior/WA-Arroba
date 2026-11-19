const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===404?'not_found':'invalid_filter'});
const mailStates=['pending','blocked','sending','sent','error','failed','unknown','cancelled'];
function pageValues(params){
  const page=Number(params.get('page')||1),limit=Number(params.get('limit')||25);
  if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Paginação inválida.');return {page,limit};
}
function dayBoundary(value,extraDay=0){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('Informe as datas no formato AAAA-MM-DD.');
  const date=new Date(`${value}T00:00:00-03:00`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw fail('Data inválida.');
  return new Date(date.getTime()+extraDay*86400000).toISOString();
}
export function createPostgresIncidentHistory(db,{now=Date.now}={}){
  async function list(params=new URLSearchParams()){
    const {page,limit}=pageValues(params),conditions=[],args=[];
    const bind=value=>{args.push(value);return '$'+args.length;};
    const instance=params.get('instance_id')||'',status=params.get('status')||'all',emailStatus=params.get('email_status')||'all',from=params.get('from')||'',to=params.get('to')||'',kind=params.get('kind')||'confirmed';
    if(!['confirmed','transient','all'].includes(kind))throw fail('Classificação inválida.');
    if(kind!=='all')conditions.push('c.outage_kind='+bind(kind));
    if(instance){if(!/^[a-f0-9]{8}$/.test(instance))throw fail('Instância inválida.');conditions.push('c.instance_id='+bind(instance));}
    if(!['all','open','resolved','deactivated'].includes(status))throw fail('Situação de conexão inválida.');
    if(status!=='all')conditions.push(status==='open'?'c.resolved_at IS NULL':status==='deactivated'?"c.resolved_at IS NOT NULL AND c.resolution_reason='deactivated'":"c.resolved_at IS NOT NULL AND c.resolution_reason<>'deactivated'");
    if(emailStatus!=='all'){if(!mailStates.includes(emailStatus))throw fail('Situação de e-mail inválida.');conditions.push('c.notification_status='+bind(emailStatus));}
    if(from)conditions.push('c.opened_at>='+bind(dayBoundary(from)));
    if(to)conditions.push('c.opened_at<'+bind(dayBoundary(to,1)));
    if(from&&to&&from>to)throw fail('A data inicial não pode ser posterior à final.');
    const where=conditions.length?conditions.join(' AND '):'TRUE',generated=new Date(now()).toISOString();
    return db.transaction(async tx=>{
      const summary=await tx.get(`SELECT count(*) AS total,count(*) FILTER(WHERE c.resolved_at IS NULL) AS open,count(*) FILTER(WHERE c.resolved_at IS NOT NULL AND c.resolution_reason<>'deactivated') AS resolved,count(*) FILTER(WHERE c.resolution_reason='deactivated') AS deactivated,count(*) FILTER(WHERE c.notification_status='sent') AS emails_sent,count(*) FILTER(WHERE c.notification_status IN ('error','failed','unknown')) AS email_issues FROM connection_incidents c WHERE ${where}`,args);
      const duration=`GREATEST(0,ROUND(EXTRACT(EPOCH FROM (COALESCE(c.resolved_at,$${args.length+1})::timestamptz-c.opened_at::timestamptz))))::bigint`;
      const incidents=await tx.all(`SELECT c.*,${duration} AS duration_seconds,(SELECT count(*) FROM connection_incident_events e WHERE e.incident_id=c.id) AS event_count FROM connection_incidents c WHERE ${where} ORDER BY c.opened_at DESC,c.id DESC LIMIT $${args.length+2} OFFSET $${args.length+3}`,[...args,generated,limit,(page-1)*limit]);
      const byInstance=await tx.all(`SELECT c.instance_id,MAX(c.instance_name) AS instance_name,count(*) AS count FROM connection_incidents c WHERE ${where} GROUP BY c.instance_id ORDER BY count DESC,c.instance_id LIMIT 5`,args);
      const byReason=await tx.all(`SELECT c.reason,c.source,c.disconnect_code,count(*) AS count FROM connection_incidents c WHERE ${where} GROUP BY c.reason,c.source,c.disconnect_code ORDER BY count DESC,c.reason LIMIT 5`,args);
      const byHour=await tx.all(`SELECT to_char(c.opened_at::timestamptz AT TIME ZONE 'America/Sao_Paulo','HH24') AS hour,count(*) AS count FROM connection_incidents c WHERE ${where} GROUP BY hour ORDER BY count DESC,hour LIMIT 5`,args);
      const instances=await tx.all('SELECT id,name FROM instances UNION SELECT instance_id AS id,instance_name AS name FROM connection_incidents WHERE instance_id NOT IN (SELECT id FROM instances) ORDER BY name');
      return {incidents,summary,patterns:{by_instance:byInstance,by_reason:byReason,by_hour:byHour},instances,page,limit,total:summary.total,pages:Math.ceil(summary.total/limit),time_zone:'America/Sao_Paulo',generated_at:generated};
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  async function detail(id,params=new URLSearchParams()){
    if(!/^\d+$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<1)throw fail('Ocorrência inválida.');
    const {page,limit}=pageValues(params);
    return db.transaction(async tx=>{
      const incident=await tx.get('SELECT * FROM connection_incidents WHERE id=$1',[Number(id)]);
      if(!incident)throw fail('Ocorrência não encontrada.',404);
      const total=(await tx.get('SELECT count(*) AS n FROM connection_incident_events WHERE incident_id=$1',[incident.id])).n;
      const events=(await tx.all('SELECT * FROM connection_incident_events WHERE incident_id=$1 ORDER BY id LIMIT $2 OFFSET $3',[incident.id,limit,(page-1)*limit])).map(e=>({...e,details:JSON.parse(e.details)}));
      const end=incident.resolved_at?Date.parse(incident.resolved_at):now();
      return {incident:{...incident,duration_seconds:Math.max(0,Math.round((end-Date.parse(incident.opened_at))/1000))},events,page,limit,total_events:total,pages:Math.ceil(total/limit)};
    },{readOnly:true,isolation:'REPEATABLE READ'});
  }
  return {list,detail};
}
