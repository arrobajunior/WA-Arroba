import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createPostgresApp} from './server.mjs';
import {postgresFixture} from './test-fixture.mjs';

async function setup(t,{lostAt,blockedClose=false,brokenRecovery=false}={}){
 const f=await postgresFixture(),events=[],listeners=new Set();let active=true,releaseClose;
 const gate=new Promise(r=>releaseClose=r);
 const owner={active:()=>active,assert:async()=>{if(!active)throw Error('lost');},onLost:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},release:async()=>{events.push('release');active=false;}};
 const store={...f.store,close:async()=>events.push('db.close')};
 const transport={state:()=>({status:'disconnected'}),flush:async()=>{},recoverInterrupted:async()=>{events.push('transport.recover');if(brokenRecovery)throw Error('SYNTHETIC_RECOVERY');},restore:async()=>{events.push('restore');if(lostAt==='restore'){active=false;for(const fn of listeners)fn();}},close:async()=>{events.push('transport.close');if(blockedClose)await gate;}};
 const alerts={stateChanged:async()=>{},recoverInterrupted:async()=>events.push('alerts.recover'),start:async()=>events.push('alerts.start'),close:async()=>events.push('alerts.close')};
 const options={publicUrl:'http://localhost:3210',openStore:async()=>{events.push('store');return store;},acquireOwnership:async()=>{events.push('acquire');return owner;},transportFactory:()=>transport,alertFactory:()=>alerts};
 t.after(async()=>{releaseClose();await f.close();});
 return {...f,events,owner,transport,alerts,options,releaseClose,lose(){active=false;for(const fn of listeners)fn();}};
}
async function listen(t,server){server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.shutdown());return (route,options={})=>new Promise((resolve,reject)=>{
 const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method:options.method||'GET',headers:{Host:'localhost:3210',...options.headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks);resolve({status:res.statusCode,headers:new Headers(res.headers),text:async()=>bytes.toString(),json:async()=>JSON.parse(bytes.toString())});});});req.on('error',reject);req.end(options.body);
});}

test('composition acquires owner before recovery/restore and exposes secured HTTP/static/readiness without starting by import',async t=>{
 const f=await setup(t),server=await createPostgresApp(f.options),request=await listen(t,server);
 assert.deepEqual(f.events,['store','acquire','transport.recover','alerts.recover','restore','alerts.start']);
 assert.equal(server.readiness(),true);
 const health=await request('/api/ready',{headers:{Host:'infrastructure-probe'}});assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
 const index=await request('/');assert.equal(index.status,200);assert.match(await index.text(),/html/i);assert.match(index.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await request('/',{method:'HEAD'})).status,200);
 assert.equal((await request('/api/dashboard')).status,401);
 assert.equal((await request('/api/branding',{headers:{Host:'evil.example'}})).status,403);
 assert.equal((await request('/%2e%2e%2fpackage.json')).status,403);
 assert.equal((await request('/api/not-real')).status,404);
 assert.equal((await request('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
});

test('pause refuses new operations and retains ownership until shutdown after transport drains',async t=>{
 const f=await setup(t,{blockedClose:true}),server=await createPostgresApp(f.options),request=await listen(t,server);
 let complete=false;const paused=server.pause().then(()=>complete=true);await new Promise(r=>setImmediate(r));
 assert.equal(complete,false);assert.equal((await request('/api/health')).status,503);assert.equal((await request('/api/branding')).status,503);assert.equal(f.events.includes('release'),false);
 f.releaseClose();await paused;assert.equal(f.events.includes('db.close'),false);
 await server.shutdown();await server.shutdown();
 assert.deepEqual(f.events.slice(-4),['transport.close','alerts.close','release','db.close']);
});

test('ownership loss immediately fails readiness and closes alerts/socket admission without releasing live resources',async t=>{
 const f=await setup(t),server=await createPostgresApp(f.options),request=await listen(t,server);f.lose();
 assert.equal(server.readiness(),false);assert.equal((await request('/api/ready')).status,503);assert.equal((await request('/instanceaaaa1111/status?token=synthetic-token')).status,503);
 assert.ok(f.events.includes('alerts.close'));assert.ok(f.events.includes('transport.close'));assert.equal(f.events.includes('release'),false);await server.shutdown();assert.equal(f.events.at(-1),'db.close');
});

test('failed recovery cleans up in order and never restores sessions',async t=>{
 const f=await setup(t,{brokenRecovery:true});await assert.rejects(createPostgresApp(f.options),/SYNTHETIC_RECOVERY/);
 assert.equal(f.events.includes('restore'),false);assert.deepEqual(f.events.slice(-4),['transport.close','alerts.close','release','db.close']);
});

test('lost ownership during restore cannot return a ready server',async t=>{
 const f=await setup(t,{lostAt:'restore'});await assert.rejects(createPostgresApp(f.options));assert.equal(f.events.at(-1),'db.close');
});

test('pause drains an admitted HTTP writer before closing transport or releasing owner',async t=>{
 const f=await setup(t),server=await createPostgresApp(f.options),request=await listen(t,server);
 let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r),original=f.db.transaction;
 f.db.transaction=async(...args)=>{entered();await gate;return original(...args);};
 const pending=request('/api/branding');await started;const paused=server.pause();await new Promise(r=>setImmediate(r));
 assert.equal(f.events.includes('transport.close'),false);assert.equal((await request('/api/branding')).status,503);
 release();assert.equal((await pending).status,200);await paused;assert.equal(f.events.includes('transport.close'),true);assert.equal(f.events.includes('release'),false);f.db.transaction=original;
});

test('temporary media is instance scoped and blocked owners cannot retrieve it',async t=>{
 const {createMediaRelay}=await import('../media-relay.mjs');const relay=createMediaRelay();
 const f=await setup(t),server=await createPostgresApp({...f.options,mediaRelay:relay}),request=await listen(t,server);
 const key=relay.put(f.ids[0],Buffer.from('synthetic'),'text/plain','example.txt');
 const route='/instance'+f.ids[0]+'/media/'+key;
 const media=await request(route);assert.equal(media.status,200);assert.equal(await media.text(),'synthetic');assert.equal(media.headers.get('cache-control'),'no-store');
 assert.equal((await request('/instance'+f.ids[1]+'/media/'+key)).status,404);
 await f.db.run('UPDATE users SET active=0 WHERE id=$1',[f.user.id]);assert.equal((await request(route)).status,404);
});

test('composed real controllers persist synthetic credentials and quiet shutdown keeps session without outage',async t=>{
 const {EventEmitter}=await import('node:events');const {createPostgresTransport}=await import('./transport.mjs');
 const f=await setup(t);let transport,socket;
 const server=await createPostgresApp({...f.options,restoreConnections:false,alertFactory:undefined,transportFactory:(store,options)=>transport=createPostgresTransport(store,{...options,socketFactory:config=>socket={config,ev:new EventEmitter(),user:{id:'5511000000000@s.whatsapp.net'},end(){},logout:async()=>{throw Error('MUST_NOT_LOGOUT');},sendMessage:async()=>({})}})});
 const request=await listen(t,server);assert.equal((await request('/api/ready')).status,200);
 await transport.connect(f.ids[0]);socket.ev.emit('creds.update',{registered:true});socket.ev.emit('connection.update',{connection:'open'});await transport.idle();
 const before=(await f.db.get('SELECT count(*) AS n FROM wa_keys')).n;assert.ok(before>0);
 await server.pause();assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys')).n,before);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_incidents')).n,0);
});
