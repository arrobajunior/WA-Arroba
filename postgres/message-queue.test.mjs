import test from 'node:test';
import assert from 'node:assert/strict';
import {postgresFixture} from './test-fixture.mjs';
import {createPostgresMessageQueue} from './message-queue.mjs';

async function fixture(t){
  const f=await postgresFixture();let active=true;const ownership={active:()=>active,assert:async()=>{if(!active)throw Object.assign(new Error('TRANSPORT_OWNERSHIP_LOST'),{code:'TRANSPORT_OWNERSHIP_LOST'});}};
  const queue=createPostgresMessageQueue(f.store,{ownership});t.after(()=>f.close());
  const insert=async(id,fields={})=>{
    const row={id,instance_id:f.ids[0],recipient:'5511999999999',body:'synthetic',type:'chat',status:'queue',ack:'pending',created_at:new Date().toISOString(),...fields};
    await f.db.run('INSERT INTO messages('+Object.keys(row).join(',')+') VALUES('+Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')+')',Object.values(row));return row;
  };
  return {...f,ownership,queue,insert,lose:()=>active=false};
}
test('two concurrent consumers reserve a queued message once and honor priority and expiry',async t=>{
  const f=await fixture(t),id=f.ids[0],other=createPostgresMessageQueue(f.store,{ownership:f.ownership});await f.insert('normal',{priority:10});await f.insert('urgent',{priority:0});await f.insert('expired',{created_at:new Date(Date.now()-90000000).toISOString()});
  const claimed=await Promise.all([f.queue.claim(id,'provider-a'),other.claim(id,'provider-b')]);assert.deepEqual(claimed.map(r=>r.id).sort(),['normal','urgent']);assert.equal(claimed[0].id,'urgent');assert.equal((await f.db.get("SELECT status FROM messages WHERE id='expired'")).status,'expired');assert.equal(await other.claim(id,'no-more'),null);
  await f.insert('only');const once=await Promise.all([f.queue.claim(id,'once-a'),other.claim(id,'once-b')]);assert.equal(once.filter(Boolean).length,1);
});
test('ACK and completion updates are scoped to a reserved provider ID and never overwrite a higher confirmed receipt',async t=>{
  const f=await fixture(t);await f.insert('m');const row=await f.queue.claim(f.ids[0],'provider');await f.queue.acknowledge(f.ids[0],'provider',4);await f.queue.finish(row,{status:'unknown',error:'request timeout'});
  const message=await f.db.get("SELECT * FROM messages WHERE id='m'");assert.equal(message.status,'sent');assert.equal(message.ack,'read');
  assert.equal(await f.queue.acknowledge(f.ids[0],'provider',2),null);assert.equal(await f.queue.acknowledge(f.ids[1],'provider',5),null);assert.equal(await f.queue.acknowledge(f.ids[0],'provider',99),null);
});
test('startup recovery does not resend in-flight messages, expires only lost volatile media and preserves URL retries',async t=>{
  const f=await fixture(t);await f.insert('sending',{status:'sending',provider_id:'maybe-delivered'});await f.insert('volatile',{type:'image',media_id:'not-in-memory'});await f.insert('url',{type:'image',source_url:f.store.encrypt('https://synthetic.example.test/image.png')});await f.insert('text');
  await f.queue.recoverInterrupted();const rows=await f.db.all('SELECT id,status FROM messages ORDER BY id');assert.deepEqual(Object.fromEntries(rows.map(r=>[r.id,r.status])),{sending:'unknown',text:'queue',url:'queue',volatile:'unsent'});
});
test('incoming duplicate provider IDs are stored once per instance across asynchronous handlers',async t=>{
  const f=await fixture(t),other=createPostgresMessageQueue(f.store,{ownership:f.ownership});
  const row={instance_id:f.ids[0],recipient:'5511999999999@s.whatsapp.net',body:'incoming synthetic',type:'chat',status:'received',ack:'device',created_at:new Date().toISOString(),provider_id:'same-provider',direction:'in'};
  const stored=await Promise.all([f.queue.recordIncoming({...row,id:'a'}),other.recordIncoming({...row,id:'b'})]);assert.equal(stored[0].id,stored[1].id);await other.recordIncoming({...row,instance_id:f.ids[1],id:'c'});assert.equal((await f.db.get('SELECT count(*) AS n FROM messages')).n,2);
});
test('ownership loss prevents stale consumers from claiming or completing messages',async t=>{
  const f=await fixture(t);await f.insert('m');const row=await f.queue.claim(f.ids[0],'provider');f.lose();
  await assert.rejects(f.queue.finish(row),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');await assert.rejects(f.queue.claim(f.ids[0],'other'),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');assert.equal((await f.db.get("SELECT status FROM messages WHERE id='m'")).status,'sending');
});
