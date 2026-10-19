import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createApp} from './server.mjs';
const admin={email:'admin@example.com',password:'administrator-test-password'};
const fakeTransport=()=>({state:()=>({status:'disconnected',qr:null}),connect:()=>{},disconnect:async()=>{},flush:()=>{},restore:()=>{},close:async()=>{}});
async function start(dataDir,options={}){
 const server=await createApp({dataDir,port:0,adminEmail:admin.email,adminPassword:admin.password,transportFactory:fakeTransport,...options});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 return {base,close:()=>server.shutdown(),request(route,{method='GET',data,headers={},cookie}={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{'Content-Type':'application/json','X-Requested-With':'wa-platform',Origin:base,...(cookie?{Cookie:cookie}:{}),...headers}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString()),headers:{get:name=>{const value=res.headers[name.toLowerCase()];return Array.isArray(value)?value.join(', '):value;}}});}catch(e){reject(e);}});});req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));});}};
}
async function login(app,credentials=admin){const r=await app.request('/api/auth/login',{method:'POST',data:credentials});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];}
async function fixture(t,options){const directory=await mkdtemp(path.join(tmpdir(),'wa-platform-test-'));const app=await start(directory,options);t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});return {...app,directory};}

test('login required, admin creates users, each user only accesses their own instances and tokens',async t=>{
 const app=await fixture(t);assert.equal((await app.request('/api/instances')).status,401);
 const root=await login(app);const account=async(name)=>{const credentials={email:`${name}@example.com`,password:`${name}-long-password`};const r=await app.request('/api/users',{method:'POST',cookie:root,data:{name,...credentials}});assert.equal(r.status,201);return {credentials,user:r.body.user,cookie:await login(app,credentials)};};
 const alice=await account('alice'),bob=await account('bob');
 const made=await app.request('/api/instances',{method:'POST',cookie:alice.cookie,data:{name:'Alice WhatsApp'}});assert.equal(made.status,201);const i=made.body.instance;
 assert.equal(i.owner_id,alice.user.id);assert.match(i.token,/^[a-f0-9]{64}$/);
 assert.equal((await app.request('/api/instances',{cookie:bob.cookie})).body.instances.length,0);
 const listing=(await app.request('/api/instances',{cookie:alice.cookie})).body.instances;assert.equal(listing.length,1);assert.equal(listing[0].token,undefined);
 for(const action of ['', '/qr','/messages'])assert.equal((await app.request(`/api/instances/${i.id}${action}`,{cookie:bob.cookie})).status,404);
 for(const action of ['/connect','/disconnect','/token'])assert.equal((await app.request(`/api/instances/${i.id}${action}`,{method:'POST',cookie:bob.cookie,data:{}})).status,404);
 assert.equal((await app.request(`/api/instances/${i.id}`,{method:'PATCH',cookie:bob.cookie,data:{name:'attack'}})).status,404);
 assert.equal((await app.request('/api/users',{cookie:alice.cookie})).status,403);
 assert.equal((await app.request('/api/users',{method:'POST',cookie:alice.cookie,data:{name:'root',email:'new@example.com',password:'test-password-long'}})).status,403);
 assert.equal((await app.request('/api/instances',{method:'POST',cookie:alice.cookie,data:{name:'wrong owner',owner_id:bob.user.id}})).status,403);
 assert.equal((await app.request(`/api/instances/${i.id}`,{cookie:root})).status,200);
 assert.equal((await app.request('/api/dashboard',{cookie:bob.cookie})).body.counts.instances,0);
 const disk=await readFile(path.join(app.directory,'platform.sqlite-wal'));assert.equal(disk.includes(Buffer.from(i.token)),false);assert.equal(disk.includes(Buffer.from(alice.credentials.password)),false);
});

test('token authentication, queued messages, rotation and persistence',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wa-persist-test-'));let app=await start(dir);t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});let cookie=await login(app);
 const i=(await app.request('/api/instances',{method:'POST',cookie,data:{name:'Integration'}})).body.instance;
 const route=`/instance${i.id}`;assert.equal((await app.request(route+'/instance/status?token=wrong')).status,401);
 assert.equal((await app.request(route+'/messages/chat',{method:'POST',data:{token:i.token,to:'5511999999999',body:'Order 123'}})).status,202);
 assert.equal((await app.request(route+'/instance/status',{headers:{Authorization:`Bearer ${i.token}`}})).body.status.accountStatus,'disconnected');
 assert.equal((await app.request(route+'/messages',{headers:{Authorization:`Bearer ${i.token}`}})).body.total,1);
 await app.close();app=await start(dir);cookie=await login(app);
 const retained=(await app.request(`/api/instances/${i.id}`,{cookie})).body.instance;assert.equal(retained.token,i.token);assert.equal(retained.message_counts.queue,1);
 const rotated=(await app.request(`/api/instances/${i.id}/token`,{method:'POST',cookie,data:{}})).body.instance;
 assert.notEqual(rotated.token,i.token);assert.equal((await app.request(route+`/instance/status?token=${i.token}`)).status,401);
 assert.equal((await app.request(route+`/instance/status?token=${rotated.token}`)).status,200);
});

test('CSRF, logout, validation and raw path protections',async t=>{
 const app=await fixture(t);const cookie=await login(app);
 assert.equal((await app.request('/api/instances',{method:'POST',cookie,data:{name:'x'},headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await app.request('/api/instances',{method:'POST',cookie,data:{name:'x'},headers:{'X-Requested-With':''}})).status,403);
 for(const data of [{name:''},{name:'x',token:'forced'},[]])assert.equal((await app.request('/api/instances',{method:'POST',cookie,data})).status,400);
 assert.equal((await app.request('/api/users',{method:'POST',cookie,data:{name:'x',email:'x@example.com',password:'short'}})).status,400);
 const i=(await app.request('/api/instances',{method:'POST',cookie,data:{name:'x'}})).body.instance;
 for(const data of [{token:i.token,to:'invalid',body:'hi'},{token:i.token,to:'5511999999999',body:'x'.repeat(4097)}])assert.equal((await app.request(`/instance${i.id}/messages/chat`,{method:'POST',data})).status,400);
 const raw=(route,headers={})=>new Promise((resolve,reject)=>{http.get(app.base,{path:route,headers},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject);});
 for(const route of ['/../server.mjs','/%2e%2e/server.mjs','/..%5cserver.mjs','/%00','/%GG'])assert.ok([400,403].includes(await raw(route)));
 assert.equal(await raw('/',{Host:'evil.example'}),403);
 await app.request('/api/auth/logout',{method:'POST',cookie,data:{}});assert.equal((await app.request('/api/auth/me',{cookie})).status,401);
});

test('external domain enforces exact origin and Secure HttpOnly cookies',async t=>{
 const app=await fixture(t,{publicUrl:'https://wa.example.com'});
 const headers={Host:'wa.example.com',Origin:'https://wa.example.com'};
 const signed=await app.request('/api/auth/login',{method:'POST',headers,data:admin});assert.equal(signed.status,200);assert.match(signed.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
 const cookie=signed.headers.get('set-cookie').split(';')[0];
 assert.equal((await app.request('/api/instances',{method:'POST',cookie,headers:{...headers,Origin:'http://wa.example.com'},data:{name:'x'}})).status,403);
 assert.equal((await app.request('/api/instances',{method:'POST',cookie,headers,data:{name:'x'}})).status,201);
});

test('rate limiting rejects repeated invalid login and never uses client-provided forwarded IP',async t=>{
 const app=await fixture(t);
 for(let i=0;i<20;i++)assert.equal((await app.request('/api/auth/login',{method:'POST',data:{...admin,password:'wrong-password'},headers:{'X-Forwarded-For':`10.0.0.${i}`}})).status,401);
 const limited=await app.request('/api/auth/login',{method:'POST',data:admin});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'900');
});

test('Admin Master manages access, revokes sessions, blocks instance API and protects master',async t=>{
 const app=await fixture(t),root=await login(app);
 const credentials={email:'operator@example.com',password:'operator-initial-password'};
 const u=(await app.request('/api/users',{method:'POST',cookie:root,data:{name:'Operator',...credentials}})).body.user;
 const member=await login(app,credentials);
 const i=(await app.request('/api/instances',{method:'POST',cookie:member,data:{name:'Sales'}})).body.instance;
 const edit=data=>app.request(`/api/users/${u.id}`,{method:'PATCH',cookie:root,data});
 assert.equal((await app.request(`/api/users/${u.id}`,{method:'PATCH',cookie:member,data:{active:false}})).status,403);
 assert.equal((await edit({active:false,role:'admin'})).status,400);
 assert.equal((await edit({active:false})).status,200);
 assert.equal((await app.request('/api/auth/me',{cookie:member})).status,401);
 assert.equal((await app.request('/api/auth/login',{method:'POST',data:credentials})).status,401);
 assert.equal((await app.request(`/instance${i.id}/instance/status`,{headers:{Authorization:`Bearer ${i.token}`}})).status,401);
 assert.equal((await app.request('/api/instances',{method:'POST',cookie:root,data:{name:'Blocked',owner_id:u.id}})).status,400);
 const password='operator-replaced-password';
 assert.equal((await edit({active:true,password,name:'New name'})).status,200);
 assert.equal((await app.request('/api/auth/me',{cookie:member})).status,401);
 assert.equal((await app.request('/api/auth/login',{method:'POST',data:credentials})).status,401);
 const renewed=await login(app,{...credentials,password});
 assert.equal((await app.request('/api/instances',{cookie:renewed})).body.instances[0].id,i.id);
 assert.equal((await app.request(`/instance${i.id}/instance/status`,{headers:{Authorization:`Bearer ${i.token}`}})).status,200);
 const master=(await app.request('/api/auth/me',{cookie:root})).body.user;
 assert.equal((await app.request(`/api/users/${master.id}`,{method:'PATCH',cookie:root,data:{active:false}})).status,400);
 assert.equal((await app.request('/api/health',{headers:{Host:'healthcheck.railway.app'}})).status,200);
});

test('branding is public, only Master can edit; images are decoded, persisted and removed atomically',async t=>{
 const sharp=(await import('sharp')).default;
 const dir=await mkdtemp(path.join(tmpdir(),'wa-brand-test-'));let app=await start(dir);t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});let cookie=await login(app);
 assert.equal((await app.request('/api/branding')).body.branding.name,'WhatsApp API');
 const credentials={email:'brand-user@example.com',password:'brand-user-password'};
 await app.request('/api/users',{method:'POST',cookie,data:{name:'Brand user',...credentials}});
 const member=await login(app,credentials);
 const update=(data,who=cookie)=>app.request('/api/branding',{method:'PATCH',cookie:who,data});
 assert.equal((await update({name:'Unauthorized'},member)).status,403);
 assert.equal((await app.request('/api/branding',{method:'PATCH',data:{name:'Anonymous'}})).status,401);
 const bytes=await sharp({create:{width:24,height:24,channels:4,background:'#12846d'}}).png().toBuffer();
 const png='data:image/png;base64,'+bytes.toString('base64');
 const saved=await update({name:'Minha marca <teste>',positive:png,negative:png,favicon:png});assert.equal(saved.status,200);
 const brand=saved.body.branding;
 for(const slot of ['positive','negative','favicon']){const response=await fetch(app.base+brand[slot]);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).width,24);}
 for(const data of [{name:''},{name:'x'.repeat(61)},{favicon:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='},{positive:'data:image/png;base64,bm90IGFuIGltYWdl'},{positive:png,negative:'invalid',name:'Partial failure'}])assert.equal((await update(data)).status,400);
 assert.equal((await app.request('/api/branding')).body.branding.name,'Minha marca <teste>');
 await app.close();app=await start(dir);cookie=await login(app);
 assert.deepEqual((await app.request('/api/branding')).body.branding,brand);
 assert.equal((await update({positive:null,favicon:null})).status,200);
 const removed=(await app.request('/api/branding')).body.branding;
 assert.equal(removed.positive,null);assert.equal(removed.favicon,null);assert.equal(removed.negative,brand.negative);
 assert.equal((await fetch(app.base+brand.positive)).status,404);
});
