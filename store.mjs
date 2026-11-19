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
  // Only the legacy master is promoted during the one-time schema migration.
  for(const name of ['first_connected_at','last_connected_at'])if(!columns('instances').includes(name))db.exec(`ALTER TABLE instances ADD COLUMN ${name} TEXT`);
  // Existing phones/registered credentials are evidence of a past connection.
  for(const row of db.prepare('SELECT id,phone,updated_at FROM instances WHERE first_connected_at IS NULL').all()){
    let registered=false;
    try{const creds=db.prepare("SELECT value FROM wa_keys WHERE instance_id=? AND kind='creds' AND key_id='main'").get(row.id);registered=Boolean(creds&&JSON.parse(decrypt(creds.value)).registered);}catch{/* Preserve unreadable legacy state. */}
    const history=db.prepare("SELECT 1 FROM messages WHERE instance_id=? AND (direction='in' OR ack IN ('server','device','read','played')) LIMIT 1").get(row.id);
    if(row.phone||registered||history)db.prepare('UPDATE instances SET first_connected_at=?,last_connected_at=? WHERE id=?').run(row.updated_at,row.updated_at,row.id);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS general_settings(id INTEGER PRIMARY KEY CHECK(id=1),alert_email TEXT NOT NULL DEFAULT '',updated_at TEXT,updated_by TEXT);
    INSERT OR IGNORE INTO general_settings(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS admin_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,actor_email TEXT NOT NULL,action TEXT NOT NULL,before_value TEXT NOT NULL,after_value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connection_incidents(id INTEGER PRIMARY KEY AUTOINCREMENT,instance_id TEXT NOT NULL REFERENCES instances(id),opened_at TEXT NOT NULL,reason TEXT NOT NULL,resolved_at TEXT,notification_status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,recipient TEXT NOT NULL DEFAULT '',message_id TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS connection_incident_open ON connection_incidents(instance_id) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS connection_incident_pending ON connection_incidents(notification_status,next_attempt_at);
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit entries cannot be updated'); END;
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit entries cannot be deleted'); END;`);
  for(const [name,definition] of [
    ['instance_name',"TEXT NOT NULL DEFAULT ''"],['instance_phone',"TEXT NOT NULL DEFAULT ''"],['owner_name',"TEXT NOT NULL DEFAULT ''"],
    ['source',"TEXT NOT NULL DEFAULT 'unknown'"],['disconnect_code','INTEGER'],['last_event_at','TEXT'],['reconnect_attempts','INTEGER NOT NULL DEFAULT 0'],
    ['last_connected_at','TEXT'],['email_sent_at','TEXT'],['capture_version',"TEXT NOT NULL DEFAULT 'legacy'"],['deployment_id',"TEXT NOT NULL DEFAULT ''"],['app_commit',"TEXT NOT NULL DEFAULT ''"]
  ])if(!columns('connection_incidents').includes(name))db.exec(`ALTER TABLE connection_incidents ADD COLUMN ${name} ${definition}`);
  // Older incidents retain their original timestamps; reconstructed names are marked legacy.
  db.exec(`UPDATE connection_incidents SET
    instance_name=COALESCE((SELECT name FROM instances WHERE id=instance_id),''),
    instance_phone=COALESCE((SELECT phone FROM instances WHERE id=instance_id),''),
    owner_name=COALESCE((SELECT u.name FROM users u JOIN instances i ON i.owner_id=u.id WHERE i.id=instance_id),'')
    WHERE capture_version='legacy' AND instance_name='';
    CREATE INDEX IF NOT EXISTS connection_incident_time ON connection_incidents(opened_at,id);
    CREATE TABLE IF NOT EXISTS connection_incident_events(id INTEGER PRIMARY KEY AUTOINCREMENT,incident_id INTEGER NOT NULL REFERENCES connection_incidents(id),created_at TEXT NOT NULL,kind TEXT NOT NULL,details TEXT NOT NULL DEFAULT '{}');
    CREATE INDEX IF NOT EXISTS connection_incident_event_order ON connection_incident_events(incident_id,id);`);
  if(!columns('instances').includes('last_connected_phone')){db.exec("ALTER TABLE instances ADD COLUMN last_connected_phone TEXT NOT NULL DEFAULT ''");db.exec("UPDATE instances SET last_connected_phone=phone WHERE phone<>''");}
  db.exec(`CREATE TABLE IF NOT EXISTS connection_candidates(instance_id TEXT PRIMARY KEY REFERENCES instances(id),opened_at TEXT NOT NULL,due_at INTEGER NOT NULL,reason TEXT NOT NULL,metadata TEXT NOT NULL,snapshot TEXT NOT NULL,events TEXT NOT NULL DEFAULT '[]',reconnect_attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS connection_candidates_due ON connection_candidates(due_at);`);
  if(!columns('connection_incidents').includes('outage_kind')){
    db.exec("ALTER TABLE connection_incidents ADD COLUMN outage_kind TEXT NOT NULL DEFAULT 'confirmed'");
    // Preserve old notifications and timestamps, but stop counting proven brief auto-reconnections as outages.
    db.exec("UPDATE connection_incidents SET outage_kind='transient' WHERE resolved_at IS NOT NULL AND source='whatsapp' AND disconnect_code IN (408,428,500,503,515) AND julianday(resolved_at)>=julianday(opened_at) AND ROUND((julianday(resolved_at)-julianday(opened_at))*86400000)<60000");
  }
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY)');
  const hasActivity=Boolean(db.prepare("SELECT name FROM schema_migrations WHERE name='instance_activity_v1'").get());
  db.exec(`CREATE TABLE IF NOT EXISTS instance_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,instance_id TEXT,instance_name TEXT NOT NULL DEFAULT '',actor_id TEXT NOT NULL DEFAULT '',actor_name TEXT NOT NULL,actor_email TEXT NOT NULL DEFAULT '',actor_role TEXT NOT NULL DEFAULT '',actor_kind TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,source TEXT NOT NULL,request_id TEXT NOT NULL DEFAULT '',before_value TEXT NOT NULL DEFAULT '{}',after_value TEXT NOT NULL DEFAULT '{}',details TEXT NOT NULL DEFAULT '{}',peer_ip TEXT NOT NULL DEFAULT '',legacy_key TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS instance_activity_time ON instance_activity(created_at,id);
    CREATE INDEX IF NOT EXISTS instance_activity_instance ON instance_activity(instance_id,id);
    CREATE INDEX IF NOT EXISTS instance_activity_actor ON instance_activity(actor_id,id);
    CREATE TRIGGER IF NOT EXISTS instance_activity_no_update BEFORE UPDATE ON instance_activity BEGIN SELECT RAISE(ABORT,'Activity entries cannot be updated'); END;
    CREATE TRIGGER IF NOT EXISTS instance_activity_no_delete BEFORE DELETE ON instance_activity BEGIN SELECT RAISE(ABORT,'Activity entries cannot be deleted'); END;`);
  if(!hasActivity){
    db.exec('BEGIN');try{
      const insert=db.prepare('INSERT INTO instance_activity(created_at,instance_id,instance_name,actor_name,actor_kind,action,outcome,source,details,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for(const row of db.prepare('SELECT id,name,created_at FROM instances').all())insert.run(row.created_at,row.id,row.name,'Autoria não registrada','legacy','instance_created','observed','migration',JSON.stringify({historical:true}),'created:'+row.id);
      for(const row of db.prepare('SELECT * FROM connection_incidents').all()){
        insert.run(row.opened_at,row.instance_id,row.instance_name,'Sistema · registro anterior','legacy','connection_lost','observed','migration',JSON.stringify({historical:true,incident_id:row.id,reason:row.reason,code:row.disconnect_code}),'outage:'+row.id);
        if(row.resolved_at)insert.run(row.resolved_at,row.instance_id,row.instance_name,'Sistema · registro anterior','legacy','connection_established','observed','migration',JSON.stringify({historical:true,incident_id:row.id}),'recovered:'+row.id);
      }
      for(const row of db.prepare('SELECT * FROM admin_audit').all())db.prepare('INSERT INTO instance_activity(created_at,actor_id,actor_name,actor_email,actor_role,actor_kind,action,outcome,source,before_value,after_value,details,legacy_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.created_at,row.actor_id,row.actor_name,row.actor_email,'admin','user',row.action,row.action.endsWith('_failed')?'failed':row.action.endsWith('_requested')?'requested':'success','migration',row.before_value,row.after_value,JSON.stringify({historical:true}),'admin:'+row.id);
      db.prepare('INSERT INTO schema_migrations(name) VALUES(?)').run('instance_activity_v1');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
  }
  if(!columns('users').includes('is_master')){
    db.exec("ALTER TABLE users ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE users SET is_master=1,active=1 WHERE id=(SELECT id FROM users WHERE role='admin' ORDER BY created_at,id LIMIT 1)");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_single_master ON users(is_master) WHERE is_master=1;
    CREATE TRIGGER IF NOT EXISTS protect_master_delete BEFORE DELETE ON users WHEN OLD.is_master=1 BEGIN SELECT RAISE(ABORT,'Admin Master cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS protect_master_update BEFORE UPDATE ON users WHEN OLD.is_master=1 AND (NEW.is_master<>1 OR NEW.role<>'admin' OR NEW.active<>1 OR NEW.id<>OLD.id) BEGIN SELECT RAISE(ABORT,'Admin Master is protected'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS media_objects(instance_id TEXT NOT NULL REFERENCES instances(id),message_id TEXT NOT NULL,object_key TEXT NOT NULL,mimetype TEXT NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(instance_id,message_id));`);
  for(const [name,definition] of [['priority','INTEGER NOT NULL DEFAULT 10'],['reference_id',"TEXT NOT NULL DEFAULT ''"],['filename',"TEXT NOT NULL DEFAULT ''"]])if(!columns('messages').includes(name))db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);

  if(!columns('messages').includes('media_id'))db.exec("ALTER TABLE messages ADD COLUMN media_id TEXT");

  for(const [name,definition] of [['sent_at','INTEGER'],['queued_at','INTEGER'],['payload',"TEXT NOT NULL DEFAULT '{}'"],['source_url',"TEXT NOT NULL DEFAULT ''"]])if(!columns('messages').includes(name))db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
  db.prepare("UPDATE messages SET status='unsent',error='Mídia temporária expirada após reinício; reenvie o arquivo pelo cliente.' WHERE type<>'chat' AND status='queue' AND media_id IS NOT NULL AND source_url='' AND NOT EXISTS(SELECT 1 FROM media_objects WHERE media_objects.instance_id=messages.instance_id AND media_objects.message_id=messages.media_id)").run();
  db.exec(`CREATE TABLE IF NOT EXISTS api_messages(api_id INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE);
    INSERT OR IGNORE INTO api_messages(message_id) SELECT id FROM messages WHERE NOT EXISTS(SELECT 1 FROM api_messages a WHERE a.message_id=messages.id) ORDER BY created_at,id;
    CREATE TRIGGER IF NOT EXISTS message_api_id AFTER INSERT ON messages BEGIN INSERT INTO api_messages(message_id) VALUES(NEW.id); END;`);
  db.exec('CREATE INDEX IF NOT EXISTS instances_owner ON instances(owner_id); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);');
  db.exec(`CREATE TABLE IF NOT EXISTS branding(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL);
    INSERT OR IGNORE INTO branding VALUES(1,'WhatsApp API');
    CREATE TABLE IF NOT EXISTS brand_assets(slot TEXT PRIMARY KEY,data BLOB NOT NULL,revision TEXT NOT NULL);`);
  for(const row of db.prepare('SELECT id,token FROM instances WHERE token_encrypted=0').all())db.prepare('UPDATE instances SET token=?,token_encrypted=1 WHERE id=?').run(encrypt(row.token),row.id);
  db.prepare("UPDATE messages SET status='unknown',error='Processo interrompido durante envio; confirme o recebimento antes de reenviar.' WHERE status='sending'").run();
  return {db,encrypt,decrypt,close:()=>db.close()};
}
