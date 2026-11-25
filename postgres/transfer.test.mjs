import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PGlite} from '@electric-sql/pglite';
import {openStore} from '../store.mjs';
import {createSnapshot,transferSnapshot,inspectSource} from './transfer.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'wa-pg-prep-')),source=path.join(root,'live'),copy=path.join(root,'copy');
  const store=openStore(source),db=store.db,engine=new PGlite();
  const pg={query:(sql,args)=>args?engine.query(sql,args):engine.exec(sql).then(results=>results.at(-1)||{rows:[]}),exec:sql=>engine.exec(sql),close:()=>engine.close()};
  t.after(async()=>{store.close();await pg.close();await rm(root,{recursive:true,force:true});});
  db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,is_master) VALUES(?,?,?,?,?,?,1)').run('admin','Admin','admin@example.test','hash','admin','date');
  db.prepare('INSERT INTO instances(id,name,token,owner_id,created_at,updated_at,auto_connect,phone) VALUES(?,?,?,?,?,?,1,?)').run('i1','Teste',store.encrypt('test-token'),'admin','date','date','5511000000000');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('hashed-cookie','admin',1796000000000);
  db.prepare('INSERT INTO wa_keys VALUES(?,?,?,?)').run('i1','creds','main',store.encrypt('{"registered":true}'));
  db.prepare('INSERT INTO media VALUES(?,?,?,?,?)').run('i1','legacy','image/png',Buffer.from([0,255,1]),'date');
  db.prepare('INSERT INTO brand_assets VALUES(?,?,?)').run('logo',Buffer.from([4,0,7]),'r1');
  db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('message1','i1','5511000000001','Olá 💬\n"texto"','chat','sending','pending','date');
  db.prepare('INSERT INTO connection_incidents(instance_id,opened_at,reason) VALUES(?,?,?)').run('i1','date','test outage');
  db.prepare('INSERT INTO connection_incident_events(incident_id,created_at,kind) VALUES(?,?,?)').run(1,'date','outage_opened');
  db.prepare('INSERT INTO admin_audit(created_at,actor_id,actor_name,actor_email,action,before_value,after_value) VALUES(?,?,?,?,?,?,?)').run('date','admin','Admin','admin@example.test','test','{}','{}');
  // SQLite sequences retain deleted high-water marks. Import must not reuse public IDs.
  db.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='api_messages'");
  return {root,source,copy,store,db,pg};
}
test('consistent readonly snapshot includes WAL and exact master key without mutating live queues',async t=>{
  const {source,copy,db}=await fixture(t),before=inspectSource(db);
  const r=await createSnapshot(source,copy);assert.equal(r.counts.messages,1);
  assert.deepEqual(inspectSource(db),before);assert.equal(db.prepare('SELECT status FROM messages').get().status,'sending');
  assert.deepEqual(await readFile(path.join(source,'master.key')),await readFile(path.join(copy,'master.key')));
  for(const name of ['master.key','platform.sqlite','manifest.json'])assert.equal((await stat(path.join(copy,name))).mode&0o777,0o600);
  assert.equal((await stat(copy)).mode&0o777,0o700);
  await assert.rejects(createSnapshot(source,copy),e=>e.code==='EEXIST');
  await assert.rejects(createSnapshot(source,path.join(source,'nested')),e=>e.code==='UNSAFE_SNAPSHOT_PATH');
});
test('PostgreSQL rehearsal preserves every table, ciphertext, blobs, identity IDs and audit/master invariants',async t=>{
  const {source,copy,store,db,pg}=await fixture(t);await createSnapshot(source,copy);
  const dry=await transferSnapshot(null,copy,{schema:'wa_rehearsal_test'});assert.equal(dry.applied,false);
  const imported=await transferSnapshot(pg,copy,{schema:'wa_rehearsal_test',apply:true});assert.equal(imported.applied,true);
  await pg.exec('SET search_path TO wa_rehearsal_test,pg_catalog');
  assert.equal((await pg.query('SELECT body,status FROM messages')).rows[0].body,'Olá 💬\n"texto"');
  assert.equal((await pg.query('SELECT status FROM messages')).rows[0].status,'sending');
  assert.equal(store.decrypt((await pg.query('SELECT token FROM instances')).rows[0].token),'test-token');
  assert.deepEqual(Buffer.from((await pg.query('SELECT data FROM media')).rows[0].data),Buffer.from([0,255,1]));
  assert.equal(Number((await pg.query('SELECT expires_at FROM sessions')).rows[0].expires_at),1796000000000);
  await assert.rejects(pg.query('UPDATE admin_audit SET action=$1',['tamper']),e=>e.code==='42501');
  // Ensure a row exists for DELETE trigger (empty table does not invoke it).
  await pg.query("INSERT INTO instance_activity(created_at,actor_name,actor_kind,action,outcome,source) VALUES('date','A','user','test','success','panel')");
  await assert.rejects(pg.query('DELETE FROM instance_activity'),e=>e.code==='42501');
  await assert.rejects(pg.query('DELETE FROM users WHERE id=$1',['admin']),e=>e.code==='42501');
  await assert.rejects(pg.query('UPDATE users SET active=0 WHERE id=$1',['admin']),e=>e.code==='42501');
  await pg.query("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES('new','i1','x','body','chat','queue','pending','date')");
  assert.equal(Number((await pg.query("SELECT api_id FROM api_messages WHERE message_id='new'")).rows[0].api_id),101);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n,1);
  await assert.rejects(transferSnapshot(pg,copy,{schema:'wa_rehearsal_test',apply:true}),e=>e.code==='TARGET_SCHEMA_EXISTS');
});
test('wrong key, changed snapshot or unexpected source schema fails closed before PostgreSQL writes',async t=>{
  const {source,copy,pg}=await fixture(t);await createSnapshot(source,copy);
  const key=await readFile(path.join(copy,'master.key'));await writeFile(path.join(copy,'master.key'),Buffer.alloc(32));
  await assert.rejects(transferSnapshot(pg,copy,{schema:'wa_rehearsal_key',apply:true}),e=>e.code==='MASTER_KEY_MISMATCH');
  await writeFile(path.join(copy,'master.key'),key);const db=new DatabaseSync(path.join(copy,'platform.sqlite'));
  db.prepare('UPDATE messages SET body=?').run('changed');db.close();
  await assert.rejects(transferSnapshot(pg,copy,{schema:'wa_rehearsal_tamper',apply:true}),e=>e.code==='SNAPSHOT_CHANGED');
  assert.equal((await pg.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'wa_%'")).rows.length,0);
  await assert.rejects(transferSnapshot(pg,copy,{schema:'public;DROP SCHEMA public'}),e=>e.code==='INVALID_TARGET_SCHEMA');
});
test('failed PostgreSQL import rolls back the whole schema instead of leaving a partial migration',async t=>{
  const {source,copy,pg}=await fixture(t);await createSnapshot(source,copy);
  const client={query:async(sql,args)=>{if(sql.startsWith('INSERT INTO "messages"'))throw Object.assign(new Error('simulated'),{code:'TEST_FAILURE'});return pg.query(sql,args);}};
  await assert.rejects(transferSnapshot(client,copy,{schema:'wa_rehearsal_rollback',apply:true}),e=>e.code==='TEST_FAILURE');
  assert.equal((await pg.query("SELECT 1 FROM pg_namespace WHERE nspname='wa_rehearsal_rollback'")).rows.length,0);
  await transferSnapshot(pg,copy,{schema:'wa_rehearsal_rollback',apply:true});
});
test('schema drift is rejected rather than silently omitting extra data',async t=>{
  const {source,copy,db}=await fixture(t);
  db.exec('CREATE TABLE future_feature(id TEXT PRIMARY KEY,data TEXT)');
  await assert.rejects(createSnapshot(source,copy),e=>e.code==='SOURCE_SCHEMA_MISMATCH');
  await assert.rejects(stat(copy),e=>e.code==='ENOENT');
  db.exec('DROP TABLE future_feature');
  db.exec('ALTER TABLE instances ADD COLUMN future_column TEXT');
  await assert.rejects(createSnapshot(source,copy),e=>e.code==='SOURCE_SCHEMA_MISMATCH');
});
test('verification detects a wrong destination row and rolls back without logging content',async t=>{
  const {source,copy,pg}=await fixture(t);await createSnapshot(source,copy);
  const client={query:async(sql,args)=>{
    const result=await pg.query(sql,args);
    if(sql.startsWith('SELECT * FROM "messages"'))result.rows[0].body='not the original';
    return result;
  }};
  await assert.rejects(transferSnapshot(client,copy,{schema:'wa_rehearsal_badcopy',apply:true}),e=>e.code==='TARGET_VERIFICATION_FAILED');
  assert.equal((await pg.query("SELECT 1 FROM pg_namespace WHERE nspname='wa_rehearsal_badcopy'")).rows.length,0);
});


test('historical physical column order preserves snapshot hashes and every imported value',async t=>{
  const {source,copy,db,pg}=await fixture(t),before=inspectSource(db);
  db.exec('PRAGMA foreign_keys=OFF');
  for(const name of ['instances','messages']){
    const columns=db.prepare(`PRAGMA table_info("${name}")`).all().reverse();
    const objects=db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('trigger','index') AND sql IS NOT NULL").all(name);
    const names=columns.map(c=>'"'+c.name+'"').join(',');
    db.exec(`CREATE TABLE "reordered_${name}" (${columns.map(c=>'"'+c.name+'" '+c.type+(c.pk?' PRIMARY KEY':'')).join(',')})`);
    db.exec(`INSERT INTO "reordered_${name}" (${names}) SELECT ${names} FROM "${name}"`);
    db.exec(`DROP TABLE "${name}"`);db.exec(`ALTER TABLE "reordered_${name}" RENAME TO "${name}"`);
    for(const object of objects)db.exec(object.sql);
  }
  db.exec('PRAGMA foreign_keys=ON');assert.deepEqual(inspectSource(db),before);
  await createSnapshot(source,copy);await transferSnapshot(pg,copy,{schema:'wa_rehearsal_order',apply:true});
  assert.equal((await pg.query('SELECT body FROM wa_rehearsal_order.messages')).rows[0].body,'Olá 💬\n"texto"');
  assert.equal((await pg.query('SELECT token FROM wa_rehearsal_order.instances')).rows[0].token,db.prepare('SELECT token FROM instances').get().token);
});
