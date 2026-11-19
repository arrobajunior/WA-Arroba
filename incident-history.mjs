const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===404?'not_found':'invalid_filter'});
const mailStates=['pending','blocked','sending','sent','error','failed','unknown','cancelled'];
function pageValues(params){const page=Number(params.get('page')||1),limit=Number(params.get('limit')||25);if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isInteger(limit)||limit<1||limit>100)throw fail('Paginação inválida.');return {page,limit};}
function dayBoundary(value,extraDay=0){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('Informe as datas no formato AAAA-MM-DD.');
  const date=new Date(`${value}T00:00:00-03:00`);
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw fail('Data inválida.');
  return new Date(date.getTime()+extraDay*86400000).toISOString();
}

export function createIncidentHistory(db,{now=Date.now}={}){
  function list(params=new URLSearchParams()){
    const {page,limit}=pageValues(params),conditions=[],args=[];
    const instance=params.get('instance_id')||'',status=params.get('status')||'all',emailStatus=params.get('email_status')||'all',from=params.get('from')||'',to=params.get('to')||'',kind=params.get('kind')||'confirmed';
    if(!['confirmed','transient','all'].includes(kind))throw fail('Classificação inválida.');
    if(kind!=='all'){conditions.push('c.outage_kind=?');args.push(kind);}
    if(instance){if(!/^[a-f0-9]{8}$/.test(instance))throw fail('Instância inválida.');conditions.push('c.instance_id=?');args.push(instance);}
    if(!['all','open','resolved','deactivated'].includes(status))throw fail('Situação de conexão inválida.');
    if(status!=='all')conditions.push(status==='open'?'c.resolved_at IS NULL':status==='deactivated'?"c.resolved_at IS NOT NULL AND c.resolution_reason='deactivated'":"c.resolved_at IS NOT NULL AND c.resolution_reason<>'deactivated'");
    if(emailStatus!=='all'){if(!mailStates.includes(emailStatus))throw fail('Situação de e-mail inválida.');conditions.push('c.notification_status=?');args.push(emailStatus);}
    if(from){conditions.push('c.opened_at>=?');args.push(dayBoundary(from));}
    if(to){conditions.push('c.opened_at<?');args.push(dayBoundary(to,1));}
    if(from&&to&&from>to)throw fail('A data inicial não pode ser posterior à final.');
    const where=conditions.length?conditions.join(' AND '):'1=1';
    const summary=db.prepare(`SELECT count(*) AS total,COALESCE(sum(c.resolved_at IS NULL),0) AS open,COALESCE(sum(c.resolved_at IS NOT NULL AND c.resolution_reason<>'deactivated'),0) AS resolved,COALESCE(sum(c.resolution_reason='deactivated'),0) AS deactivated,COALESCE(sum(c.notification_status='sent'),0) AS emails_sent,COALESCE(sum(c.notification_status IN ('error','failed','unknown')),0) AS email_issues FROM connection_incidents c WHERE ${where}`).get(...args);
    const duration="MAX(0,ROUND((julianday(COALESCE(c.resolved_at,?))-julianday(c.opened_at))*86400))";
    const incidents=db.prepare(`SELECT c.*,${duration} AS duration_seconds,(SELECT count(*) FROM connection_incident_events e WHERE e.incident_id=c.id) AS event_count FROM connection_incidents c WHERE ${where} ORDER BY c.opened_at DESC,c.id DESC LIMIT ? OFFSET ?`).all(new Date(now()).toISOString(),...args,limit,(page-1)*limit);
    const byInstance=db.prepare(`SELECT c.instance_id,MAX(c.instance_name) AS instance_name,count(*) AS count FROM connection_incidents c WHERE ${where} GROUP BY c.instance_id ORDER BY count DESC,c.instance_id LIMIT 5`).all(...args);
    const byReason=db.prepare(`SELECT c.reason,c.source,c.disconnect_code,count(*) AS count FROM connection_incidents c WHERE ${where} GROUP BY c.reason,c.source,c.disconnect_code ORDER BY count DESC,c.reason LIMIT 5`).all(...args);
    const byHour=db.prepare(`SELECT strftime('%H',c.opened_at,'-3 hours') AS hour,count(*) AS count FROM connection_incidents c WHERE ${where} AND strftime('%H',c.opened_at,'-3 hours') IS NOT NULL GROUP BY hour ORDER BY count DESC,hour LIMIT 5`).all(...args);
    const instances=db.prepare('SELECT id,name FROM instances UNION SELECT instance_id AS id,instance_name AS name FROM connection_incidents WHERE instance_id NOT IN (SELECT id FROM instances) ORDER BY name').all();
    return {incidents,summary,patterns:{by_instance:byInstance,by_reason:byReason,by_hour:byHour},instances,page,limit,total:summary.total,pages:Math.ceil(summary.total/limit),time_zone:'America/Sao_Paulo',generated_at:new Date(now()).toISOString()};
  }
  function detail(id,params=new URLSearchParams()){
    if(!/^\d+$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<1)throw fail('Ocorrência inválida.');
    const {page,limit}=pageValues(params),incident=db.prepare('SELECT * FROM connection_incidents WHERE id=?').get(Number(id));
    if(!incident)throw fail('Ocorrência não encontrada.',404);
    const total=db.prepare('SELECT count(*) AS n FROM connection_incident_events WHERE incident_id=?').get(incident.id).n;
    const events=db.prepare('SELECT * FROM connection_incident_events WHERE incident_id=? ORDER BY id LIMIT ? OFFSET ?').all(incident.id,limit,(page-1)*limit).map(e=>({...e,details:JSON.parse(e.details)}));
    const end=incident.resolved_at?Date.parse(incident.resolved_at):now();
    return {incident:{...incident,duration_seconds:Math.max(0,Math.round((end-Date.parse(incident.opened_at))/1000))},events,page,limit,total_events:total,pages:Math.ceil(total/limit)};
  }
  return {list,detail};
}
