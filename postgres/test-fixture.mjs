import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPostgresDatabase} from './database.mjs';
import {loadPersistenceCrypto} from './persistence-crypto.mjs';

// Synthetic embedded-engine fixture, never a Railway connection or real session.
export async function postgresFixture(){
  const engine=new PGlite(),schema='wa_rehearsal_alerts';let tail=Promise.resolve();
  await engine.exec('CREATE SCHEMA '+schema+';SET search_path TO '+schema+',pg_catalog');
  await engine.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  await engine.exec(await readFile(new URL('./invariants.sql',import.meta.url),'utf8'));
  const queries=[],pool=new EventEmitter();
  pool.connect=async()=>{
    let unlock;const previous=tail;tail=new Promise(r=>unlock=r);await previous;
    return {query:(sql,args=[])=>{queries.push(sql);return engine.query(sql,args);},release:()=>unlock()};
  };pool.end=async()=>{};
  const db=createPostgresDatabase(pool,{schema}),crypto=await loadPersistenceCrypto({keyBase64:randomBytes(32).toString('base64')}),store={db,...crypto};
  const root={id:'a'.repeat(24),name:'Admin',email:'admin@example.test',role:'admin'},user={id:'b'.repeat(24),name:'Owner',email:'owner@example.test',role:'user'};
  for(const row of [root,user])await db.run('INSERT INTO users(id,name,email,password_hash,role,created_at,is_master) VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.name,row.email,'unused',row.role,'date',row===root?1:0]);
  const ids=['aaaa1111','bbbb2222','cccc3333'];
  for(const id of ids)await db.run('INSERT INTO instances(id,name,phone,token,owner_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[id,'Synthetic '+id,'5511000000000',crypto.encrypt('synthetic-token'),user.id,'2026-11-19T12:00:00.000Z']);
  await db.run("INSERT INTO general_settings(id,alert_email) VALUES(1,'alerts@example.test')");await db.run("INSERT INTO branding VALUES(1,'Synthetic app')");
  return {db,store,engine,root,user,ids,queries,close:async()=>{await db.close();await engine.close();}};
}
