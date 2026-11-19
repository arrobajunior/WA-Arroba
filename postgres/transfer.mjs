import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,createDecipheriv,timingSafeEqual} from 'node:crypto';
import {readFile,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';

export const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
const schemaSql=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
const invariantsSql=await readFile(new URL('./invariants.sql',import.meta.url),'utf8');
const identifier=value=>'"'+value.replaceAll('"','""')+'"';
const fail=code=>Object.assign(new Error(code),{code});
const order=(t,pg=false)=>t.columns.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>identifier(c.name)+(pg&&c.type==='TEXT'?' COLLATE "C"':'')).join(',');
const normalized=(value,type)=>value===null?null:type==='BLOB'?['bytes',Buffer.from(value).toString('base64')]:type==='INTEGER'?['int',String(value)]:['text',value];
function addRow(hash,row,t){
  const serialized=JSON.stringify(t.columns.map(c=>normalized(row[c.name],c.type)));
  hash.update(String(Buffer.byteLength(serialized))+':'+serialized+'\n');
}
function sourceDigest(db,t){
  const hash=createHash('sha256');let count=0;
  for(const row of db.prepare(`SELECT * FROM ${identifier(t.name)} ORDER BY ${order(t)}`).iterate()){addRow(hash,row,t);count++;}
  return {count,sha256:hash.digest('hex')};
}
export function inspectSource(db){
  // Work only on the exact known schema: unknown tables/columns cannot be silently dropped.
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  if(JSON.stringify(names)!==JSON.stringify(manifest.map(t=>t.name).sort()))throw fail('SOURCE_SCHEMA_MISMATCH');
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw fail('SOURCE_INTEGRITY_FAILED');
  const result={};
  for(const t of manifest){
    const actual=db.prepare(`PRAGMA table_info(${identifier(t.name)})`).all().map(c=>({name:c.name,type:c.type,pk:c.pk}));
    if(JSON.stringify(actual)!==JSON.stringify(t.columns))throw fail('SOURCE_SCHEMA_MISMATCH');
    result[t.name]=sourceDigest(db,t);
  }
  return result;
}
function decrypt(key,value){
  const bytes=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]);
}
function validateKey(db,key){
  if(key.length!==32)throw fail('INVALID_MASTER_KEY');
  try{
    for(const r of db.prepare('SELECT token FROM instances WHERE token_encrypted=1').iterate())decrypt(key,r.token);
    for(const r of db.prepare('SELECT value FROM wa_keys').iterate())decrypt(key,r.value);
  }catch{throw fail('MASTER_KEY_MISMATCH');}
}
export async function createSnapshot(sourceDirectory,targetDirectory){
  const source=path.resolve(sourceDirectory),target=path.resolve(targetDirectory);
  // Exclusive new directory; never overwrite an old backup, key or live database.
  if(target===source||source.startsWith(target+path.sep)||target.startsWith(source+path.sep))throw fail('UNSAFE_SNAPSHOT_PATH');
  await mkdir(target,{mode:0o700});
  let db;
  try{
    const key=await readFile(path.join(source,'master.key'));
    db=new DatabaseSync(path.join(source,'platform.sqlite'),{readOnly:true});
    await backup(db,path.join(target,'platform.sqlite'));
    await chmod(path.join(target,'platform.sqlite'),0o600);
    await writeFile(path.join(target,'master.key'),key,{mode:0o600,flag:'wx'});
    // Read a second time so an unexpected key rotation aborts, rather than producing an unusable bundle.
    const current=await readFile(path.join(source,'master.key'));
    if(current.length!==key.length||!timingSafeEqual(current,key))throw fail('MASTER_KEY_CHANGED');
    const snapshot=new DatabaseSync(path.join(target,'platform.sqlite'),{readOnly:true});
    try{
      validateKey(snapshot,key);const tables=inspectSource(snapshot);
      const report={format:1,createdAt:new Date().toISOString(),final:false,tables};
      await writeFile(path.join(target,'manifest.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
      return {directory:target,counts:Object.fromEntries(Object.entries(tables).map(([name,r])=>[name,r.count]))};
    }finally{snapshot.close();}
  }catch(e){await rm(target,{recursive:true,force:true});throw e;}finally{db?.close();}
}
export async function transferSnapshot(client,directory,{schema,apply=false}={}){
  // Separate explicit connection must be passed by caller. No implicit DATABASE_URL switch.
  if(!/^wa_(rehearsal_[a-z0-9_]{1,40}|app)$/.test(schema||''))throw fail('INVALID_TARGET_SCHEMA');
  const key=await readFile(path.join(directory,'master.key'));
  const db=new DatabaseSync(path.join(directory,'platform.sqlite'),{readOnly:true});
  let inTransaction=false;
  try{
    db.exec('BEGIN');validateKey(db,key);const tables=inspectSource(db);
    const saved=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
    if(saved.format!==1||JSON.stringify(saved.tables)!==JSON.stringify(tables))throw fail('SNAPSHOT_CHANGED');
    if(!apply)return {applied:false,schema,counts:Object.fromEntries(Object.entries(tables).map(([n,r])=>[n,r.count]))};
    await client.query('BEGIN');inTransaction=true;
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    // Fixed lock prevents two importers from racing in one target database.
    await client.query('SELECT pg_advisory_xact_lock(178613,1)');
    const exists=await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema]);
    if(exists.rows.length)throw fail('TARGET_SCHEMA_EXISTS');
    await client.query(`CREATE SCHEMA ${identifier(schema)}`);
    await client.query(`SET LOCAL search_path TO ${identifier(schema)}, pg_catalog`);
    await client.query(schemaSql);
    for(const t of manifest){
      const columns=t.columns.map(c=>identifier(c.name)).join(',');let batch=[];
      const flush=async()=>{
        if(!batch.length)return;const args=[];
        const tuples=batch.map(row=>'('+t.columns.map(c=>{args.push(c.type==='BLOB'&&row[c.name]!==null?Buffer.from(row[c.name]):row[c.name]);return '$'+args.length;}).join(',')+')').join(',');
        await client.query(`INSERT INTO ${identifier(t.name)} (${columns}) VALUES ${tuples}`,args);batch=[];
      };
      for(const row of db.prepare(`SELECT * FROM ${identifier(t.name)} ORDER BY ${order(t)}`).iterate()){
        batch.push(row);if(batch.length===100)await flush();
      }
      await flush();
      // Keyset-free OFFSET is only for this offline verification, under an exclusive import transaction.
      let offset=0,count=0;const hash=createHash('sha256');
      for(;;){
        const page=await client.query(`SELECT * FROM ${identifier(t.name)} ORDER BY ${order(t,true)} LIMIT 500 OFFSET $1`,[offset]);
        for(const row of page.rows){addRow(hash,row,t);count++;}
        if(page.rows.length<500)break;offset+=500;
      }
      if(count!==tables[t.name].count||hash.digest('hex')!==tables[t.name].sha256)throw fail('TARGET_VERIFICATION_FAILED');
      if(t.identity){
        const seq=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(t.name)?.seq||0;
        const max=db.prepare(`SELECT COALESCE(max(${identifier(t.identity)}),0) AS n FROM ${identifier(t.name)}`).get().n;
        const high=Math.max(Number(seq),Number(max));if(!Number.isSafeInteger(high))throw fail('IDENTITY_OUT_OF_RANGE');
        await client.query('SELECT setval(pg_get_serial_sequence($1,$2),$3,$4)',[t.name,t.identity,Math.max(1,high),high>0]);
      }
    }
    await client.query(invariantsSql);
    // Trusted objects live in this schema; PUBLIC may neither access nor shadow them.
    await client.query(`REVOKE ALL ON SCHEMA ${identifier(schema)} FROM PUBLIC`);
    await client.query('COMMIT');inTransaction=false;
    return {applied:true,schema,counts:Object.fromEntries(Object.entries(tables).map(([n,r])=>[n,r.count]))};
  }catch(e){if(inTransaction)await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally{try{db.exec('ROLLBACK');}catch{}db.close();}
}
