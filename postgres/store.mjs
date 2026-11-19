import {readFile} from 'node:fs/promises';
import {connectPostgresDatabase} from './database.mjs';
import {loadPersistenceCrypto} from './persistence-crypto.mjs';

const manifest=JSON.parse(await readFile(new URL('./manifest.json',import.meta.url),'utf8'));
const fail=code=>Object.assign(new Error(code),{code});
export async function openPostgresStore({dataDir,keyBase64,databaseUrl,schema='wa_app',max=10,ssl,db:injectedDb}={}){
  // This entry point is deliberately not selected by server.mjs yet.
  const crypto=await loadPersistenceCrypto({dataDir,keyBase64});
  const db=injectedDb||connectPostgresDatabase({databaseUrl,schema,max,ssl});
  try{
    if(db.schema!==schema)throw fail('DATABASE_SCHEMA_MISMATCH');
    await db.transaction(async tx=>{
      const role=await tx.get("SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,n.nspowner::regrole::text=current_user AS owns_schema,pg_has_role(current_user,n.nspowner,'MEMBER') AS can_assume_owner,has_schema_privilege(current_user,n.oid,'CREATE') AS can_create_objects FROM pg_roles r JOIN pg_namespace n ON n.nspname=$1 WHERE r.rolname=current_user",[schema]);
      if(!role||role.rolsuper||role.rolbypassrls||role.rolcreatedb||role.rolcreaterole||role.owns_schema||role.can_assume_owner||role.can_create_objects)throw fail('DATABASE_ROLE_TOO_PRIVILEGED');
      const owned=await tx.get('SELECT count(*) AS n FROM pg_tables WHERE schemaname=$1 AND tableowner=current_user',[schema]);
      if(owned.n)throw fail('DATABASE_ROLE_TOO_PRIVILEGED');
      const columns=await tx.all('SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=$1 ORDER BY table_name,ordinal_position',[schema]);
      const types={TEXT:'text',INTEGER:'bigint',BLOB:'bytea'};
      for(const table of manifest){
        const actual=columns.filter(c=>c.table_name===table.name).map(c=>[c.column_name,c.data_type]);
        if(JSON.stringify(actual)!==JSON.stringify(table.columns.map(c=>[c.name,types[c.type]])))throw fail('DATABASE_SCHEMA_MISMATCH');
      }
      const triggers=await tx.all("SELECT c.relname AS table_name,t.tgname,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal",[schema]);
      for(const [table,name] of [['admin_audit','admin_audit_no_update'],['instance_activity','instance_activity_no_update'],['users','users_master_update'],['messages','message_api_id']]){
        if(!triggers.some(t=>t.table_name===table&&t.tgname===name&&['O','A'].includes(t.tgenabled)))throw fail('DATABASE_INVARIANTS_MISSING');
      }
      // A mismatched key aborts startup before any operational writes or WhatsApp sockets.
      for(const row of await tx.all('SELECT token FROM instances WHERE token_encrypted=1'))crypto.decrypt(row.token);
      for(const row of await tx.all("SELECT value FROM wa_keys WHERE kind='creds'"))crypto.decrypt(row.value);
    },{readOnly:true,isolation:'REPEATABLE READ'});
    return {db,...crypto,backend:'postgresql',close:()=>db.close()};
  }catch(error){await db.close().catch(()=>{});throw error;}
}
