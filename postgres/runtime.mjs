import {readFile} from 'node:fs/promises';
import {createPostgresApp} from './server.mjs';
import {postgresPoolOptions} from './database.mjs';

const invalid=()=>{throw Error('INVALID_POSTGRES_RUNTIME_CONFIG');};
export async function postgresRuntimeConfig(env){
  if(env.PG_RUNTIME_ENABLED!=='true')throw Error('POSTGRES_RUNTIME_NOT_ENABLED');
  const integer=(name,fallback,min,max)=>{const raw=env[name]??String(fallback);if(!/^\d+$/.test(raw))invalid();const value=Number(raw);if(!Number.isSafeInteger(value)||value<min||value>max)invalid();return value;};
  const port=integer('PORT',3210,1,65535),host=env.HOST||'127.0.0.1';
  if(!host||/[\s/]/.test(host))invalid();
  let url;try{url=new URL(env.PUBLIC_URL);}catch{invalid();}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)invalid();
  const schema=env.PG_SCHEMA||'wa_app';if(!/^wa_(app|rehearsal_[a-z0-9_]{1,40})$/.test(schema))invalid();
  if(env.PG_RESTORE_CONNECTIONS!==undefined&&!['true','false'].includes(env.PG_RESTORE_CONNECTIONS))invalid();
  const max=integer('PG_POOL_MAX',10,1,30),perOwnerLimit=integer('PG_INSTANCE_LIMIT',50,1,10000);
  let ssl;if(env.PG_CA_FILE){try{ssl={ca:await readFile(env.PG_CA_FILE,'utf8')};}catch{throw Error('POSTGRES_CA_UNAVAILABLE');}if(!ssl.ca.trim())invalid();}
  // Validate before constructing the application; never log the input URL/key or filesystem errors.
  postgresPoolOptions({databaseUrl:env.DATABASE_URL,max,ssl});
  if(!env.DATA_DIR&&!env.PERSISTENCE_KEY_BASE64)throw Error('MASTER_KEY_REQUIRED');
  return {host,port,options:{publicUrl:url.origin,restoreConnections:env.PG_RESTORE_CONNECTIONS==='true',perOwnerLimit,storeOptions:{databaseUrl:env.DATABASE_URL,schema,max,ssl,dataDir:env.DATA_DIR,keyBase64:env.PERSISTENCE_KEY_BASE64}}};
}

// Signals are registered before async startup. A signal during startup waits for the
// acquired resources to be returned, then drains them without opening the listener.
export async function runPostgresRuntime({env=process.env,processObject=process,createApp=createPostgresApp,log=console,monitorMs=1000}={}){
  let server,timer,stopping=false,stopPromise,requested=false,startupDone;
  const startup=new Promise(resolve=>startupDone=resolve);
  const report=()=>log.error('[postgres] Falha no serviço. Consulte a configuração e a disponibilidade do banco.');
  const remove=()=>{clearInterval(timer);for(const signal of ['SIGINT','SIGTERM'])processObject.removeListener(signal,onSignal);};
  function stop(failed=false){
    requested=true;if(failed)processObject.exitCode=1;
    if(stopPromise)return stopPromise;
    stopPromise=(async()=>{await startup;stopping=true;clearInterval(timer);try{await server?.shutdown();}catch{processObject.exitCode=1;report();}finally{remove();}})();return stopPromise;
  }
  const onSignal=()=>{void stop();};
  for(const signal of ['SIGINT','SIGTERM'])processObject.on(signal,onSignal);
  try{
    const config=await postgresRuntimeConfig(env);server=await createApp(config.options);
    if(requested){startupDone();await stop();return {server,stop};}
    await new Promise((resolve,reject)=>{
      const failed=error=>{server.removeListener('listening',ready);reject(error);};
      const ready=()=>{server.removeListener('error',failed);resolve();};
      server.once('error',failed);server.once('listening',ready);server.listen(config.port,config.host);
    });
    startupDone();
    server.on('error',()=>{report();void stop(true);});
    if(requested){await stop();return {server,stop};}
    timer=setInterval(()=>{if(!stopping&&!server.readiness()){report();void stop(true);}},monitorMs);timer.unref();
    log.info('[postgres] Serviço iniciado.');return {server,stop};
  }catch{startupDone();processObject.exitCode=1;report();await stop(true);return {server,stop};}
}
