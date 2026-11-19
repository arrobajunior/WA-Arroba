import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {acquirePostgresTransportOwnership} from './transport-ownership.mjs';
import {postgresFixture} from './test-fixture.mjs';

const url='postgresql://synthetic:synthetic-password@db.example.test/testdb';
function fakeCluster(){
  let owner=null,next=100;const clients=[];
  function clientFactory(options){
    const client=new EventEmitter();client.id=++next;client.ends=0;client.failHeartbeat=false;client.options=options;client.connect=async()=>{};
    client.query=async sql=>{
      if(sql.includes('pg_try_advisory_lock')){const acquired=owner===null;if(acquired)owner=client.id;return {rows:[{acquired,pid:client.id,lock_key:'123456789012345'}]};}
      if(client.failHeartbeat)throw new Error('synthetic-private-connection');return {rows:[{alive:1}]};
    };
    client.end=async()=>{client.ends++;if(owner===client.id)owner=null;client.emit('end');};clients.push(client);return client;
  }
  return {clientFactory,clients,db:{get:async(_sql,args)=>({owned:owner===args[0]})},forget:()=>owner=null};
}
test('one dedicated owner connection excludes a second owner and releases cleanly without exposing credentials',async()=>{
  const f=fakeCluster(),owner=await acquirePostgresTransportOwnership({databaseUrl:url,clientFactory:f.clientFactory});
  try{
    assert.equal(owner.active(),true);await owner.assert(f.db);assert.equal(f.clients[0].options.ssl.rejectUnauthorized,true);
    await assert.rejects(acquirePostgresTransportOwnership({databaseUrl:url,clientFactory:f.clientFactory}),e=>e.code==='TRANSPORT_ALREADY_OWNED'&&!e.message.includes('password'));
    assert.equal(owner.active(),true);await owner.assert(f.db);
  }finally{await owner.release();}
  const next=await acquirePostgresTransportOwnership({databaseUrl:url,clientFactory:f.clientFactory});await next.release();assert.ok(f.clients.every(c=>c.ends===1));
});
test('heartbeat failure closes ownership once, notifies transport and rejects further database fencing',async()=>{
  const f=fakeCluster(),owner=await acquirePostgresTransportOwnership({databaseUrl:url,clientFactory:f.clientFactory,heartbeatMs:10});let lost=0;owner.onLost(()=>lost++);f.clients[0].failHeartbeat=true;
  try{
    const deadline=Date.now()+1000;while(owner.active()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));assert.equal(owner.active(),false);assert.equal(lost,1);
    await assert.rejects(owner.assert(f.db),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');
  }finally{await owner.release();}assert.equal(lost,1);assert.equal(f.clients[0].ends,1);
});
test('missing advisory lock fails closed even before the heartbeat detects a dropped owner',async()=>{
  const f=fakeCluster(),owner=await acquirePostgresTransportOwnership({databaseUrl:url,clientFactory:f.clientFactory});let lost=false;owner.onLost(()=>lost=true);f.forget();
  try{await assert.rejects(owner.assert(f.db),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');assert.equal(owner.active(),false);assert.equal(lost,true);}finally{await owner.release();}
});
test('advisory lock key verification executes against PostgreSQL catalog with bound pid and 64-bit key',async t=>{
  const f=await postgresFixture();t.after(()=>f.close());let ended=false,proof;
  const owner=await acquirePostgresTransportOwnership({databaseUrl:url,schema:f.db.schema,clientFactory:()=>{
    const c=new EventEmitter();c.connect=async()=>{};c.query=(sql,args)=>{if(sql==='SELECT pg_advisory_lock($1::bigint)')proof=args[0];return f.engine.query(sql,args);};c.end=async()=>{ended=true;await f.engine.query('SELECT pg_advisory_unlock_all()');c.emit('end');};return c;
  }});
  try{await owner.assert(f.db);assert.equal(owner.active(),true);await f.engine.query('SELECT pg_advisory_unlock($1::bigint)',[proof]);await assert.rejects(owner.assert(f.db),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');}finally{await owner.release();}assert.equal(ended,true);
});
