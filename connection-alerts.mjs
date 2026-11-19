import {sendAlertEmail,smtpReady} from './alert-email.mjs';

// Persisted incidents survive restarts. Retries never create a second incident.
export function createConnectionAlerts(store,{sendEmail=sendAlertEmail,mailReady=smtpReady,publicUrl,appName=()=> 'WhatsApp API',now=Date.now,intervalMs=15000,graceMs=60000,onConnectionEvent=()=>{}}={}) {
  const {db}=store;
  let stopped=false,work=null,timer,rerun=false,candidateTimer=null,stateReader=null,startupReadyAt=0;
  if(!Number.isFinite(graceMs)||graceMs<0)throw new Error('Tempo de tolerância inválido.');
  const audit=(actor,action,before,after)=>db.prepare('INSERT INTO admin_audit(created_at,actor_id,actor_name,actor_email,action,before_value,after_value) VALUES(?,?,?,?,?,?,?)').run(new Date(now()).toISOString(),actor.id,actor.name,actor.email,action,JSON.stringify(before),JSON.stringify(after));
  const settings=()=>db.prepare('SELECT alert_email,updated_at,updated_by FROM general_settings WHERE id=1').get();
  const safeError=e=>/^[A-Z0-9_]{1,50}$/.test(e?.code||'')?e.code:'SMTP_ERROR';
  const event=(id,kind,details={},at=null)=>{const time=at||new Date(now()).toISOString();db.prepare('INSERT INTO connection_incident_events(incident_id,created_at,kind,details) VALUES(?,?,?,?)').run(id,time,kind,JSON.stringify(details));db.prepare('UPDATE connection_incidents SET last_event_at=? WHERE id=?').run(time,id);};
  const context=metadata=>({source:['whatsapp','manual_disconnect','startup_reconcile','transport_start'].includes(metadata?.source)?metadata.source:'unknown',code:Number.isInteger(metadata?.code)?metadata.code:null,reconnect_attempt:Number.isInteger(metadata?.reconnectAttempt)&&metadata.reconnectAttempt>=0?metadata.reconnectAttempt:0});
  function updateEmail(actor,value){
    db.exec('BEGIN');try{
      const old=settings();
      db.prepare('UPDATE general_settings SET alert_email=?,updated_at=?,updated_by=? WHERE id=1').run(value,new Date(now()).toISOString(),actor.id);
      audit(actor,'alert_email_updated',{alert_email:old.alert_email},{alert_email:value});
      for(const row of db.prepare("SELECT id FROM connection_incidents WHERE resolved_at IS NULL AND notification_status IN ('blocked','error','failed')").all())event(row.id,'email_requeued',{recipient:value,actor_name:actor.name});
      // A corrected destination can receive still-open incidents that failed before.
      db.prepare("UPDATE connection_incidents SET notification_status='pending',attempts=0,next_attempt_at=0,last_error='' WHERE resolved_at IS NULL AND notification_status IN ('blocked','error','failed')").run();
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    void drain();return settings();
  }
  function confirmedState(id,status,reason='Conexão interrompida.',metadata={},candidate=null){
    if(stopped)return;
    let instance=db.prepare('SELECT i.*,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=?').get(id);if(!instance||!instance.active)return;
    if(candidate)instance={...instance,...JSON.parse(candidate.snapshot)};
    const time=new Date(now()).toISOString(),info=context(metadata);
    db.exec('BEGIN');try{
      let incident=db.prepare('SELECT * FROM connection_incidents WHERE instance_id=? AND resolved_at IS NULL').get(id);
      if(status==='authenticated'){
        db.prepare('UPDATE instances SET first_connected_at=COALESCE(first_connected_at,?),last_connected_at=? WHERE id=?').run(time,time,id);
        if(incident){
          event(incident.id,'reconnected',{status,source:info.source});
          if(['pending','blocked','error','failed'].includes(incident.notification_status))event(incident.id,'email_cancelled',{reason:'Conexão restabelecida antes de iniciar o próximo envio.'});
          db.prepare("UPDATE connection_incidents SET resolved_at=?,resolution_reason='reconnected',notification_status=CASE WHEN notification_status IN ('pending','blocked','error','failed') THEN 'cancelled' ELSE notification_status END WHERE id=?").run(time,incident.id);
        }
      }else if(instance.first_connected_at&&['disconnected','retrying','qr'].includes(status)){
        if(!incident){
          const deployment=/^[a-f0-9-]{1,64}$/i.test(process.env.RAILWAY_DEPLOYMENT_ID||'')?process.env.RAILWAY_DEPLOYMENT_ID:'';
          const commit=/^[a-f0-9]{7,40}$/i.test(process.env.RAILWAY_GIT_COMMIT_SHA||'')?process.env.RAILWAY_GIT_COMMIT_SHA:'';
          const inserted=db.prepare("INSERT INTO connection_incidents(instance_id,opened_at,reason,instance_name,instance_phone,owner_name,source,disconnect_code,last_connected_at,capture_version,deployment_id,app_commit) VALUES(?,?,?,?,?,?,?,?,?,'v2',?,?)").run(id,candidate?.opened_at||time,String(reason).slice(0,500),instance.name,instance.phone,instance.owner_name||'',info.source,info.code,instance.last_connected_at,deployment,commit);
          incident={id:Number(inserted.lastInsertRowid)};
          event(incident.id,'outage_opened',{status,reason:String(reason).slice(0,500),...info},candidate?.opened_at);
          if(candidate){
            for(const entry of JSON.parse(candidate.events))event(incident.id,'connection_update',entry.details,entry.at);
            db.prepare('UPDATE connection_incidents SET reconnect_attempts=? WHERE id=?').run(candidate.reconnect_attempts,incident.id);
            event(incident.id,'outage_confirmed',{grace_seconds:graceMs/1000,detected_at:candidate.opened_at});
          }
        }else event(incident.id,'connection_update',{status,reason:String(reason).slice(0,500),...info});
        db.prepare('UPDATE connection_incidents SET disconnect_code=COALESCE(disconnect_code,?),reconnect_attempts=reconnect_attempts+? WHERE id=?').run(info.code,status==='retrying'?1:0,incident.id);
      }
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  function clearCandidate(id){db.prepare('DELETE FROM connection_candidates WHERE instance_id=?').run(id);}
  function armCandidateTimer(){
    clearTimeout(candidateTimer);candidateTimer=null;if(stopped)return;
    const next=db.prepare('SELECT min(due_at) AS due FROM connection_candidates').get()?.due;
    if(next!==null&&next!==undefined){candidateTimer=setTimeout(()=>{void drain();},Math.max(1,Math.min(2147483647,Math.max(next,startupReadyAt)-now())));candidateTimer.unref();}
  }
  function promote(candidate){
    if(db.prepare('SELECT active FROM instances WHERE id=?').get(candidate.instance_id)?.active!==1){clearCandidate(candidate.instance_id);return;}
    confirmedState(candidate.instance_id,'disconnected',candidate.reason,JSON.parse(candidate.metadata),candidate);
    clearCandidate(candidate.instance_id);
    onConnectionEvent(candidate.instance_id,'disconnected',candidate.reason,{...JSON.parse(candidate.metadata),detected_at:candidate.opened_at,grace_seconds:graceMs/1000});
  }
  function promoteDue(){
    if(now()<startupReadyAt)return;
    for(const candidate of db.prepare('SELECT * FROM connection_candidates WHERE due_at<=? ORDER BY due_at').all(now())){
      if(stateReader?.(candidate.instance_id)?.status==='authenticated'){clearCandidate(candidate.instance_id);continue;}
      promote(candidate);
    }
  }
  function stateChanged(id,status,reason='Conexão interrompida.',metadata={}){
    if(stopped)return;
    const instance=db.prepare('SELECT i.*,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=?').get(id);if(!instance||!instance.active)return;
    const candidate=db.prepare('SELECT * FROM connection_candidates WHERE instance_id=?').get(id);
    let incident=db.prepare('SELECT id FROM connection_incidents WHERE instance_id=? AND resolved_at IS NULL').get(id);
    if(status==='authenticated'){
      if(candidate&&!incident&&now()>=candidate.due_at){promote(candidate);incident=db.prepare('SELECT id FROM connection_incidents WHERE instance_id=? AND resolved_at IS NULL').get(id);}
      clearCandidate(id);confirmedState(id,status,reason,metadata);
      const quiet=Boolean(candidate&&!incident&&!metadata.auditContext);
      if(metadata.source!=='startup_reconcile'||candidate||incident)onConnectionEvent(id,status,reason,{...metadata,suppressConnectionEvent:quiet});
    }else if(instance.first_connected_at&&['disconnected','retrying','qr'].includes(status)){
      const terminal=metadata.source==='manual_disconnect'||metadata.terminal===true||[401,440].includes(metadata.code)||status==='qr';
      if(incident||terminal||graceMs===0){
        clearCandidate(id);confirmedState(id,status,reason,metadata,candidate);if(metadata.source!=='startup_reconcile'||!incident)onConnectionEvent(id,status,reason,metadata);void drain();
      }else{
        const info=context(metadata),at=new Date(now()).toISOString();
        if(candidate){
          const entries=JSON.parse(candidate.events);entries.push({at,details:{status,reason:String(reason).slice(0,500),...info}});
          db.prepare('UPDATE connection_candidates SET events=?,reconnect_attempts=reconnect_attempts+? WHERE instance_id=?').run(JSON.stringify(entries.slice(-100)),status==='retrying'?1:0,id);
        }else{
          const snapshot={name:instance.name,phone:instance.phone,owner_name:instance.owner_name||'',last_connected_at:instance.last_connected_at};
          db.prepare('INSERT INTO connection_candidates(instance_id,opened_at,due_at,reason,metadata,snapshot,reconnect_attempts) VALUES(?,?,?,?,?,?,?)').run(id,at,now()+graceMs,String(reason).slice(0,500),JSON.stringify(info),JSON.stringify(snapshot),status==='retrying'?1:0);
        }
      }
    }else if(metadata.auditContext)onConnectionEvent(id,status,reason,metadata);
    armCandidateTimer();
  }
  function drain(){
    if(stopped)return Promise.resolve();if(work){rerun=true;return work;}
    work=(async()=>{
      promoteDue();
      const pending=db.prepare("SELECT * FROM connection_incidents WHERE resolved_at IS NULL AND notification_status IN ('pending','error','blocked') AND next_attempt_at<=? AND EXISTS(SELECT 1 FROM instances i WHERE i.id=connection_incidents.instance_id AND i.active=1) ORDER BY id LIMIT 20").all(now());
      for(const incident of pending){
        if(stopped)break;
        if(!db.prepare('SELECT id FROM connection_incidents WHERE id=? AND resolved_at IS NULL').get(incident.id))continue;
        const to=settings().alert_email;
        if(!to||!mailReady()){
          const code=to?'SMTP_NOT_CONFIGURED':'ALERT_EMAIL_NOT_CONFIGURED';
          if(incident.notification_status!=='blocked'||incident.last_error!==code)event(incident.id,'email_blocked',{code});
          db.prepare("UPDATE connection_incidents SET notification_status='blocked',last_error=?,next_attempt_at=? WHERE id=?").run(code,now()+60000,incident.id);continue;
        }
        const instance=db.prepare('SELECT i.id,i.name,i.phone,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=?').get(incident.instance_id);
        db.prepare("UPDATE connection_incidents SET notification_status='sending',recipient=?,attempts=attempts+1 WHERE id=?").run(to,incident.id);
        event(incident.id,'email_attempt',{recipient:to,attempt:incident.attempts+1});
        try{
          const captured={...instance,name:incident.instance_name||instance.name,phone:incident.instance_phone||instance.phone,owner_name:incident.owner_name||instance.owner_name};
          const result=await sendEmail({to,instance:captured,incident,appName:appName(),publicUrl});
          db.prepare("UPDATE connection_incidents SET notification_status='sent',message_id=?,email_sent_at=?,last_error='' WHERE id=?").run(result?.messageId||'',new Date(now()).toISOString(),incident.id);
          event(incident.id,'email_sent',{recipient:to,message_id:result?.messageId||''});
        }catch(e){
          const attempts=incident.attempts+1;
          db.prepare("UPDATE connection_incidents SET notification_status=?,last_error=?,next_attempt_at=? WHERE id=?").run(attempts>=5?'failed':'error',safeError(e),now()+Math.min(60000*2**(attempts-1),1800000),incident.id);
          event(incident.id,'email_failed',{recipient:to,attempt:attempts,code:safeError(e),will_retry:attempts<5});
        }
      }
    })().catch(()=>console.error('[connection-alerts] Falha ao processar fila de alertas.')).finally(()=>{work=null;armCandidateTimer();if(rerun&&!stopped){rerun=false;return drain();}});
    return work;
  }
  // An interrupted SMTP send is ambiguous: keep it visible, never silently duplicate it.
  for(const row of db.prepare("SELECT id FROM connection_incidents WHERE notification_status='sending'").all())event(row.id,'email_unknown',{code:'PROCESS_INTERRUPTED_DURING_SMTP'});
  db.prepare("UPDATE connection_incidents SET notification_status='unknown',last_error='PROCESS_INTERRUPTED_DURING_SMTP' WHERE notification_status='sending'").run();
  async function sendTest(actor){
    const to=settings().alert_email;
    if(!to)throw Object.assign(new Error('Cadastre o e-mail de alerta antes de testar.'),{status:400,code:'alert_email_missing'});
    const last=db.prepare("SELECT created_at FROM admin_audit WHERE action='alert_email_test_requested' ORDER BY id DESC LIMIT 1").get();
    if(last&&now()-Date.parse(last.created_at)<60000)throw Object.assign(new Error('Aguarde um minuto antes de enviar outro teste.'),{status:429,code:'rate_limited'});
    audit(actor,'alert_email_test_requested',{}, {recipient:to});
    try{await sendEmail({to,test:true,appName:appName(),publicUrl});audit(actor,'alert_email_test_sent',{}, {recipient:to});}
    catch(e){audit(actor,'alert_email_test_failed',{}, {recipient:to,code:safeError(e)});throw Object.assign(new Error('Não foi possível enviar o teste. Confira o SMTP e o histórico de alertas.'),{status:502,code:'email_test_failed'});}
  }
  function reconcile(state){for(const row of db.prepare('SELECT id FROM instances WHERE first_connected_at IS NOT NULL AND active=1').all()){const status=state(row.id).status;if(status==='authenticated')stateChanged(row.id,status,'Conexão confirmada após iniciar o servidor.',{source:'startup_reconcile'});else stateChanged(row.id,'disconnected','A instância não restabeleceu a conexão após iniciar o servidor.',{source:'startup_reconcile'});}}
  function deactivate(id){
    db.exec('BEGIN');try{
      clearCandidate(id);
      const incident=db.prepare('SELECT id FROM connection_incidents WHERE instance_id=? AND resolved_at IS NULL').get(id);
      if(incident){event(incident.id,'monitoring_disabled',{reason:'Monitoramento encerrado por desativação da instância; não representa reconexão.'});db.prepare("UPDATE connection_incidents SET resolved_at=?,resolution_reason='deactivated',notification_status=CASE WHEN notification_status IN ('pending','blocked','error','failed') THEN 'cancelled' ELSE notification_status END WHERE id=?").run(new Date(now()).toISOString(),incident.id);}
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}armCandidateTimer();
  }
  function start(state){stateReader=state;startupReadyAt=now()+60000;timer=setInterval(()=>{void drain();},intervalMs);timer.unref();if(state){const startup=setTimeout(()=>{if(!stopped){reconcile(state);void drain();}},60000);startup.unref();const interval=timer;timer={stop:()=>{clearInterval(interval);clearTimeout(startup);}};}armCandidateTimer();}
  async function close(){stopped=true;clearTimeout(candidateTimer);if(timer?.stop)timer.stop();else clearInterval(timer);await work;}
  return {settings,updateEmail,stateChanged,drain,sendTest,reconcile,start,close,mailReady,deactivate};
}
