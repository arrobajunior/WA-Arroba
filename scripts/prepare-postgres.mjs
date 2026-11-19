import {createSnapshot,transferSnapshot} from '../postgres/transfer.mjs';

// Deliberately not wired to npm start, DATABASE_URL, or the Railway deployment command.
const [command,...rest]=process.argv.slice(2),args={};
try{
  for(let n=0;n<rest.length;n++){
    const flag=rest[n];if(['--apply','--writers-stopped'].includes(flag))args[flag.slice(2)]=true;
    else if(['--source','--out','--snapshot','--schema'].includes(flag)&&rest[n+1]&&!rest[n+1].startsWith('--'))args[flag.slice(2)]=rest[++n];
    else throw Object.assign(new Error(),{code:'INVALID_ARGUMENTS'});
  }
  let result;
  if(command==='snapshot'&&args.source&&args.out&&!args.apply)result=await createSnapshot(args.source,args.out);
  else if(command==='import'&&args.snapshot&&args.schema){
    if(args.schema==='wa_app'&&(!args.apply||!args['writers-stopped']))throw Object.assign(new Error(),{code:'FINAL_IMPORT_REQUIRES_STOPPED_WRITERS'});
    let client;
    if(args.apply){
      if(!process.env.PG_MIGRATION_URL)throw Object.assign(new Error(),{code:'PG_MIGRATION_URL_REQUIRED'});
      const {Client}=await import('pg');client=new Client({connectionString:process.env.PG_MIGRATION_URL,connectionTimeoutMillis:10000,application_name:'wa-offline-import'});
      await client.connect();
    }
    try{result=await transferSnapshot(client,args.snapshot,{schema:args.schema,apply:!!args.apply});}finally{await client?.end();}
  }else throw Object.assign(new Error(),{code:'INVALID_ARGUMENTS'});
  console.log(JSON.stringify(result));
}catch(e){
  // pg errors may include SQL values, passwords, phone numbers or message content. Never print details/stack.
  const code=/^[A-Z0-9_]{1,80}$/.test(e?.code||'')?e.code:'PREPARATION_FAILED';
  console.error(JSON.stringify({ok:false,code}));process.exitCode=1;
}
