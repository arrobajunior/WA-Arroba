import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresFixture} from './test-fixture.mjs';
import {createPostgresConnectionAlerts} from './connection-alerts.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createPostgresIncidentHistory} from './incident-history.mjs';

async function fixture(t,options={}){
  const f=await postgresFixture(),controllers=[];let clock=Date.parse('2026-11-19T12:00:00Z');const sent=[];
  const activity=createPostgresInstanceActivity(f.db,{now:()=>clock});
  const defaults={now:()=>clock,mailReady:()=>true,sendEmail:async value=>{sent.push(value);return {messageId:'synthetic-ses-id'};},onConnectionEvent:activity.connectionState};
  const create=(opts={},store=f.store)=>{const c=createPostgresConnectionAlerts(store,{...defaults,...options,...opts});controllers.push(c);return c;};
  const alerts=create();
  t.after(async()=>{for(const c of controllers)await c.close();await f.close();});
  return {...f,alerts,sent,activity,create,advance:ms=>clock+=ms,now:()=>clock};
}
test('PostgreSQL grace ignores natural 3–10s reconnects, sends no email and adds no audit noise',async t=>{
  const f=await fixture(t),id=f.ids[0];await f.alerts.stateChanged(id,'authenticated',undefined,{source:'whatsapp',phone:'5511000000000'});
  const count=(await f.activity.list()).total;
  for(const delay of [3000,10000]){
    await f.alerts.stateChanged(id,'disconnected','Natural close',{source:'whatsapp',code:500});f.advance(delay);
    await f.alerts.stateChanged(id,'authenticated',undefined,{source:'whatsapp',phone:'5511000000000'});await f.alerts.drain();
  }
  assert.equal(f.sent.length,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_incidents')).n,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_candidates')).n,0);assert.equal((await f.activity.list()).total,count);
  await f.alerts.stateChanged(f.ids[1],'disconnected','Never connected',{source:'whatsapp',code:401});await f.alerts.drain();assert.equal(f.sent.length,0);
});
test('continuous 60s loss confirms once, keeps detection time and terminal losses bypass grace',async t=>{
  const f=await fixture(t),id=f.ids[0];await f.alerts.stateChanged(id,'authenticated');
  await f.alerts.stateChanged(id,'disconnected','First',{source:'whatsapp',code:428});const first=await f.db.get('SELECT * FROM connection_candidates');
  f.advance(30000);await f.alerts.stateChanged(id,'retrying','Retry',{source:'whatsapp',reconnectAttempt:1});assert.equal((await f.db.get('SELECT due_at FROM connection_candidates')).due_at,first.due_at);
  f.advance(29999);await f.alerts.drain();assert.equal(f.sent.length,0);f.advance(1);await f.alerts.drain();assert.equal(f.sent.length,1);
  assert.equal((await f.db.get('SELECT opened_at FROM connection_incidents')).opened_at,first.opened_at);assert.ok(!Object.hasOwn(f.sent[0].instance,'token'));
  await f.alerts.stateChanged(id,'retrying','Again',{source:'whatsapp',reconnectAttempt:2});await f.alerts.drain();assert.equal(f.sent.length,1);
  for(const metadata of [{source:'manual_disconnect'},{source:'whatsapp',code:401},{source:'whatsapp',code:440},{source:'whatsapp',terminal:true}]){
    await f.alerts.stateChanged(id,'authenticated');const before=f.sent.length;
    await f.alerts.stateChanged(id,'disconnected','Terminal',metadata);await f.alerts.drain();assert.equal(f.sent.length,before+1);
  }
  await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'qr','New QR',{source:'whatsapp'});await f.alerts.drain();assert.equal(f.sent.length,6);
});
test('pending grace survives controller restart; late recovery cancels mail before it starts',async t=>{
  const f=await fixture(t),id=f.ids[0];await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'disconnected','Close',{source:'whatsapp',code:503});
  f.advance(30000);await f.alerts.close();const next=f.create();f.advance(30000);await next.drain();assert.equal(f.sent.length,1);await next.drain();assert.equal(f.sent.length,1);
  await next.stateChanged(id,'authenticated');await next.stateChanged(id,'disconnected','Second',{source:'whatsapp',code:428});f.advance(61000);
  await next.stateChanged(id,'authenticated');await next.drain();assert.equal(f.sent.length,1);
  const last=await f.db.get('SELECT * FROM connection_incidents ORDER BY id DESC LIMIT 1');assert.equal(last.notification_status,'cancelled');assert.equal(last.resolution_reason,'reconnected');
});
test('deactivation clears candidates and closes confirmed outages without fake recovery or inactive sends',async t=>{
  const f=await fixture(t,{mailReady:()=>false}),id=f.ids[0],other=f.ids[1];
  await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'disconnected','Candidate',{source:'whatsapp',code:500});
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[id]);await f.alerts.deactivate(id);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_candidates')).n,0);
  await f.alerts.stateChanged(other,'authenticated');await f.alerts.stateChanged(other,'disconnected','Logout',{source:'whatsapp',code:401});await f.alerts.drain();
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[other]);await f.alerts.deactivate(other);await f.alerts.drain();
  const history=await createPostgresIncidentHistory(f.db,{now:f.now}).list();assert.equal(history.summary.deactivated,1);assert.equal(history.summary.resolved,0);assert.equal(history.incidents[0].notification_status,'cancelled');assert.equal(f.sent.length,0);
  assert.equal((await f.db.get("SELECT count(*) AS n FROM connection_incident_events WHERE kind='reconnected'")).n,0);
});
test('SMTP retries are bounded and destination updates are shared, audited, admin-only and can requeue failures',async t=>{
  let attempts=0,fail=true;const f=await fixture(t,{sendEmail:async mail=>{attempts++;if(fail)throw Object.assign(new Error('synthetic-private-password'),{code:'ETEMP'});return {messageId:'ok'};}}),id=f.ids[0];
  await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'disconnected','Logout',{source:'whatsapp',code:401});await f.alerts.drain();
  for(let n=0;n<4;n++){f.advance(2000000);await f.alerts.drain();}assert.equal(attempts,5);assert.equal((await f.db.get('SELECT notification_status FROM connection_incidents')).notification_status,'failed');
  f.advance(2000000);await f.alerts.drain();assert.equal(attempts,5);
  await assert.rejects(f.alerts.updateEmail(f.user,'new@example.test'),e=>e.status===403);
  await assert.rejects(f.alerts.updateEmail(f.root,'bad@example.test\r\nBcc: hidden@example.test'),e=>e.code==='invalid_email');
  fail=false;await f.alerts.updateEmail(f.root,'new@example.test');await f.alerts.drain();assert.equal(attempts,6);
  const row=await f.db.get('SELECT * FROM connection_incidents');assert.equal(row.recipient,'new@example.test');assert.equal(row.notification_status,'sent');assert.equal(row.attempts,1);
  const audit=await f.db.get("SELECT * FROM admin_audit WHERE action='alert_email_updated'");assert.equal(audit.actor_id,f.root.id);
  const history=await createPostgresIncidentHistory(f.db,{now:f.now}).detail(row.id);assert.ok(!JSON.stringify(history).includes('synthetic-private-password'));
});
test('SMTP success followed by database failure is ambiguous and is never retried as an SMTP failure',async t=>{
  const f=await fixture(t),id=f.ids[0];await f.alerts.close();
  const wrapped={...f.db,transaction:operation=>f.db.transaction(tx=>operation({...tx,run:(sql,args)=>{if(sql.startsWith("UPDATE connection_incidents SET notification_status='sent'"))throw Object.assign(new Error('persist failed'),{code:'TEST_DB_FAILURE'});return tx.run(sql,args);}}))};
  const broken=f.create({}, {...f.store,db:wrapped});await broken.stateChanged(id,'authenticated');await broken.stateChanged(id,'disconnected','Logout',{source:'whatsapp',code:401});await broken.drain();
  assert.equal(f.sent.length,1);assert.equal((await f.db.get('SELECT notification_status FROM connection_incidents')).notification_status,'sending');await broken.close();
  const restarted=f.create();await restarted.recoverInterrupted();await restarted.drain();assert.equal(f.sent.length,1);assert.equal((await f.db.get('SELECT notification_status FROM connection_incidents')).notification_status,'unknown');
});
test('two alert drainers cannot both claim the same persisted incident',async t=>{
  let notify,release;const began=new Promise(r=>notify=r),blocked=new Promise(r=>release=r);let sends=0;
  const f=await fixture(t,{sendEmail:async()=>{sends++;notify();await blocked;return {messageId:'once'};}}),id=f.ids[0];
  const other=f.create();await f.db.run("UPDATE instances SET first_connected_at='2026-11-19T12:00:00.000Z' WHERE id=$1",[id]);
  await f.db.run("INSERT INTO connection_incidents(instance_id,opened_at,reason) VALUES($1,'2026-11-19T12:00:00.000Z','Persisted')",[id]);
  const first=f.alerts.drain();
  try{await began;assert.equal((await f.db.get('SELECT 1 AS alive')).alive,1);await other.drain();assert.equal(sends,1);}finally{release();await first;}
  assert.equal((await f.db.get('SELECT attempts FROM connection_incidents')).attempts,1);
});
test('concurrent email-test requests reserve one global slot, and startup reconciliation preserves quiet connections',async t=>{
  const f=await fixture(t),other=f.create();
  const result=await Promise.allSettled([f.alerts.sendTest(f.root),other.sendTest(f.root)]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.find(r=>r.status==='rejected').reason.status,429);assert.equal(f.sent.length,1);
  const id=f.ids[0];await f.alerts.stateChanged(id,'authenticated');const before=(await f.activity.list()).total;
  await f.alerts.reconcile(()=>({status:'authenticated'}));assert.equal((await f.activity.list()).total,before);
  await f.alerts.start(()=>({status:'authenticated'}));await f.alerts.start(()=>({status:'authenticated'}));await f.alerts.close();
});
test('a real grace timer confirms sustained downtime without another connection event',async t=>{
  const f=await fixture(t,{now:Date.now,graceMs:40}),id=f.ids[0];await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'disconnected','Recoverable',{source:'whatsapp',code:428});
  const deadline=Date.now()+2000;while(!f.sent.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(f.sent.length,1);await f.alerts.drain();assert.equal(f.sent.length,1);
});
test('startup grace lets a restored authenticated socket discard a persisted candidate without alerting',async t=>{
  const f=await fixture(t),id=f.ids[0];await f.alerts.stateChanged(id,'authenticated');await f.alerts.stateChanged(id,'disconnected','Before restart',{source:'whatsapp',code:503});await f.alerts.close();
  const next=f.create();await next.start(()=>({status:'authenticated'}));f.advance(60000);await next.drain();
  assert.equal(f.sent.length,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_candidates')).n,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_incidents')).n,0);
});
