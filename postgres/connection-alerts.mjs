import {sendAlertEmail,smtpReady} from '../alert-email.mjs';
import {createSerialTasks} from './serial-tasks.mjs';
import {fail,text} from './validation.mjs';

export function createPostgresConnectionAlerts(store,{sendEmail=sendAlertEmail,mailReady=smtpReady,publicUrl,appName=()=> 'WhatsApp API',now=Date.now,intervalMs=15000,graceMs=60000,onConnectionEvent=async()=>{}}={}){
  const {db}=store,serial=createSerialTasks();
  if(!Number.isFinite(graceMs)||graceMs<0||!Number.isFinite(intervalMs)||intervalMs<10)throw new Error('INVALID_ALERT_INTERVAL');
  let stopped=false,work=null,rerun=false,candidateTimer=null,interval=null,startup=null,stateReader=null,startupReadyAt=0,scheduleVersion=0;
  const logFailure=()=>console.error('[connection-alerts] Falha ao processar alertas.');
  const fire=promise=>{void promise.catch(logFailure);};
  const context=m=>({source:['whatsapp','manual_disconnect','startup_reconcile','transport_start'].includes(m?.source)?m.source:'unknown',code:Number.isInteger(m?.code)?m.code:null,reconnect_attempt:Number.isInteger(m?.reconnectAttempt)&&m.reconnectAttempt>=0?m.reconnectAttempt:0});
  const safeCode=e=>/^[A-Z0-9_]{1,50}$/.test(e?.code||'')?e.code:'SMTP_ERROR';
  const settings=()=>db.get('SELECT alert_email,updated_at,updated_by FROM general_settings WHERE id=1');
  const audit=(tx,actor,action,before,after)=>tx.run('INSERT INTO admin_audit(created_at,actor_id,actor_name,actor_email,action,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7)',[new Date(now()).toISOString(),actor.id,actor.name,actor.email,action,JSON.stringify(before),JSON.stringify(after)]);
  async function requireAdmin(tx,actor){const row=await tx.get('SELECT * FROM users WHERE id=$1 AND active=1 FOR SHARE',[actor?.id||'']);if(row?.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');return row;}
  async function event(tx,id,kind,details={},at=null){
    const time=at||new Date(now()).toISOString();await tx.run('INSERT INTO connection_incident_events(incident_id,created_at,kind,details) VALUES($1,$2,$3,$4)',[id,time,kind,JSON.stringify(details)]);await tx.run('UPDATE connection_incidents SET last_event_at=$1 WHERE id=$2',[time,id]);
  }
  async function armTimer(minimumDelay=1){
    const version=++scheduleVersion;clearTimeout(candidateTimer);candidateTimer=null;if(stopped)return;
    const next=(await db.get('SELECT min(due_at) AS due FROM connection_candidates')).due;
    if(stopped||version!==scheduleVersion||next===null)return;
    candidateTimer=setTimeout(()=>{fire(drain());},Math.max(minimumDelay,Math.min(2147483647,Math.max(next,startupReadyAt)-now())));candidateTimer.unref();
  }
  async function confirm(tx,instance,status,reason,metadata,candidate=null){
    const time=new Date(now()).toISOString(),info=context(metadata);
    let incident=await tx.get('SELECT * FROM connection_incidents WHERE instance_id=$1 AND resolved_at IS NULL FOR UPDATE',[instance.id]);
    if(status==='authenticated'){
      await tx.run('UPDATE instances SET first_connected_at=COALESCE(first_connected_at,$1),last_connected_at=$1 WHERE id=$2',[time,instance.id]);
      if(incident){
        await event(tx,incident.id,'reconnected',{status,source:info.source});
        if(['pending','blocked','error','failed'].includes(incident.notification_status))await event(tx,incident.id,'email_cancelled',{reason:'Conexão restabelecida antes de iniciar o próximo envio.'});
        await tx.run("UPDATE connection_incidents SET resolved_at=$1,resolution_reason='reconnected',notification_status=CASE WHEN notification_status IN ('pending','blocked','error','failed') THEN 'cancelled' ELSE notification_status END WHERE id=$2",[time,incident.id]);
      }
    }else if(instance.first_connected_at){
      if(!incident){
        const snapshot=candidate?JSON.parse(candidate.snapshot):instance;
        const deployment=/^[a-f0-9-]{1,64}$/i.test(process.env.RAILWAY_DEPLOYMENT_ID||'')?process.env.RAILWAY_DEPLOYMENT_ID:'';
        const commit=/^[a-f0-9]{7,40}$/i.test(process.env.RAILWAY_GIT_COMMIT_SHA||'')?process.env.RAILWAY_GIT_COMMIT_SHA:'';
        incident=await tx.get("INSERT INTO connection_incidents(instance_id,opened_at,reason,instance_name,instance_phone,owner_name,source,disconnect_code,last_connected_at,capture_version,deployment_id,app_commit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'v2',$10,$11) RETURNING *",[instance.id,candidate?.opened_at||time,String(reason).slice(0,500),snapshot.name,snapshot.phone,snapshot.owner_name||'',info.source,info.code,snapshot.last_connected_at,deployment,commit]);
        await event(tx,incident.id,'outage_opened',{status,reason:String(reason).slice(0,500),...info},candidate?.opened_at);
        if(candidate){
          for(const e of JSON.parse(candidate.events))await event(tx,incident.id,'connection_update',e.details,e.at);
          await tx.run('UPDATE connection_incidents SET reconnect_attempts=$1 WHERE id=$2',[candidate.reconnect_attempts,incident.id]);
          await event(tx,incident.id,'outage_confirmed',{grace_seconds:graceMs/1000,detected_at:candidate.opened_at});
        }
      }else await event(tx,incident.id,'connection_update',{status,reason:String(reason).slice(0,500),...info});
      await tx.run('UPDATE connection_incidents SET disconnect_code=COALESCE(disconnect_code,$1),reconnect_attempts=reconnect_attempts+$2 WHERE id=$3',[info.code,status==='retrying'?1:0,incident.id]);
    }
  }
  const clear=(tx,id)=>tx.run('DELETE FROM connection_candidates WHERE instance_id=$1',[id]);
  async function processState(id,status,reason,metadata,{dueOnly=false}={}){
    if(stopped)return;
    const notifications=[];
    await db.transaction(async tx=>{
      const instance=await tx.get('SELECT i.*,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=$1 FOR UPDATE OF i',[id]);
      if(!instance||!instance.active){if(dueOnly)await clear(tx,id);return;}
      const candidate=await tx.get('SELECT * FROM connection_candidates WHERE instance_id=$1',[id]);
      let incident=await tx.get('SELECT id FROM connection_incidents WHERE instance_id=$1 AND resolved_at IS NULL',[id]);
      const promote=async()=>{
        await confirm(tx,instance,'disconnected',candidate.reason,JSON.parse(candidate.metadata),candidate);await clear(tx,id);
        notifications.push([id,'disconnected',candidate.reason,{...JSON.parse(candidate.metadata),detected_at:candidate.opened_at,grace_seconds:graceMs/1000}]);
      };
      if(dueOnly){
        if(!candidate||candidate.due_at>now()||now()<startupReadyAt)return;
        if(stateReader?.(id)?.status==='authenticated'){await clear(tx,id);return;}
        await promote();return;
      }
      if(status==='authenticated'){
        if(candidate&&!incident&&now()>=candidate.due_at){await promote();incident=await tx.get('SELECT id FROM connection_incidents WHERE instance_id=$1 AND resolved_at IS NULL',[id]);}
        await clear(tx,id);await confirm(tx,instance,status,reason,metadata);
        const quiet=Boolean(candidate&&!incident&&!metadata.auditContext);
        if(metadata.source!=='startup_reconcile'||candidate||incident)notifications.push([id,status,reason,{...metadata,suppressConnectionEvent:quiet}]);
      }else if(instance.first_connected_at&&['disconnected','retrying','qr'].includes(status)){
        const terminal=metadata.source==='manual_disconnect'||metadata.terminal===true||[401,440].includes(metadata.code)||status==='qr';
        if(incident||terminal||graceMs===0){
          await clear(tx,id);await confirm(tx,instance,status,reason,metadata,candidate);
          if(metadata.source!=='startup_reconcile'||!incident)notifications.push([id,status,reason,metadata]);
        }else{
          const info=context(metadata),time=new Date(now()).toISOString();
          if(candidate){
            const entries=JSON.parse(candidate.events);entries.push({at:time,details:{status,reason:String(reason).slice(0,500),...info}});
            await tx.run('UPDATE connection_candidates SET events=$1,reconnect_attempts=reconnect_attempts+$2 WHERE instance_id=$3',[JSON.stringify(entries.slice(-100)),status==='retrying'?1:0,id]);
          }else{
            const snapshot={name:instance.name,phone:instance.phone,owner_name:instance.owner_name||'',last_connected_at:instance.last_connected_at};
            await tx.run('INSERT INTO connection_candidates(instance_id,opened_at,due_at,reason,metadata,snapshot,reconnect_attempts) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,time,now()+graceMs,String(reason).slice(0,500),JSON.stringify(info),JSON.stringify(snapshot),status==='retrying'?1:0]);
          }
        }
      }else if(metadata.auditContext)notifications.push([id,status,reason,metadata]);
    });
    // Auditing may itself use a transaction; never call it while the state transaction is open.
    for(const args of notifications)await onConnectionEvent(...args);
  }
  async function stateChanged(id,status,reason='Conexão interrompida.',metadata={}){
    if(stopped)return;
    await serial.run(id,()=>processState(id,status,reason,metadata));await armTimer();
    if(status!=='authenticated')fire(drain());
  }
  async function promoteDue(){
    if(now()<startupReadyAt)return;
    for(const c of await db.all('SELECT instance_id FROM connection_candidates WHERE due_at<=$1 ORDER BY due_at',[now()]))await serial.run(c.instance_id,()=>processState(c.instance_id,'disconnected','',{}, {dueOnly:true}));
  }
  async function claim(id){
    return db.transaction(async tx=>{
      const target=await tx.get('SELECT instance_id FROM connection_incidents WHERE id=$1',[id]);if(!target)return null;
      const instance=await tx.get('SELECT i.*,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=$1 FOR UPDATE OF i',[target.instance_id]);if(!instance?.active)return null;
      const incident=await tx.get("SELECT * FROM connection_incidents WHERE id=$1 AND resolved_at IS NULL AND notification_status IN ('pending','error','blocked') AND next_attempt_at<=$2 FOR UPDATE",[id,now()]);if(!incident)return null;
      const to=(await tx.get('SELECT alert_email FROM general_settings WHERE id=1'))?.alert_email;
      if(!to||!mailReady()){
        const code=to?'SMTP_NOT_CONFIGURED':'ALERT_EMAIL_NOT_CONFIGURED';
        if(incident.notification_status!=='blocked'||incident.last_error!==code)await event(tx,id,'email_blocked',{code});
        await tx.run("UPDATE connection_incidents SET notification_status='blocked',last_error=$1,next_attempt_at=$2 WHERE id=$3",[code,now()+60000,id]);return null;
      }
      await tx.run("UPDATE connection_incidents SET notification_status='sending',recipient=$1,attempts=attempts+1 WHERE id=$2",[to,id]);
      await event(tx,id,'email_attempt',{recipient:to,attempt:incident.attempts+1});
      return {to,incident,instance:{id:instance.id,name:incident.instance_name||instance.name,phone:incident.instance_phone||instance.phone,owner_name:incident.owner_name||instance.owner_name}};
    });
  }
  async function finishMail(mail,error,result){
    await db.transaction(async tx=>{
      const current=await tx.get("SELECT * FROM connection_incidents WHERE id=$1 AND notification_status='sending' FOR UPDATE",[mail.incident.id]);if(!current)return;
      if(!error){
        await tx.run("UPDATE connection_incidents SET notification_status='sent',message_id=$1,email_sent_at=$2,last_error='' WHERE id=$3",[result?.messageId||'',new Date(now()).toISOString(),current.id]);
        await event(tx,current.id,'email_sent',{recipient:mail.to,message_id:result?.messageId||''});
      }else{
        const retry=current.attempts<5&&!current.resolved_at;
        await tx.run('UPDATE connection_incidents SET notification_status=$1,last_error=$2,next_attempt_at=$3 WHERE id=$4',[retry?'error':'failed',safeCode(error),now()+Math.min(60000*2**(current.attempts-1),1800000),current.id]);
        await event(tx,current.id,'email_failed',{recipient:mail.to,attempt:current.attempts,code:safeCode(error),will_retry:retry});
      }
    });
  }
  function drain(){
    if(stopped)return Promise.resolve();if(work){rerun=true;return work;}
    let failed=false;
    work=(async()=>{
      await promoteDue();
      const pending=await db.all("SELECT id FROM connection_incidents WHERE resolved_at IS NULL AND notification_status IN ('pending','error','blocked') AND next_attempt_at<=$1 AND EXISTS(SELECT 1 FROM instances i WHERE i.id=connection_incidents.instance_id AND i.active=1) ORDER BY id LIMIT 20",[now()]);
      for(const row of pending){
        if(stopped)break;const mail=await claim(row.id);if(!mail)continue;
        let result,error;try{result=await sendEmail({...mail,appName:await appName(),publicUrl});}catch(e){error=e;}
        // A persistence failure here leaves 'sending' ambiguous; it must not enter the SMTP retry path.
        await finishMail(mail,error,result);
      }
    })().catch(()=>{failed=true;logFailure();}).finally(async()=>{work=null;await armTimer(failed?intervalMs:1);if(rerun&&!stopped){rerun=false;if(!failed)return drain();}});
    return work;
  }
  async function updateEmail(actor,value){
    const raw=text(value,'email de alerta',254).trim();
    if(!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(raw))throw fail(400,'invalid_email','Informe um único endereço de e-mail válido.');
    await db.transaction(async tx=>{
      const user=await requireAdmin(tx,actor),old=await tx.get('SELECT * FROM general_settings WHERE id=1 FOR UPDATE');
      await tx.run('UPDATE general_settings SET alert_email=$1,updated_at=$2,updated_by=$3 WHERE id=1',[raw,new Date(now()).toISOString(),user.id]);
      await audit(tx,user,'alert_email_updated',{alert_email:old.alert_email},{alert_email:raw});
      for(const row of await tx.all("SELECT id FROM connection_incidents WHERE resolved_at IS NULL AND notification_status IN ('blocked','error','failed') ORDER BY id FOR UPDATE"))await event(tx,row.id,'email_requeued',{recipient:raw,actor_name:user.name});
      await tx.run("UPDATE connection_incidents SET notification_status='pending',attempts=0,next_attempt_at=0,last_error='' WHERE resolved_at IS NULL AND notification_status IN ('blocked','error','failed')");
    });fire(drain());return settings();
  }
  async function sendTest(actor){
    const reservation=await db.transaction(async tx=>{
      const user=await requireAdmin(tx,actor);await tx.get('SELECT pg_advisory_xact_lock(97312,1)');
      const to=(await tx.get('SELECT alert_email FROM general_settings WHERE id=1'))?.alert_email;if(!to)throw fail(400,'alert_email_missing','Cadastre o e-mail de alerta antes de testar.');
      const last=await tx.get("SELECT created_at FROM admin_audit WHERE action='alert_email_test_requested' ORDER BY id DESC LIMIT 1");if(last&&now()-Date.parse(last.created_at)<60000)throw fail(429,'rate_limited','Aguarde um minuto antes de enviar outro teste.');
      await audit(tx,user,'alert_email_test_requested',{}, {recipient:to});return {to,user};
    });
    let error;try{await sendEmail({to:reservation.to,test:true,appName:await appName(),publicUrl});}catch(e){error=e;}
    await audit(db,reservation.user,error?'alert_email_test_failed':'alert_email_test_sent',{}, {recipient:reservation.to,...(error?{code:safeCode(error)}:{})});
    if(error)throw fail(502,'email_test_failed','Não foi possível enviar o teste. Confira o SMTP e o histórico de alertas.');
  }
  async function deactivate(id){
    await serial.run(id,()=>db.transaction(async tx=>{
      await tx.get('SELECT id FROM instances WHERE id=$1 FOR UPDATE',[id]);await clear(tx,id);
      const incident=await tx.get('SELECT id FROM connection_incidents WHERE instance_id=$1 AND resolved_at IS NULL FOR UPDATE',[id]);
      if(incident){await event(tx,incident.id,'monitoring_disabled',{reason:'Monitoramento encerrado por desativação da instância; não representa reconexão.'});await tx.run("UPDATE connection_incidents SET resolved_at=$1,resolution_reason='deactivated',notification_status=CASE WHEN notification_status IN ('pending','blocked','error','failed') THEN 'cancelled' ELSE notification_status END WHERE id=$2",[new Date(now()).toISOString(),incident.id]);}
    }));await armTimer();
  }
  // Explicit startup step after session ownership is acquired; never run while another owner sends SMTP.
  async function recoverInterrupted(){
    await db.transaction(async tx=>{
      for(const row of await tx.all("SELECT id FROM connection_incidents WHERE notification_status='sending' ORDER BY id FOR UPDATE")){await event(tx,row.id,'email_unknown',{code:'PROCESS_INTERRUPTED_DURING_SMTP'});await tx.run("UPDATE connection_incidents SET notification_status='unknown',last_error='PROCESS_INTERRUPTED_DURING_SMTP' WHERE id=$1",[row.id]);}
    });
  }
  async function reconcile(state){for(const row of await db.all('SELECT id FROM instances WHERE first_connected_at IS NOT NULL AND active=1')){const status=state(row.id).status;await stateChanged(row.id,status==='authenticated'?status:'disconnected',status==='authenticated'?'Conexão confirmada após iniciar o servidor.':'A instância não restabeleceu a conexão após iniciar o servidor.',{source:'startup_reconcile'});}}
  async function start(state){
    if(stopped||interval)return;stateReader=state;startupReadyAt=now()+60000;
    interval=setInterval(()=>fire(drain()),intervalMs);interval.unref();
    if(state){startup=setTimeout(()=>{if(!stopped)fire(reconcile(state).then(()=>drain()));},60000);startup.unref();}await armTimer();
  }
  async function close(){stopped=true;scheduleVersion++;clearTimeout(candidateTimer);clearTimeout(startup);clearInterval(interval);await serial.idle();await work;}
  return {settings,updateEmail,stateChanged,drain,sendTest,reconcile,start,close,deactivate,recoverInterrupted,mailReady};
}
