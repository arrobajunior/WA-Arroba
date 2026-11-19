import {Client} from 'pg';
import {randomBytes} from 'node:crypto';
import {postgresPoolOptions} from './database.mjs';

const fail=code=>Object.assign(new Error(code),{code,status:503});
// One dedicated connection for the whole transport, not one connection per WhatsApp instance.
// Must be acquired before restoring sockets or recovering ambiguous sends.
export async function acquirePostgresTransportOwnership({databaseUrl,schema='wa_app',ssl,heartbeatMs=5000,clientFactory=config=>new Client(config)}={}){
  if(!/^wa_(app|rehearsal_[a-z0-9_]{1,40})$/.test(schema)||!Number.isInteger(heartbeatMs)||heartbeatMs<10)throw fail('INVALID_OWNERSHIP_CONFIG');
  const options=postgresPoolOptions({databaseUrl,ssl}),client=clientFactory({...options,application_name:'wa-arroba-owner',query_timeout:10000});
  const listeners=new Set();let active=false,ended=false,timer,checking=false,endPromise;
  const end=()=>endPromise??=(Promise.resolve().then(()=>client.end()));
  const emitLost=()=>{const callbacks=[...listeners];listeners.clear();for(const fn of callbacks)try{fn();}catch{}};
  const lose=()=>{if(!active)return;active=false;clearInterval(timer);emitLost();void end().catch(()=>{});};
  client.on('error',lose);client.on('end',lose);
  try{
    await client.connect();
    const row=(await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_database()||':'||$1,0)) AS acquired,pg_backend_pid() AS pid,hashtextextended(current_database()||':'||$1,0)::text AS lock_key",[schema])).rows[0];
    if(!row?.acquired)throw fail('TRANSPORT_ALREADY_OWNED');
    // Random companion lock proves the data pool is looking at this exact owner connection,
    // even if a misconfigured second database has the same name, schema and reused backend pid.
    let proof;do{proof=randomBytes(8).readBigInt64BE().toString();}while(proof===row.lock_key);
    await client.query('SELECT pg_advisory_lock($1::bigint)',[proof]);active=true;
    async function assert(tx){
      if(!active)throw fail('TRANSPORT_OWNERSHIP_LOST');
      try{
        const locked=await tx.get("SELECT count(DISTINCT (classid,objid))=2 AS owned FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted AND objsubid=1 AND ((classid=(($2::bigint >> 32)&4294967295)::oid AND objid=($2::bigint&4294967295)::oid) OR (classid=(($3::bigint >> 32)&4294967295)::oid AND objid=($3::bigint&4294967295)::oid)) AND database=(SELECT oid FROM pg_database WHERE datname=current_database())",[row.pid,row.lock_key,proof]);
        if(!active||!locked.owned)throw fail('TRANSPORT_OWNERSHIP_LOST');
      }catch{lose();throw fail('TRANSPORT_OWNERSHIP_LOST');}
    }
    timer=setInterval(()=>{
      if(!active||checking)return;checking=true;
      void client.query('SELECT 1').catch(lose).finally(()=>{checking=false;});
    },heartbeatMs);timer.unref();
    return {active:()=>active,assert,onLost:fn=>{if(!active){fn();return ()=>{};}listeners.add(fn);return ()=>listeners.delete(fn);},release:async()=>{if(ended)return;ended=true;active=false;clearInterval(timer);emitLost();await end();}};
  }catch(error){active=false;clearInterval(timer);await end().catch(()=>{});throw fail(error.code==='TRANSPORT_ALREADY_OWNED'?error.code:'TRANSPORT_OWNERSHIP_FAILED');}
}
