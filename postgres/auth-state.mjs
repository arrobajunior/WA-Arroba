import {BufferJSON,initAuthCreds,proto} from '@whiskeysockets/baileys';
import {createSerialTasks} from './serial-tasks.mjs';

// Same encrypted wa_keys rows and Baileys data format as the SQLite transport.
// Caller must hold sole ownership of the WhatsApp session before using this state.
export async function createPostgresAuthState(store,id,{valid=()=>true}={}){
  const {db,encrypt,decrypt}=store,queue=createSerialTasks();let open=true;
  if(!(await db.get('SELECT active FROM instances WHERE id=$1',[id]))?.active)throw Object.assign(new Error('Instância desativada ou inexistente.'),{status:409,code:'instance_disabled'});
  const current=()=>open&&valid(),key='credentials';
  const read=async(type,ids)=>{
    if(!current())return {};
    const rows=await db.all('SELECT key_id,value FROM wa_keys WHERE instance_id=$1 AND kind=$2 AND key_id=ANY($3::text[])',[id,type,ids]);
    if(!current())return {};
    const found=new Map(rows.map(r=>[r.key_id,JSON.parse(decrypt(r.value),BufferJSON.reviver)]));
    return Object.fromEntries(ids.map(key=>{let value=found.get(key)??null;if(type==='app-state-sync-key'&&value)value=proto.Message.AppStateSyncKeyData.fromObject(value);return [key,value];}));
  };
  const saved=await read('creds',['main']),creds=saved.main||initAuthCreds();
  if(!current())throw Object.assign(new Error('STALE_AUTH_STATE'),{code:'STALE_AUTH_STATE'});
  const stale=()=>Object.assign(new Error('STALE_AUTH_STATE'),{code:'STALE_AUTH_STATE'});
  function write(entries){
    return queue.run(key,async()=>{
      if(!current())return;
      try{await db.transaction(async tx=>{
        const instance=await tx.get('SELECT active FROM instances WHERE id=$1 FOR UPDATE',[id]);
        if(!instance?.active||!current())return;
        for(const [kind,key_id,value] of entries){
          if(!current())throw stale();
          if(value===null)await tx.run('DELETE FROM wa_keys WHERE instance_id=$1 AND kind=$2 AND key_id=$3',[id,kind,key_id]);
          else await tx.run('INSERT INTO wa_keys(instance_id,kind,key_id,value) VALUES($1,$2,$3,$4) ON CONFLICT(instance_id,kind,key_id) DO UPDATE SET value=EXCLUDED.value',[id,kind,key_id,encrypt(value)]);
        }
        if(!current())throw stale();
      });}catch(error){if(error.code!=='STALE_AUTH_STATE')throw error;}
    });
  }
  const keys={
    get:(type,ids)=>queue.run(key,()=>read(type,ids)),
    set:data=>{
      if(!current())return Promise.resolve();
      // Snapshot at call time: Baileys may mutate buffers/creds while the database awaits I/O.
      const entries=[];
      for(const [kind,values] of Object.entries(data))for(const [key_id,value] of Object.entries(values))entries.push([kind,key_id,value==null?null:JSON.stringify(value,BufferJSON.replacer)]);
      return write(entries);
    }
  };
  return {state:{creds,keys},save:()=>current()?write([['creds','main',JSON.stringify(creds,BufferJSON.replacer)]]):Promise.resolve(),drain:()=>queue.idle(),invalidate:async()=>{open=false;await queue.idle();}};
}
