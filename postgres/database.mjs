import {AsyncLocalStorage} from 'node:async_hooks';
import {Pool} from 'pg';

const fail=code=>Object.assign(new Error(code),{code});
const safeError=error=>fail(/^[A-Z0-9_]{1,60}$/.test(error?.code||'')?error.code:'DATABASE_ERROR');
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const validSchema=schema=>/^wa_(app|rehearsal_[a-z0-9_]{1,40})$/.test(schema||'');
function normalize(result){
  if(Array.isArray(result))throw fail('MULTIPLE_RESULTS_NOT_SUPPORTED');
  return {...result,rows:result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>{
    const field=result.fields?.find(f=>f.name===key);
    if(field?.dataTypeID===20&&value!==null){
      const n=Number(value);if(!Number.isSafeInteger(n))throw fail('DATABASE_INTEGER_OUT_OF_RANGE');return [key,n];
    }
    return [key,value instanceof Uint8Array?Buffer.from(value):value];
  })))};
}

// All methods return Promises. No Atomics, worker blocking, implicit backend fallback or retries.
export function createPostgresDatabase(pool,{schema='wa_app',statementTimeoutMs=15000,lockTimeoutMs=5000}={}){
  if(!validSchema(schema))throw fail('INVALID_DATABASE_SCHEMA');
  for(const value of [statementTimeoutMs,lockTimeoutMs])if(!Number.isSafeInteger(value)||value<1||value>120000)throw fail('INVALID_DATABASE_TIMEOUT');
  const context=new AsyncLocalStorage();let closing=false,closePromise,idleErrors=0;
  const onError=()=>{idleErrors++;};pool.on?.('error',onError);
  async function lease(){
    let client;
    try{
      client=await pool.connect();
      await client.query("SELECT set_config('search_path',$1,false),set_config('statement_timeout',$2,false),set_config('lock_timeout',$3,false),set_config('idle_in_transaction_session_timeout',$4,false)",[quote(schema)+', pg_catalog',String(statementTimeoutMs),String(lockTimeoutMs),'30000']);
      return client;
    }catch(error){client?.release(true);throw safeError(error);}
  }
  async function execute(client,sql,args,scope){
    try{return normalize(await client.query(sql,args));}
    catch(error){if(scope)scope.failed=true;throw safeError(error);}
  }
  async function query(sql,args=[]){
    const scope=context.getStore();
    if(scope){if(scope.closed)throw fail('TRANSACTION_CLOSED');if(scope.failed)throw fail('TRANSACTION_FAILED');return execute(scope.client,sql,args,scope);}
    if(closing)throw fail('DATABASE_CLOSED');
    const client=await lease();try{return await execute(client,sql,args);}finally{client.release();}
  }
  const all=async(sql,args=[])=> (await query(sql,args)).rows;
  const get=async(sql,args=[])=> (await all(sql,args))[0];
  const run=async(sql,args=[])=>{const r=await query(sql,args);return {changes:r.rowCount,rows:r.rows};};
  async function transaction(operation,{readOnly=false,isolation='READ COMMITTED'}={}){
    if(context.getStore())throw fail('NESTED_TRANSACTION_NOT_SUPPORTED');
    if(closing)throw fail('DATABASE_CLOSED');
    if(!['READ COMMITTED','REPEATABLE READ','SERIALIZABLE'].includes(isolation))throw fail('INVALID_TRANSACTION_ISOLATION');
    const client=await lease(),scope={client,closed:false,failed:false};let destroy=false,operationPhase=false;
    try{
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}${readOnly?' READ ONLY':''}`);
      operationPhase=true;const result=await context.run(scope,()=>operation({query,all,get,run}));operationPhase=false;
      if(scope.failed)throw fail('TRANSACTION_FAILED');
      // Closing the async scope also rejects work accidentally scheduled after the callback returns.
      scope.closed=true;await client.query('COMMIT');return result;
    }catch(error){
      scope.closed=true;try{await client.query('ROLLBACK');}catch{destroy=true;}
      // Application/domain errors are preserved; database errors have already been redacted.
      if(operationPhase)throw error;
      throw safeError(error);
    }finally{scope.closed=true;client.release(destroy);}
  }
  async function close(){
    if(context.getStore())throw fail('CLOSE_WITHIN_TRANSACTION');
    if(!closePromise){closing=true;closePromise=pool.end().finally(()=>pool.off?.('error',onError));}
    return closePromise;
  }
  return {query,all,get,run,transaction,close,schema,stats:()=>({idleErrors,total:pool.totalCount||0,idle:pool.idleCount||0,waiting:pool.waitingCount||0})};
}

export function postgresPoolOptions({databaseUrl,max=10,ssl}={}){
  let url;try{url=new URL(databaseUrl);}catch{throw fail('DATABASE_URL_REQUIRED');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.pathname||url.pathname==='/')throw fail('INVALID_DATABASE_URL');
  if(!Number.isInteger(max)||max<1||max>30)throw fail('INVALID_POOL_SIZE');
  // Do not silently disable certificate validation, including through libpq-style URL options.
  if((url.searchParams.has('sslmode')&&url.searchParams.get('sslmode')!=='verify-full')||url.searchParams.has('ssl')||url.searchParams.has('uselibpqcompat')||ssl===false||ssl?.rejectUnauthorized===false)throw fail('INSECURE_DATABASE_TLS');
  // pg connection-string SSL fields replace the explicit ssl object (including a supplied CA).
  // Keep TLS configuration in one place instead of silently losing the trusted CA.
  for(const name of url.searchParams.keys())if(/^ssl/i.test(name)&&name!=='sslmode')throw fail('INVALID_DATABASE_TLS_CONFIG');
  url.searchParams.delete('sslmode');
  return {connectionString:url.toString(),max,min:0,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,application_name:'wa-arroba',ssl:{...(typeof ssl==='object'?ssl:{}),rejectUnauthorized:true}};
}
export function connectPostgresDatabase(options={}){
  return createPostgresDatabase(new Pool(postgresPoolOptions(options)),options);
}
