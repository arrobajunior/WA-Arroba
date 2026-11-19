import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresDatabase,postgresPoolOptions} from './database.mjs';
import {openPostgresStore} from './store.mjs';
import {loadPersistenceCrypto} from './persistence-crypto.mjs';
import {openStore} from '../store.mjs';
import {createPostgresIncidentHistory} from './incident-history.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';

async function engineFixture(t){
  const engine=new PGlite(),schema='wa_rehearsal_runtime';
  await engine.exec('CREATE SCHEMA '+schema+';SET search_path TO '+schema+',pg_catalog');
  await engine.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  await engine.exec(await readFile(new URL('./invariants.sql',import.meta.url),'utf8'));
  let releaseCount=0,active=0,chain=Promise.resolve();
  const pool=new EventEmitter();
  pool.connect=async()=>{
    let unlock;const previous=chain;chain=new Promise(r=>{unlock=r;});await previous;active++;
    return {query:(sql,args=[])=>engine.query(sql,args),release:()=>{active--;releaseCount++;unlock();}};
  };
  pool.end=async()=>{};
  const db=createPostgresDatabase(pool,{schema});
  t.after(async()=>{await db.close();await engine.close();});
  return {db,engine,pool,schema,counts:()=>({releaseCount,active})};
}
test('pool config has bounded resources and TLS validation, rejects insecure overrides without exposing URLs',()=>{
  const url='postgresql://runtime:synthetic-password@db.example.test/db';
  const config=postgresPoolOptions({databaseUrl:url});assert.equal(config.max,10);assert.equal(config.connectionTimeoutMillis,10000);assert.equal(config.ssl.rejectUnauthorized,true);
  for(const ssl of [false,{rejectUnauthorized:false}])assert.throws(()=>postgresPoolOptions({databaseUrl:url,ssl}),e=>e.code==='INSECURE_DATABASE_TLS'&&!e.message.includes('synthetic'));
  for(const suffix of ['?sslmode=disable','?sslmode=require','?ssl=false','?uselibpqcompat=true'])assert.throws(()=>postgresPoolOptions({databaseUrl:url+suffix}));
  const tls=postgresPoolOptions({databaseUrl:url+'?sslmode=verify-full',ssl:{ca:'synthetic trusted CA'}});assert.equal(tls.ssl.ca,'synthetic trusted CA');assert.ok(!tls.connectionString.includes('sslmode'));
  assert.throws(()=>postgresPoolOptions({databaseUrl:url,max:1000}),e=>e.code==='INVALID_POOL_SIZE');
});
test('async queries normalize int8 and blobs, redact SQL errors and always release leases',async t=>{
  const {db,counts,pool}=await engineFixture(t);
  const result=await db.get('SELECT $1::bigint AS n,$2::bytea AS bytes',[1796000000000,Buffer.from([0,255,2])]);
  assert.equal(result.n,1796000000000);assert.deepEqual(result.bytes,Buffer.from([0,255,2]));
  await assert.rejects(db.get("SELECT 'sensitive synthetic body'::bigint"),e=>e.code==='22P02'&&!JSON.stringify(e).includes('sensitive')&&e.message==='22P02');
  await assert.rejects(db.get("SELECT 9007199254740992::bigint AS n"),e=>e.code==='DATABASE_INTEGER_OUT_OF_RANGE');
  assert.equal(counts().active,0);assert.equal(counts().releaseCount,3);
  pool.emit('error',new Error('private connection URL'));assert.equal(db.stats().idleErrors,1);
});
test('rollback is atomic; catching a failed query cannot commit; domain errors retain HTTP status',async t=>{
  const {db}=await engineFixture(t);
  await assert.rejects(db.transaction(async tx=>{
    await tx.run("INSERT INTO branding VALUES(1,'change')");throw Object.assign(new Error('not found'),{status:404,code:'not_found'});
  }),e=>e.status===404&&e.code==='not_found');
  assert.equal(await db.get('SELECT * FROM branding'),undefined);
  await assert.rejects(db.transaction(async tx=>{
    await tx.run("INSERT INTO branding VALUES(1,'never committed')");
    await tx.run('SELECT nonexistent_field').catch(()=>{});
  }),e=>e.code==='TRANSACTION_FAILED');
  assert.equal(await db.get('SELECT * FROM branding'),undefined);
  await assert.rejects(db.transaction(()=>db.transaction(async()=>{})),e=>e.code==='NESTED_TRANSACTION_NOT_SUPPORTED');
});
test('concurrent transactions stay pinned to distinct clients and detached work cannot reuse a released connection',async()=>{
  let nextId=0;const logs=[],pool=new EventEmitter();
  pool.connect=async()=>{
    const id=++nextId;return {query:async(sql)=>{logs.push({id,sql});return {rows:sql==='SELECT identity'?[{id}]:[],fields:[],rowCount:0};},release:()=>logs.push({id,sql:'release'})};
  };pool.end=async()=>{};const db=createPostgresDatabase(pool,{schema:'wa_rehearsal_parallel'});
  let ready,go;const started=new Promise(r=>ready=r),proceed=new Promise(r=>go=r);let delayed;
  try{
    const a=db.transaction(async()=>{
      assert.equal((await db.get('SELECT identity')).id,1);ready();await proceed;
      assert.equal((await db.get('SELECT identity')).id,1);
      delayed=()=>db.get('SELECT identity'); // Must execute inside the original async context later.
      return new Promise(resolve=>{setTimeout(()=>{delayed=db.get('SELECT identity').catch(e=>e.code);},20);resolve();});
    });
    await started;const b=await db.transaction(async()=> (await db.get('SELECT identity')).id);assert.equal(b,2);go();await a;
    await new Promise(r=>setTimeout(r,40));assert.equal(await delayed,'TRANSACTION_CLOSED');
    for(const id of [1,2])assert.deepEqual(logs.filter(r=>r.id===id).slice(-2).map(r=>r.sql),['COMMIT','release']);
  }finally{await db.close();}
  await assert.rejects(db.get('SELECT identity'),e=>e.code==='DATABASE_CLOSED');
});
test('persistence crypto reads the original key, is byte-compatible with legacy and never regenerates it',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'wa-crypto-')),legacy=openStore(dir);t.after(async()=>{legacy.close();await rm(dir,{recursive:true,force:true});});
  const key=await readFile(path.join(dir,'master.key')),pg=await loadPersistenceCrypto({dataDir:dir});
  assert.equal(pg.decrypt(legacy.encrypt('Olá session')),'Olá session');assert.equal(legacy.decrypt(pg.encrypt('outro token')),'outro token');
  await assert.rejects(loadPersistenceCrypto({dataDir:path.join(dir,'missing')}),e=>e.code==='MASTER_KEY_REQUIRED');
  await assert.rejects(loadPersistenceCrypto({dataDir:dir,keyBase64:Buffer.alloc(32).toString('base64')}),e=>e.code==='MASTER_KEY_MISMATCH');
  await chmod(path.join(dir,'master.key'),0o644);await assert.rejects(loadPersistenceCrypto({dataDir:dir}),e=>e.code==='INSECURE_MASTER_KEY_FILE');await chmod(path.join(dir,'master.key'),0o600);
  assert.deepEqual(await readFile(path.join(dir,'master.key')),key);
  const encoded=await loadPersistenceCrypto({keyBase64:key.toString('base64')});assert.equal(encoded.decrypt(pg.encrypt('test')),'test');
  await assert.rejects(loadPersistenceCrypto({keyBase64:'bad'}),e=>e.code==='INVALID_MASTER_KEY');
  assert.throws(()=>pg.decrypt('invalid'),e=>e.code==='PERSISTENCE_DECRYPT_FAILED');
});
test('store verifies restricted role, exact schema and original credentials before exposing the PostgreSQL backend',async t=>{
  const {db,engine,schema}=await engineFixture(t),key=Buffer.alloc(32,7).toString('base64'),crypto=await loadPersistenceCrypto({keyBase64:key});
  await engine.query('INSERT INTO users(id,name,email,password_hash,role,created_at,is_master) VALUES($1,$2,$3,$4,$5,$6,1)',['root','Master','test@example.test','hash','admin','date']);
  await engine.query('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',['abcd1234','Test',crypto.encrypt('preserved-token'),'date','date']);
  await engine.exec('CREATE ROLE wa_runtime;GRANT USAGE ON SCHEMA '+schema+' TO wa_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA '+schema+' TO wa_runtime;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA '+schema+' TO wa_runtime;SET ROLE wa_runtime');
  const store=await openPostgresStore({db,schema,keyBase64:key});assert.equal(store.backend,'postgresql');
  assert.equal(store.decrypt((await db.get('SELECT token FROM instances')).token),'preserved-token');
  // Ordinary accounts remain deletable; Master and audit records remain protected.
  await db.run("INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES('normal','N','normal@example.test','h','user','date')");
  assert.equal((await db.run("DELETE FROM users WHERE id='normal'")).changes,1);
  await assert.rejects(db.run("DELETE FROM users WHERE id='root'"),e=>e.code==='42501');
});
test('store refuses a superuser and never replaces a mismatched persistence key',async t=>{
  const {db,schema}=await engineFixture(t);
  await assert.rejects(openPostgresStore({db,schema,keyBase64:Buffer.alloc(32,4).toString('base64')}),e=>e.code==='DATABASE_ROLE_TOO_PRIVILEGED');
});
test('incident repository preserves filters, Brasilia boundaries, durations and deactivated closures on PostgreSQL',async t=>{
  const {db}=await engineFixture(t),history=createPostgresIncidentHistory(db,{now:()=>Date.parse('2026-11-19T14:00:00Z')});
  await db.run("INSERT INTO instances(id,name,token,created_at,updated_at) VALUES('abcd1234','Teste','synthetic','date','date')");
  const insert='INSERT INTO connection_incidents(instance_id,opened_at,reason,resolved_at,resolution_reason,notification_status,outage_kind) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id';
  await db.get(insert,['abcd1234','2026-11-19T02:59:59.000Z','outage','2026-11-19T03:00:10.000Z','reconnected','sent','confirmed']);
  const incident=await db.get(insert,['abcd1234','2026-11-19T13:00:00.000Z','outage','2026-11-19T13:01:00.000Z','deactivated','cancelled','confirmed']);
  await db.get(insert,['abcd1234','2026-11-19T13:30:00.000Z','short','2026-11-19T13:30:03.000Z','reconnected','sent','transient']);
  await db.run('INSERT INTO connection_incident_events(incident_id,created_at,kind,details) VALUES($1,$2,$3,$4)',[incident.id,'2026-11-19T13:01:00.000Z','monitoring_disabled','{"source":"panel"}']);
  const data=await history.list(new URLSearchParams({from:'2026-11-19',to:'2026-11-19'}));assert.equal(data.total,1);assert.equal(data.summary.deactivated,1);assert.equal(data.summary.resolved,0);assert.equal(data.incidents[0].duration_seconds,60);assert.equal(data.patterns.by_hour[0].hour,'10');
  assert.equal((await history.list(new URLSearchParams({kind:'all'}))).total,3);
  assert.equal((await history.list(new URLSearchParams({status:'resolved'}))).total,1);
  assert.equal((await history.detail(incident.id)).events[0].details.source,'panel');
  await assert.rejects(history.detail(999),e=>e.status===404);
  await assert.rejects(history.list(new URLSearchParams({from:'2026-02-30'})),e=>e.code==='invalid_filter');
});
test('asynchronous activity retains real attribution, correlated outcomes and instance-scoped filter choices',async t=>{
  const {db}=await engineFixture(t),activity=createPostgresInstanceActivity(db),actor=activity.userActor({id:'admin1',name:'Admin A',email:'a@example.test',role:'admin'});
  const a={id:'abcd1234',name:'Canal A'},b={id:'bbbb1234',name:'Canal B'};
  for(const i of [a,b])await db.run('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',[i.id,i.name,'synthetic','date','date']);
  const payload={instance:a,actor,action:'token_rotated',before:{configured:true}};
  assert.equal(await activity.run(payload,async()=>42,r=>({result:r})),42);
  await activity.record({instance:b,actor:{...actor,id:'admin2',name:'Other admin'},action:'messages_viewed',source:'panel'});
  const scoped=await activity.list(new URLSearchParams({instance_id:b.id}),a.id);
  assert.equal(scoped.total,2);assert.equal(scoped.actors.length,1);assert.equal(scoped.actors[0].id,'admin1');assert.deepEqual(scoped.actions,['token_rotated']);assert.deepEqual(scoped.instances,[]);
  assert.equal(scoped.events[0].request_id,scoped.events[1].request_id);assert.equal(scoped.events[0].after.result,42);
  await assert.rejects(activity.run({...payload,action:'instance_deactivated'},async()=>{throw Object.assign(new Error('synthetic private URL'),{status:409,code:'instance_disabled'});}),e=>e.status===409);
  const failures=await activity.list(new URLSearchParams({outcome:'failed'}));assert.equal(failures.total,1);assert.equal(failures.events[0].details.error_code,'instance_disabled');assert.ok(!JSON.stringify(failures).includes('synthetic private URL'));
  assert.equal((await activity.list()).total,5); // Reading history is not itself an activity event.
  const safe=activity.snapshot({name:'Canal',active:1,webhook_url:'https://example.test/private/path?token=secret',settings:'{"sendDelay":2,"unknown_secret":"hidden"}'});
  assert.ok(!JSON.stringify(safe).includes('secret'));assert.equal(safe.settings.sendDelay,2);
  await assert.rejects(db.run('DELETE FROM instance_activity'),e=>e.code==='42501');
});
test('number-change activity is atomic and quiet reconnects preserve the last confirmed number without redundant events',async t=>{
  const {db}=await engineFixture(t),activity=createPostgresInstanceActivity(db);
  await db.run("INSERT INTO instances(id,name,token,created_at,updated_at,last_connected_phone) VALUES('abcd1234','Canal','synthetic','date','date','551100000001')");
  await activity.connectionState('abcd1234','authenticated','Natural reconnect',{source:'whatsapp',phone:'551100000001',suppressConnectionEvent:true});assert.equal((await activity.list()).total,0);
  await activity.connectionState('abcd1234','authenticated','New number',{source:'whatsapp',phone:'551100000002',suppressConnectionEvent:true});
  const events=(await activity.list()).events;assert.equal(events.length,1);assert.equal(events[0].action,'connection_number_changed');assert.equal(events[0].before.phone,'551100000001');assert.equal(events[0].after.phone,'551100000002');
  const actor=activity.userActor({id:'admin1',name:'Admin',email:'a@example.test',role:'admin'});
  const context=await activity.begin({instance:{id:'abcd1234',name:'Canal'},actor,action:'connect_requested'});
  await activity.connectionState('abcd1234','authenticated','Confirmed',{phone:'551100000003',source:'whatsapp',auditContext:context});
  const logged=await activity.list(new URLSearchParams({action:'connection_established'}));assert.equal(logged.events[0].actor_id,'admin1');assert.equal(logged.events[0].request_id,context.request_id);
  assert.equal((await db.get("SELECT last_connected_phone FROM instances WHERE id='abcd1234'")).last_connected_phone,'551100000003');
});
test('store with restricted role rejects mismatched key and incomplete schema instead of initializing or falling back',async t=>{
  const {db,engine,schema}=await engineFixture(t),key=Buffer.alloc(32,9).toString('base64'),crypto=await loadPersistenceCrypto({keyBase64:key});
  await engine.query('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES($1,$2,$3,$4,$5)',['abcd1234','Test',crypto.encrypt('existing'),'date','date']);
  await engine.exec('CREATE ROLE wa_restricted;GRANT USAGE ON SCHEMA '+schema+' TO wa_restricted;GRANT SELECT ON ALL TABLES IN SCHEMA '+schema+' TO wa_restricted;SET ROLE wa_restricted');
  // Inject a wrapper so an intentional startup failure does not close the fixture pool.
  const borrowed={...db,close:async()=>{}};
  await assert.rejects(openPostgresStore({db:borrowed,schema,keyBase64:Buffer.alloc(32,10).toString('base64')}),e=>e.code==='PERSISTENCE_DECRYPT_FAILED');
  await engine.exec('RESET ROLE;ALTER TABLE instances ADD COLUMN unexpected TEXT;SET ROLE wa_restricted');
  await assert.rejects(openPostgresStore({db:borrowed,schema,keyBase64:key}),e=>e.code==='DATABASE_SCHEMA_MISMATCH');
});
