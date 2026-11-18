import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './store.mjs';
import {createConnectionAlerts} from './connection-alerts.mjs';
import {alertMessage,sendAlertEmail} from './alert-email.mjs';

const actor={id:'admin',name:'Test Admin',email:'admin@example.com'};
async function fixture(t,opts={}){
 const dir=await mkdtemp(path.join(tmpdir(),'wa-alert-'));let store=openStore(dir);
 store.db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run(actor.id,actor.name,actor.email,'unused','admin','now');
 for(const id of ['aaaa1111','bbbb2222'])store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?)').run(id,'Sales '+id,store.encrypt('token'),'now','now',actor.id);
 let clock=Date.parse('2026-11-18T15:00:00Z');const sent=[];
 const alerts=createConnectionAlerts(store,{now:()=>clock,mailReady:()=>true,sendEmail:async input=>{sent.push(input);return {messageId:'smtp-'+sent.length};},...opts});
 t.after(async()=>{await alerts.close();store.close();await rm(dir,{recursive:true,force:true});});
 return {store,alerts,sent,dir,advance:ms=>{clock+=ms;}};
}
test('never-connected instances do not alert; outages deduplicate, recover and alert again on a new loss',async t=>{
 const {store,alerts,sent}=await fixture(t);alerts.updateEmail(actor,'team@example.com');
 alerts.stateChanged('aaaa1111','qr');alerts.stateChanged('aaaa1111','disconnected');await alerts.drain();assert.equal(sent.length,0);
 alerts.stateChanged('aaaa1111','authenticated');alerts.stateChanged('aaaa1111','disconnected','Connection lost');alerts.stateChanged('aaaa1111','retrying');await alerts.drain();
 assert.equal(sent.length,1);assert.equal(sent[0].to,'team@example.com');assert.equal(sent[0].instance.id,'aaaa1111');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM connection_incidents').get().n,1);
 alerts.stateChanged('aaaa1111','authenticated');assert.ok(store.db.prepare('SELECT resolved_at FROM connection_incidents').get().resolved_at);
 alerts.stateChanged('aaaa1111','qr');await alerts.drain();assert.equal(sent.length,2);
});
test('audit retains actor and old/new values and prevents edits or deletion',async t=>{
 const {store,alerts}=await fixture(t);alerts.updateEmail(actor,'first@example.com');alerts.updateEmail({...actor,id:'another',name:'Another Admin'},'second@example.com');
 const rows=store.db.prepare('SELECT * FROM admin_audit ORDER BY id').all();assert.equal(rows.length,2);assert.equal(rows[1].actor_name,'Another Admin');assert.deepEqual(JSON.parse(rows[1].before_value),{alert_email:'first@example.com'});assert.deepEqual(JSON.parse(rows[1].after_value),{alert_email:'second@example.com'});
 assert.throws(()=>store.db.exec("UPDATE admin_audit SET actor_name='spoofed'"));assert.throws(()=>store.db.exec('DELETE FROM admin_audit'));
});
test('blocked alert is sent after configuration; recovery cancels unsent alerts',async t=>{
 const {store,alerts,sent}=await fixture(t);alerts.stateChanged('aaaa1111','authenticated');alerts.stateChanged('aaaa1111','disconnected');await alerts.drain();
 assert.equal(store.db.prepare('SELECT notification_status FROM connection_incidents').get().notification_status,'blocked');
 alerts.updateEmail(actor,'team@example.com');await alerts.drain();assert.equal(sent.length,1);
 alerts.stateChanged('bbbb2222','authenticated');alerts.stateChanged('bbbb2222','disconnected');alerts.stateChanged('bbbb2222','authenticated');await alerts.drain();
 const row=store.db.prepare("SELECT * FROM connection_incidents WHERE instance_id='bbbb2222'").get();assert.ok(row.resolved_at);
});
test('SMTP failures retry with backoff and bounded attempts; changing the email retries an open failed incident',async t=>{
 let calls=0;const {store,alerts,advance}=await fixture(t,{sendEmail:async()=>{calls++;throw Object.assign(new Error('sensitive SMTP details'),{code:'EAUTH'});}});
 alerts.updateEmail(actor,'team@example.com');alerts.stateChanged('aaaa1111','authenticated');alerts.stateChanged('aaaa1111','disconnected');await alerts.drain();
 assert.equal(calls,1);await alerts.drain();assert.equal(calls,1);
 for(let i=0;i<4;i++){advance(1800001);await alerts.drain();}
 assert.equal(calls,5);const row=store.db.prepare('SELECT * FROM connection_incidents').get();assert.equal(row.notification_status,'failed');assert.equal(row.last_error,'EAUTH');assert.ok(!JSON.stringify(row).includes('sensitive'));
 advance(1800001);await alerts.drain();assert.equal(calls,5);
 alerts.updateEmail(actor,'new@example.com');await alerts.drain();assert.equal(calls,6);
});
test('incident and connection history survive recreation; startup reconciliation excludes new instances',async t=>{
 const {store,alerts,dir}=await fixture(t);alerts.stateChanged('aaaa1111','authenticated');alerts.stateChanged('aaaa1111','disconnected');await alerts.drain();await alerts.close();
 // A second connection models a restarted process using the same database.
 const restartedStore=openStore(dir),sent=[];const restarted=createConnectionAlerts(restartedStore,{mailReady:()=>true,sendEmail:async input=>{sent.push(input);return {};}});
 try{restarted.reconcile(()=>({status:'disconnected'}));assert.equal(restartedStore.db.prepare('SELECT count(*) AS n FROM connection_incidents').get().n,1);restarted.updateEmail(actor,'restart@example.com');await restarted.drain();assert.equal(sent.length,1);
 restarted.reconcile(()=>({status:'authenticated'}));assert.ok(restartedStore.db.prepare('SELECT resolved_at FROM connection_incidents').get().resolved_at);
 }finally{await restarted.close();restartedStore.close();}
 assert.ok(store.db.prepare("SELECT first_connected_at FROM instances WHERE id='aaaa1111'").get().first_connected_at);
});
test('legacy migration marks only evidence of prior connections and preserves historical phone after logout',async t=>{
 const {store,dir}=await fixture(t);
 store.db.prepare("UPDATE instances SET phone='5511999999999' WHERE id='aaaa1111'").run();
 const reopened=openStore(dir);try{assert.ok(reopened.db.prepare("SELECT first_connected_at FROM instances WHERE id='aaaa1111'").get().first_connected_at);assert.equal(reopened.db.prepare("SELECT first_connected_at FROM instances WHERE id='bbbb2222'").get().first_connected_at,null);}finally{reopened.close();}
 store.db.prepare("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES('old','bbbb2222','5511','test','chat','sent','device','now')").run();
 const historyStore=openStore(dir);try{assert.ok(historyStore.db.prepare("SELECT first_connected_at FROM instances WHERE id='bbbb2222'").get().first_connected_at);}finally{historyStore.close();}
});
test('SMTP delivery interrupted by process restart is visible as unknown and is not duplicated',async t=>{
 const {store,alerts,dir}=await fixture(t);await alerts.close();
 store.db.prepare("INSERT INTO connection_incidents(instance_id,opened_at,reason,notification_status) VALUES('aaaa1111','now','lost','sending')").run();
 const reopened=openStore(dir);const resumed=createConnectionAlerts(reopened);
 try{assert.equal(reopened.db.prepare('SELECT notification_status FROM connection_incidents').get().notification_status,'unknown');}finally{await resumed.close();reopened.close();}
});
test('test emails are auditable and rate limited, and the template escapes instance content',async t=>{
 const {store,alerts,sent}=await fixture(t);await assert.rejects(alerts.sendTest(actor),/Cadastre/);alerts.updateEmail(actor,'test@example.com');await alerts.sendTest(actor);assert.equal(sent[0].test,true);await assert.rejects(alerts.sendTest(actor),e=>e.status===429);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM admin_audit WHERE action='alert_email_test_sent'").get().n,1);
 const message=alertMessage({to:'a@example.com',appName:'<Brand>',publicUrl:'https://wa.example.com',instance:{id:'aaaa1111',name:'<img src=x onerror=alert(1)>',phone:'5511',owner_name:'<Admin>'},incident:{opened_at:'2026-11-18T15:00:00Z',reason:'<lost>'}});
 assert.ok(!message.html.includes('<img src=x'));assert.ok(message.html.includes('&lt;img'));assert.ok(message.html.includes('12:00:00'));assert.ok(message.text.includes('aaaa1111'));assert.ok(message.html.includes('https://wa.example.com/#instance/aaaa1111'));
});
test('SMTP credentials are read at send time, STARTTLS is mandatory, and credentials do not enter the message',async()=>{
 const previous={user:process.env.SES_SMTP_USER,pass:process.env.SES_SMTP_PASS};let options;
 try{process.env.SES_SMTP_USER='fake-smtp-user';process.env.SES_SMTP_PASS='fake-smtp-secret';
 await sendAlertEmail({to:'to@example.com',test:true},{createTransport:config=>{options=config;return {sendMail:async message=>{assert.ok(!JSON.stringify(message).includes('fake-smtp-secret'));return {messageId:'ok'};},close(){}};}});
 assert.equal(options.host,'email-smtp.us-east-1.amazonaws.com');assert.equal(options.port,587);assert.equal(options.requireTLS,true);assert.equal(options.secure,false);assert.equal(options.auth.pass,'fake-smtp-secret');
 }finally{for(const [name,value] of [['SES_SMTP_USER',previous.user],['SES_SMTP_PASS',previous.pass]])if(value===undefined)delete process.env[name];else process.env[name]=value;}
});
