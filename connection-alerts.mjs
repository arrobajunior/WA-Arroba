import {sendAlertEmail,smtpReady} from './alert-email.mjs';

// Persisted incidents survive restarts. Retries never create a second incident.
export function createConnectionAlerts(store,{sendEmail=sendAlertEmail,mailReady=smtpReady,publicUrl,appName=()=> 'WhatsApp API',now=Date.now,intervalMs=15000}={}) {
  const {db}=store;
  let stopped=false,work=null,timer,rerun=false;
  const audit=(actor,action,before,after)=>db.prepare('INSERT INTO admin_audit(created_at,actor_id,actor_name,actor_email,action,before_value,after_value) VALUES(?,?,?,?,?,?,?)').run(new Date(now()).toISOString(),actor.id,actor.name,actor.email,action,JSON.stringify(before),JSON.stringify(after));
  const settings=()=>db.prepare('SELECT alert_email,updated_at,updated_by FROM general_settings WHERE id=1').get();
  const safeError=e=>/^[A-Z0-9_]{1,50}$/.test(e?.code||'')?e.code:'SMTP_ERROR';
  function updateEmail(actor,value){
    db.exec('BEGIN');try{
      const old=settings();
      db.prepare('UPDATE general_settings SET alert_email=?,updated_at=?,updated_by=? WHERE id=1').run(value,new Date(now()).toISOString(),actor.id);
      audit(actor,'alert_email_updated',{alert_email:old.alert_email},{alert_email:value});
      // A corrected destination can receive still-open incidents that failed before.
      db.prepare("UPDATE connection_incidents SET notification_status='pending',attempts=0,next_attempt_at=0,last_error='' WHERE resolved_at IS NULL AND notification_status IN ('blocked','error','failed')").run();
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    void drain();return settings();
  }
  function stateChanged(id,status,reason='Conexão interrompida.'){
    if(stopped)return;
    const instance=db.prepare('SELECT first_connected_at FROM instances WHERE id=?').get(id);if(!instance)return;
    const time=new Date(now()).toISOString();
    if(status==='authenticated'){
      db.prepare('UPDATE instances SET first_connected_at=COALESCE(first_connected_at,?),last_connected_at=? WHERE id=?').run(time,time,id);
      db.prepare("UPDATE connection_incidents SET resolved_at=?,notification_status=CASE WHEN notification_status IN ('pending','blocked','error','failed') THEN 'cancelled' ELSE notification_status END WHERE instance_id=? AND resolved_at IS NULL").run(time,id);
    }else if(instance.first_connected_at&&['disconnected','retrying','qr'].includes(status)){
      db.prepare('INSERT OR IGNORE INTO connection_incidents(instance_id,opened_at,reason) VALUES(?,?,?)').run(id,time,reason);
      void drain();
    }
  }
  function drain(){
    if(stopped)return Promise.resolve();if(work){rerun=true;return work;}
    work=(async()=>{
      const pending=db.prepare("SELECT * FROM connection_incidents WHERE resolved_at IS NULL AND notification_status IN ('pending','error','blocked') AND next_attempt_at<=? ORDER BY id LIMIT 20").all(now());
      for(const incident of pending){
        if(stopped)break;
        if(!db.prepare('SELECT id FROM connection_incidents WHERE id=? AND resolved_at IS NULL').get(incident.id))continue;
        const to=settings().alert_email;
        if(!to||!mailReady()){
          db.prepare("UPDATE connection_incidents SET notification_status='blocked',last_error=?,next_attempt_at=? WHERE id=?").run(to?'SMTP_NOT_CONFIGURED':'ALERT_EMAIL_NOT_CONFIGURED',now()+60000,incident.id);continue;
        }
        const instance=db.prepare('SELECT i.id,i.name,i.phone,u.name AS owner_name FROM instances i LEFT JOIN users u ON u.id=i.owner_id WHERE i.id=?').get(incident.instance_id);
        db.prepare("UPDATE connection_incidents SET notification_status='sending',recipient=?,attempts=attempts+1 WHERE id=?").run(to,incident.id);
        try{
          const result=await sendEmail({to,instance,incident,appName:appName(),publicUrl});
          db.prepare("UPDATE connection_incidents SET notification_status='sent',message_id=?,last_error='' WHERE id=?").run(result?.messageId||'',incident.id);
        }catch(e){
          const attempts=incident.attempts+1;
          db.prepare("UPDATE connection_incidents SET notification_status=?,last_error=?,next_attempt_at=? WHERE id=?").run(attempts>=5?'failed':'error',safeError(e),now()+Math.min(60000*2**(attempts-1),1800000),incident.id);
        }
      }
    })().catch(()=>console.error('[connection-alerts] Falha ao processar fila de alertas.')).finally(()=>{work=null;if(rerun&&!stopped){rerun=false;return drain();}});
    return work;
  }
  // An interrupted SMTP send is ambiguous: keep it visible, never silently duplicate it.
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
  function reconcile(state){for(const row of db.prepare('SELECT id FROM instances WHERE first_connected_at IS NOT NULL').all()){const status=state(row.id).status;if(status==='authenticated')stateChanged(row.id,status);else stateChanged(row.id,'disconnected','A instância não restabeleceu a conexão após iniciar o servidor.');}}
  function start(state){timer=setInterval(()=>{void drain();},intervalMs);timer.unref();if(state){const startup=setTimeout(()=>{if(!stopped){reconcile(state);void drain();}},60000);startup.unref();const interval=timer;timer={stop:()=>{clearInterval(interval);clearTimeout(startup);}};}}
  async function close(){stopped=true;if(timer?.stop)timer.stop();else clearInterval(timer);await work;}
  return {settings,updateEmail,stateChanged,drain,sendTest,reconcile,start,close,mailReady};
}
