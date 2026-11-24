import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openStore} from '../store.mjs';
import {createSnapshot,transferSnapshot,manifest} from './transfer.mjs';
import {openPostgresStore} from './store.mjs';
import {acquirePostgresTransportOwnership} from './transport-ownership.mjs';
import {createPostgresMessageQueue} from './message-queue.mjs';

// This destructive fixture is restricted to an explicitly opted-in, disposable local CI database.
// Never supply Railway URLs or real snapshots/keys. No WhatsApp or SMTP is constructed.
test('isolated PostgreSQL TCP/TLS import, restricted runtime, concurrent ownership/claims and dump restore',
 {skip:!process.env.PG_REHEARSAL_ADMIN_URL,timeout:120000},async t=>{
 const url=new URL(process.env.PG_REHEARSAL_ADMIN_URL);
 assert.equal(process.env.PG_REHEARSAL_ALLOW_CREATE,'synthetic-only');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/wa_rehearsal_ci');assert.equal(url.search,'');
 const container=process.env.PG_REHEARSAL_CONTAINER;assert.match(container||'',/^wa-pg-ci-[a-z0-9]+$/);
 const ssl={ca:await readFile(process.env.PG_REHEARSAL_CA_FILE,'utf8'),rejectUnauthorized:true};
 const admin=new Client({connectionString:url.toString(),ssl,connectionTimeoutMillis:5000});await admin.connect();
 const schema='wa_rehearsal_ci_'+randomBytes(4).toString('hex'),role='wa_runtime_'+randomBytes(4).toString('hex'),password=randomBytes(24).toString('hex');
 const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password=password;
 const dir=await mkdtemp(path.join(tmpdir(),'wa-real-ci-')),source=path.join(dir,'source'),copy=path.join(dir,'snapshot');
 let store,owner,sqlite,createdRestore=false,imageStarted=false;const execute=promisify(execFile),restoreDb='wa_rehearsal_restore_ci';
 t.after(async()=>{
   await owner?.release();await store?.close();sqlite?.close();
   if(createdRestore)await admin.query('DROP DATABASE '+restoreDb+' WITH (FORCE)');
   await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.query('DROP ROLE IF EXISTS '+role);await admin.end();await rm(dir,{recursive:true,force:true});
 });
 sqlite=openStore(source);const db=sqlite.db,date=new Date().toISOString();
 db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at,is_master) VALUES(?,?,?,?,?,?,1)').run('admin','Synthetic','synthetic@example.test','unused','admin',date);
 db.prepare('INSERT INTO instances(id,name,token,owner_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('aaaa1111','Synthetic',sqlite.encrypt('synthetic-token'),'admin',date,date);
 for(let n=0;n<3;n++)db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('m'+n,'aaaa1111','5511000000000','Synthetic 💬 '+n,'chat','queue','pending',date);
 await createSnapshot(source,copy);await transferSnapshot(admin,copy,{schema,apply:true});sqlite.close();sqlite=null;
 await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);await admin.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
 await admin.query(`REVOKE UPDATE,DELETE ON ${schema}.admin_audit,${schema}.instance_activity FROM ${role}`);
 store=await openPostgresStore({databaseUrl:runtimeUrl.toString(),schema,ssl,dataDir:copy,max:4});
 assert.equal(store.decrypt((await store.db.get('SELECT token FROM instances')).token),'synthetic-token');
 assert.equal((await store.db.get('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).ssl,true);
 const untrusted=new Client({connectionString:runtimeUrl.toString(),ssl:{rejectUnauthorized:true},connectionTimeoutMillis:5000});await assert.rejects(untrusted.connect());await untrusted.end().catch(()=>{});
 await assert.rejects(store.db.run('CREATE TABLE forbidden(id text)'));await assert.rejects(store.db.run('UPDATE users SET active=0 WHERE is_master=1'));
 owner=await acquirePostgresTransportOwnership({databaseUrl:runtimeUrl.toString(),schema,ssl});await owner.assert(store.db);
 await assert.rejects(acquirePostgresTransportOwnership({databaseUrl:runtimeUrl.toString(),schema,ssl}),e=>e.code==='TRANSPORT_ALREADY_OWNED');
 const queue=createPostgresMessageQueue(store,{ownership:owner});
 const claims=await Promise.all([queue.claim('aaaa1111','p1'),queue.claim('aaaa1111','p2'),queue.claim('aaaa1111','p3')]);assert.equal(new Set(claims.map(r=>r.id)).size,3);assert.equal(await queue.claim('aaaa1111','p4'),null);
 await queue.acknowledge('aaaa1111','p1',4);await queue.acknowledge('aaaa1111','p1',2);assert.equal((await store.db.get('SELECT ack FROM messages WHERE provider_id=$1',['p1'])).ack,'read');
 // Boot the built image against the synthetic runtime role. No WA sessions/SMTP exist.
 await owner.release();owner=null;
 const envFile=path.join(dir,'image.env');await writeFile(envFile,[
 'PG_RUNTIME_ENABLED=true','PG_RESTORE_CONNECTIONS=false','PUBLIC_URL=http://127.0.0.1:3211','PORT=3211','HOST=127.0.0.1',
 'DATABASE_URL='+runtimeUrl.toString(),'PG_SCHEMA='+schema,'PG_CA_FILE=/tls/server.crt',
 'PERSISTENCE_KEY_BASE64='+(await readFile(path.join(copy,'master.key'))).toString('base64')
 ].join('\n'),{mode:0o600});
 try{
   await execute('docker',['run','-d','--name','wa-runtime-ci-test','--network','host','--env-file',envFile,'-v',path.dirname(process.env.PG_REHEARSAL_CA_FILE)+':/tls:ro','wa-postgres:rehearsal']);imageStarted=true;
   let ready=false;for(let attempt=0;attempt<40;attempt++){try{if((await fetch('http://127.0.0.1:3211/api/ready')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.equal(ready,true);
   assert.equal((await fetch('http://127.0.0.1:3211/api/dashboard')).status,401);
   await execute('docker',['stop','--time','20','wa-runtime-ci-test']);
   const result=await execute('docker',['inspect','--format','{{.State.ExitCode}}','wa-runtime-ci-test']);assert.equal(result.stdout.trim(),'0');
 }finally{if(imageStarted)await execute('docker',['rm','-f','wa-runtime-ci-test']).catch(()=>{});}
 owner=await acquirePostgresTransportOwnership({databaseUrl:runtimeUrl.toString(),schema,ssl});await owner.assert(store.db);
 // Actual pg_dump/pg_restore runs inside the disposable service container. The dump contains only synthetic records.
 await execute('docker',['exec',container,'pg_dump','-U','postgres','-d','wa_rehearsal_ci','-Fc','-f','/tmp/wa-ci.dump']);
 await admin.query('CREATE DATABASE '+restoreDb);createdRestore=true;
 await execute('docker',['exec',container,'pg_restore','-U','postgres','-d',restoreDb,'--exit-on-error','/tmp/wa-ci.dump']);
 const restoredUrl=new URL(url);restoredUrl.pathname='/'+restoreDb;const restored=new Client({connectionString:restoredUrl.toString(),ssl});await restored.connect();
 try{for(const table of manifest){const columns=table.columns.map(c=>'"'+c.name+'"').join(',');const query=`SELECT ${columns} FROM ${schema}."${table.name}"`;const a=(await admin.query(query)).rows,b=(await restored.query(query)).rows;const canonical=rows=>rows.map(row=>JSON.stringify(row)).sort();assert.deepEqual(canonical(b),canonical(a),table.name);}}finally{await restored.end();}
 await owner.release();await assert.rejects(owner.assert(store.db));owner=await acquirePostgresTransportOwnership({databaseUrl:runtimeUrl.toString(),schema,ssl});await owner.assert(store.db);
});
