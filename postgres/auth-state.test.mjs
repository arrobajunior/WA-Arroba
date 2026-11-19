import test from 'node:test';
import assert from 'node:assert/strict';
import {BufferJSON} from '@whiskeysockets/baileys';
import {postgresFixture} from './test-fixture.mjs';
import {createPostgresAuthState} from './auth-state.mjs';
import {createSerialTasks} from './serial-tasks.mjs';

async function fixture(t){
  const f=await postgresFixture(),states=[];
  const create=async(id=f.ids[0],options={},store=f.store)=>{const state=await createPostgresAuthState(store,id,options);states.push(state);return state;};
  t.after(async()=>{for(const s of states)await s.invalidate();await f.close();});return {...f,create};
}
test('Baileys credentials and Buffer keys retain the old encrypted format and survive recreation',async t=>{
  const f=await fixture(t),id=f.ids[0];
  await f.db.run('INSERT INTO wa_keys(instance_id,kind,key_id,value) VALUES($1,$2,$3,$4)',[id,'creds','main',f.store.encrypt(JSON.stringify({registered:true,marker:Buffer.from([1,2,3])},BufferJSON.replacer))]);
  const state=await f.create();assert.equal(state.state.creds.registered,true);assert.deepEqual(state.state.creds.marker,Buffer.from([1,2,3]));
  await state.state.keys.set({'session':{'key-a':{data:Buffer.from([0,255,4])}},'app-state-sync-key':{'key-b':{keyData:Buffer.from([5,6])}}});
  state.state.creds.version=2;await state.save();await state.invalidate();const reopened=await f.create();
  assert.equal(reopened.state.creds.version,2);assert.deepEqual((await reopened.state.keys.get('session',['key-a','missing']))['key-a'].data,Buffer.from([0,255,4]));
  assert.equal((await reopened.state.keys.get('session',['missing'])).missing,null);
  assert.deepEqual(Buffer.from((await reopened.state.keys.get('app-state-sync-key',['key-b']))['key-b'].keyData),Buffer.from([5,6]));
  const row=await f.db.get('SELECT value FROM wa_keys WHERE instance_id=$1 AND kind=$2 AND key_id=$3',[id,'session','key-a']);assert.ok(!row.value.includes('data'));assert.deepEqual(JSON.parse(f.store.decrypt(row.value),BufferJSON.reviver).data,Buffer.from([0,255,4]));
});
test('ordered saves snapshot values at call time and per-instance state does not leak across sessions',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(f.ids[1]),bytes=Buffer.from([1]);
  a.state.creds.revision=1;const first=a.save();a.state.creds.revision=2;const second=a.save();
  const key=a.state.keys.set({session:{same:{bytes}}});bytes[0]=9;
  await Promise.all([first,second,key]);
  assert.equal(JSON.parse(f.store.decrypt((await f.db.get("SELECT value FROM wa_keys WHERE instance_id=$1 AND kind='creds'",[f.ids[0]])).value)).revision,2);
  assert.equal((await a.state.keys.get('session',['same'])).same.bytes[0],1);assert.equal((await b.state.keys.get('session',['same'])).same,null);
  await a.state.keys.set({session:{same:null}});assert.equal((await a.state.keys.get('session',['same'])).same,null);
});
test('a partial key-set failure rolls back all keys and does not poison subsequent queued writes',async t=>{
  const f=await fixture(t);let failing=true;
  const wrapped={...f.db,transaction:operation=>f.db.transaction(tx=>operation({...tx,run:(sql,args)=>{if(failing&&sql.startsWith('INSERT INTO wa_keys')&&args[2]==='bad')throw Object.assign(new Error('synthetic'),{code:'KEY_TEST_FAILURE'});return tx.run(sql,args);}}))};
  const state=await f.create(f.ids[0],{}, {...f.store,db:wrapped});
  await assert.rejects(state.state.keys.set({session:{good:{n:1},bad:{n:2}}}),e=>e.code==='KEY_TEST_FAILURE');
  assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys')).n,0);
  failing=false;await state.state.keys.set({session:{good:{n:3}}});assert.equal((await state.state.keys.get('session',['good'])).good.n,3);
});
test('invalidation rolls back in-flight writes, skips queued saves and cannot resurrect cleared session keys',async t=>{
  const f=await fixture(t);let entered,release,block=true;
  const began=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);
  const wrapped={...f.db,transaction:operation=>f.db.transaction(tx=>operation({...tx,run:async(sql,args)=>{
    const result=await tx.run(sql,args);if(block&&sql.startsWith('INSERT INTO wa_keys')){block=false;entered();await barrier;}return result;
  }}))};
  const state=await f.create(f.ids[0],{}, {...f.store,db:wrapped}),pending=state.state.keys.set({session:{stale:{data:1}}});await began;
  const stopping=state.invalidate();release();await Promise.all([pending,stopping]);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys')).n,0);
  await state.save();await state.state.keys.set({session:{later:{data:2}}});assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys')).n,0);
  assert.deepEqual(await state.state.keys.get('session',['stale']),{});
});
test('disabled and nonexistent instances cannot load auth state, and a deactivated instance stops further persistence',async t=>{
  const f=await fixture(t),state=await f.create();
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[f.ids[0]]);
  await assert.rejects(f.create(),e=>e.code==='instance_disabled');await assert.rejects(f.create('deadbeef'),e=>e.code==='instance_disabled');
  await state.state.keys.set({session:{ignored:{n:1}}});assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys')).n,0);
});
test('serial executor preserves per-key order, permits independent keys and recovers after errors',async()=>{
  const queue=createSerialTasks(),events=[];let release;const barrier=new Promise(r=>release=r);
  const first=queue.run('a',async()=>{events.push('a1');await barrier;throw Object.assign(new Error('synthetic'),{code:'TEST_FAILURE'});});
  const failure=assert.rejects(first,e=>e.code==='TEST_FAILURE');const second=queue.run('a',async()=>events.push('a2'));
  await queue.run('b',async()=>events.push('b'));assert.deepEqual(events,['a1','b']);release();await Promise.all([failure,second]);await queue.idle();assert.deepEqual(events,['a1','b','a2']);assert.equal(queue.size(),0);
});
