import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './store.mjs';
import {createInstanceActivity,webhookFingerprint} from './instance-activity.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'wa-activity-'));const store=openStore(dir);store.db.prepare("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('admin','Admin','admin@example.com','unused','admin','2026-11-01T12:00:00Z')").run();for(const id of ['aaaa1111','bbbb2222'])store.db.prepare('INSERT INTO instances(id,name,token,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'Sales '+id,store.encrypt('token'),'admin','2026-11-01T12:00:00Z','2026-11-01T12:00:00Z');t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});return {store,dir};}
test('webhook audit retains only origin and hash, never passwords, route secrets or query values',async t=>{
 const {store}=await fixture(t),activity=createInstanceActivity(store.db),url='https://user:private-password@hooks.example.com/private-route?token=private-token';
 const row=store.db.prepare("SELECT * FROM instances WHERE id='aaaa1111'").get();row.webhook_url=url;row.settings=JSON.stringify({sendDelay:3,secret:'do-not-store',token:'secret-token'});const value=activity.snapshot(row),serialized=JSON.stringify(value);
 assert.equal(value.webhook.origin,'https://hooks.example.com');assert.match(value.webhook.fingerprint,/^[a-f0-9]{64}$/);for(const secret of ['private-password','private-route','private-token','do-not-store','secret-token'])assert.ok(!serialized.includes(secret));assert.notEqual(webhookFingerprint(url).fingerprint,webhookFingerprint(url+'different').fingerprint);
});
test('activity is append-only, failed operations are correlated, and filters paginate and keep actor choices scoped',async t=>{
 const {store}=await fixture(t),db=store.db,activity=createInstanceActivity(db),actor={id:'actor-a',name:'Actor A',email:'a@example.com',role:'admin',kind:'user'},other={...actor,id:'actor-b',name:'Hidden actor B'};
 for(let n=0;n<130;n++)activity.record({instance:{id:'aaaa1111',name:'A'},actor,action:'instance_viewed',outcome:'observed',source:'panel'});
 activity.record({instance:{id:'bbbb2222',name:'B'},actor:other,action:'token_rotated',outcome:'success',source:'panel'});
 const page=activity.list(new URLSearchParams({page:'6'}),'aaaa1111');assert.equal(page.total,130);assert.equal(page.events.length,5);assert.equal(page.instances.length,0);assert.ok(!JSON.stringify(page.actors).includes('Hidden actor B'));
 await assert.rejects(activity.run({instance:{id:'aaaa1111',name:'A'},actor,action:'token_rotated'},async()=>{throw Object.assign(new Error('Never log this raw message'),{code:'FAILED_OPERATION',status:409});}));
 const failure=activity.list(new URLSearchParams({action:'token_rotated',outcome:'failed',actor_id:actor.id}),'aaaa1111').events[0];assert.equal(failure.details.error_code,'FAILED_OPERATION');assert.ok(!JSON.stringify(failure).includes('Never log this'));assert.ok(failure.request_id);
 assert.throws(()=>db.exec("UPDATE instance_activity SET actor_name='spoofed'"));assert.throws(()=>db.exec('DELETE FROM instance_activity'));
 for(const filter of [{from:'2026-02-30'},{page:'0'},{limit:'101'},{outcome:'bogus'},{instance_id:'invalid'}])assert.throws(()=>activity.list(new URLSearchParams(filter)),e=>e.status===400);
});
test('confirmed number changes retain the prior phone across logout and distinguish request-linked and automatic actors',async t=>{
 const {store}=await fixture(t),activity=createInstanceActivity(store.db),actor={id:'admin',name:'Admin',email:'admin@example.com',role:'admin',kind:'user'},instance={id:'aaaa1111',name:'A'};
 activity.connectionState(instance.id,'authenticated',undefined,{phone:'5511111111111',source:'whatsapp'});
 const context=activity.begin({instance,actor,action:'connection_requested',source:'panel'});
 activity.connectionState(instance.id,'authenticated',undefined,{phone:'5522222222222',source:'whatsapp',auditContext:context});
 const changed=activity.list(new URLSearchParams({action:'connection_number_changed'}),instance.id).events[0];assert.equal(changed.actor_id,actor.id);assert.deepEqual(changed.before,{phone:'5511111111111'});assert.deepEqual(changed.after,{phone:'5522222222222'});assert.equal(changed.request_id,context.request_id);
 activity.connectionState(instance.id,'disconnected','Network close',{source:'whatsapp',code:408});const lost=activity.list(new URLSearchParams({action:'connection_lost'}),instance.id).events[0];assert.equal(lost.actor_kind,'system');assert.equal(lost.actor_id,'');
});
test('historical creation and outages migrate once with unknown authors and survive later restarts',async t=>{
 const {store,dir}=await fixture(t),db=store.db;
 db.prepare("INSERT INTO connection_incidents(instance_id,opened_at,resolved_at,reason) VALUES('aaaa1111','2026-11-05T12:00:00Z','2026-11-05T12:10:00Z','old loss')").run();
 db.exec('DROP TABLE instance_activity');db.prepare("DELETE FROM schema_migrations WHERE name='instance_activity_v1'").run();
 let reopened=openStore(dir);let activity=createInstanceActivity(reopened.db),created=activity.list(new URLSearchParams({action:'instance_created'}),'aaaa1111').events[0];assert.equal(created.actor_kind,'legacy');assert.equal(created.actor_id,'');assert.equal(created.created_at,'2026-11-01T12:00:00Z');assert.equal(created.details.historical,true);assert.equal(activity.list(new URLSearchParams(),'aaaa1111').total,3);reopened.close();
 reopened=openStore(dir);try{activity=createInstanceActivity(reopened.db);assert.equal(activity.list(new URLSearchParams(),'aaaa1111').total,3);}finally{reopened.close();}
});
