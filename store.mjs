import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function openStore(directory) {
  mkdirSync(directory,{recursive:true,mode:0o700}); chmodSync(directory,0o700);
  const keyPath=path.join(directory,'master.key');
  let key;
  try { key=readFileSync(keyPath); } catch(e) {
    if(e.code!=='ENOENT')throw e;
    key=randomBytes(32); writeFileSync(keyPath,key,{flag:'wx',mode:0o600});
  }
  if(key.length!==32)throw new Error('Chave de persistência inválida.');
  const encrypt=(value)=>{
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  };
  const decrypt=(value)=>{
    const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
    cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
  };
  const db=new DatabaseSync(path.join(directory,'platform.sqlite'));
  chmodSync(path.join(directory,'platform.sqlite'),0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',token TEXT NOT NULL,settings TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,owner_id TEXT REFERENCES users(id),token_encrypted INTEGER NOT NULL DEFAULT 1,auto_connect INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,instance_id TEXT NOT NULL REFERENCES instances(id),recipient TEXT NOT NULL,body TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,ack TEXT NOT NULL,created_at TEXT NOT NULL,provider_id TEXT,error TEXT,direction TEXT NOT NULL DEFAULT 'out');
    CREATE INDEX IF NOT EXISTS messages_instance_created ON messages(instance_id,created_at);
    CREATE TABLE IF NOT EXISTS wa_keys(instance_id TEXT NOT NULL REFERENCES instances(id),kind TEXT NOT NULL,key_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(instance_id,kind,key_id));
    CREATE TABLE IF NOT EXISTS media(instance_id TEXT NOT NULL REFERENCES instances(id),message_id TEXT NOT NULL,mimetype TEXT NOT NULL,data BLOB NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(instance_id,message_id));
    CREATE INDEX IF NOT EXISTS media_created ON media(created_at);`);
  const columns=(table)=>db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  for(const [table,column,definition] of [['users','active','INTEGER NOT NULL DEFAULT 1'],['instances','owner_id','TEXT REFERENCES users(id)'],['instances','token_encrypted','INTEGER NOT NULL DEFAULT 0'],['instances','auto_connect','INTEGER NOT NULL DEFAULT 0'],['instances','webhook_url',"TEXT NOT NULL DEFAULT ''"],['messages','provider_id','TEXT'],['messages','error','TEXT'],['messages','direction',"TEXT NOT NULL DEFAULT 'out'"]]) {
    if(!columns(table).includes(column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS instances_owner ON instances(owner_id); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);');
  db.exec(`CREATE TABLE IF NOT EXISTS branding(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL);
    INSERT OR IGNORE INTO branding VALUES(1,'WhatsApp API');
    CREATE TABLE IF NOT EXISTS brand_assets(slot TEXT PRIMARY KEY,data BLOB NOT NULL,revision TEXT NOT NULL);`);
  for(const row of db.prepare('SELECT id,token FROM instances WHERE token_encrypted=0').all())db.prepare('UPDATE instances SET token=?,token_encrypted=1 WHERE id=?').run(encrypt(row.token),row.id);
  db.prepare("UPDATE messages SET status='unknown',error='Processo interrompido durante envio; confirme o recebimento antes de reenviar.' WHERE status='sending'").run();
  return {db,encrypt,decrypt,close:()=>db.close()};
}
