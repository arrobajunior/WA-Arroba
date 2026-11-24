import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {postgresRuntimeConfig,runPostgresRuntime} from './runtime.mjs';
const env={PG_RUNTIME_ENABLED:'true',DATABASE_URL:'postgres://synthetic:secret@localhost/test',PUBLIC_URL:'http://localhost:3210',DATA_DIR:'/synthetic/key'};
const logger=()=>({messages:[],info(value){this.messages.push(value);},error(value){this.messages.push(value);}});
function fake(){const server=new EventEmitter();let closes=0;server.listen=()=>queueMicrotask(()=>server.emit('listening'));server.shutdown=async()=>{closes++;};server.readiness=()=>true;return {server,closes:()=>closes};}
test('runtime requires explicit activation and validates TLS, origin, limits and key without enabling restoration by default',async()=>{
 await assert.rejects(postgresRuntimeConfig({...env,PG_RUNTIME_ENABLED:undefined}),/NOT_ENABLED/);
 const c=await postgresRuntimeConfig(env);assert.equal(c.options.restoreConnections,false);assert.equal(c.options.storeOptions.max,10);
 assert.equal((await postgresRuntimeConfig({...env,PG_RESTORE_CONNECTIONS:'true'})).options.restoreConnections,true);
 for(const change of [{PORT:'0'},{PG_POOL_MAX:'31'},{PG_INSTANCE_LIMIT:'0'},{PG_RESTORE_CONNECTIONS:'yes'},{PUBLIC_URL:'https://example.test/path'},{PG_SCHEMA:'public'},{DATABASE_URL:env.DATABASE_URL+'?sslmode=disable'},{DATA_DIR:undefined}])await assert.rejects(postgresRuntimeConfig({...env,...change}));
});
test('signals during async startup wait and close exactly once without listening',async()=>{
 const proc=new EventEmitter(),f=fake(),log=logger();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let listened=false;f.server.listen=()=>listened=true;
 const run=runPostgresRuntime({env,processObject:proc,log,createApp:async()=>{entered();await gate;return f.server;}});await started;proc.emit('SIGTERM');proc.emit('SIGINT');release();await run;
 assert.equal(listened,false);assert.equal(f.closes(),1);assert.equal(proc.listenerCount('SIGTERM'),0);
});
test('listen errors redact secrets and drain the constructed server',async()=>{
 const proc=new EventEmitter(),f=fake(),log=logger();f.server.listen=()=>queueMicrotask(()=>f.server.emit('error',Error('secret password and payload')));
 await runPostgresRuntime({env,processObject:proc,log,createApp:async()=>f.server});assert.equal(proc.exitCode,1);assert.equal(f.closes(),1);assert.ok(!JSON.stringify(log.messages).includes('secret'));
});
test('runtime supervises loss of readiness and repeated signals never force duplicate shutdown',async()=>{
 const proc=new EventEmitter(),f=fake(),log=logger();let done;const closed=new Promise(r=>done=r);f.server.readiness=()=>false;f.server.shutdown=async()=>done();
 const running=await runPostgresRuntime({env,processObject:proc,log,createApp:async()=>f.server,monitorMs:10});
 const keep=setTimeout(()=>{},1000);await closed;clearTimeout(keep);await running.stop();assert.equal(proc.exitCode,1);assert.equal(proc.listenerCount('SIGINT'),0);
});
test('signal while listen is pending waits until listener can be safely shut down',async()=>{
 const proc=new EventEmitter(),f=fake();let begin;const pending=new Promise(r=>begin=r);f.server.listen=()=>begin();
 const run=runPostgresRuntime({env,processObject:proc,log:logger(),createApp:async()=>f.server});await pending;proc.emit('SIGTERM');assert.equal(f.closes(),0);f.server.emit('listening');await run;assert.equal(f.closes(),1);
});
test('real occupied TCP port produces clean runtime failure without retaining listener or signals',async()=>{
 const occupied=http.createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
 try{const proc=new EventEmitter(),server=http.createServer();let closed=false;server.readiness=()=>true;server.shutdown=async()=>{closed=true;if(server.listening)await new Promise(r=>server.close(r));};
 await runPostgresRuntime({env:{...env,HOST:'127.0.0.1',PORT:String(occupied.address().port)},processObject:proc,log:logger(),createApp:async()=>server});assert.equal(proc.exitCode,1);assert.equal(closed,true);assert.equal(server.listening,false);
 }finally{await new Promise(r=>occupied.close(r));}
});
test('executable with only DATABASE_URL exits safely before database access and never prints secrets',async()=>{
 const child=spawn(process.execPath,['scripts/start-postgres.mjs'],{env:{PATH:process.env.PATH,DATABASE_URL:env.DATABASE_URL},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);const [code]=await once(child,'exit');assert.equal(code,1);assert.match(output,/Falha no serviço/);assert.ok(!output.includes('secret'));
});

test('real child process listens and SIGTERM drains before natural exit without forced process.exit',async()=>{
 const script=`import http from 'node:http';import {runPostgresRuntime} from './postgres/runtime.mjs';await runPostgresRuntime({env:${JSON.stringify(env)},createApp:async()=>{const s=http.createServer((q,r)=>r.end('synthetic'));const listen=s.listen.bind(s);s.listen=()=>listen(0,'127.0.0.1');s.readiness=()=>true;s.shutdown=async()=>{await new Promise(r=>s.close(r));console.log('SYNTHETIC_DRAINED');};return s;}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let output='';
 const ready=new Promise((resolve,reject)=>{child.stdout.on('data',c=>{output+=c;if(output.includes('Serviço iniciado'))resolve();});child.on('error',reject);child.on('exit',()=>{if(!output.includes('Serviço iniciado'))reject(Error('CHILD_START_FAILED'));});});
 const exit=once(child,'exit');await ready;child.kill('SIGTERM');const [code,signal]=await exit;assert.equal(code,0);assert.equal(signal,null);assert.match(output,/SYNTHETIC_DRAINED/);
});

test('separate Docker recipe includes runtime relative import closure and leaves legacy default untouched',async()=>{
 const {readFile}=await import('node:fs/promises');const path=await import('node:path');
 const docker=await readFile('Dockerfile.postgres','utf8'),legacy=await readFile('Dockerfile','utf8'),pkg=JSON.parse(await readFile('package.json','utf8'));assert.match(legacy,/CMD \["node", "server.mjs"\]/);assert.equal(pkg.scripts.start,'node server.mjs');assert.match(docker,/CMD \["node", "scripts\/start-postgres.mjs"\]/);
 const copied=new Set();for(const line of docker.split('\n'))if(line.startsWith('COPY ')){const parts=line.split(/\s+/).slice(1).filter(x=>!x.startsWith('--'));for(const source of parts.slice(0,-1))copied.add(source);}
 const visited=new Set();async function visit(file){if(visited.has(file))return;visited.add(file);assert.ok(copied.has(file),'Missing build source: '+file);const code=await readFile(file,'utf8');for(const match of code.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){const dep=path.posix.normalize(path.posix.join(path.posix.dirname(file),match[1]));await visit(dep);}}
 await visit('scripts/start-postgres.mjs');assert.ok(copied.has('postgres/manifest.json'));assert.ok(copied.has('public'));assert.ok(![...copied].some(p=>p.includes('test-fixture')||p.includes('transfer.mjs')));
});
