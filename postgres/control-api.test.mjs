import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
import {passwordHash,digest} from '../auth.mjs';
import {createPostgresDatabase} from './database.mjs';
import {loadPersistenceCrypto} from './persistence-crypto.mjs';
import {createPostgresControlApi} from './control-api.mjs';
import {createPostgresAccounts} from './accounts.mjs';
import {createPostgresInstances} from './instances.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createPostgresConnectionAlerts} from './connection-alerts.mjs';

async function fixture(t,{perOwnerLimit=50,secure=false,withAlerts=false}={}){
  const engine=new PGlite(),schema='wa_rehearsal_control';let clock=Date.parse('2026-11-19T18:00:00Z'),gate=Promise.resolve();
  await engine.exec('CREATE SCHEMA '+schema+';SET search_path TO '+schema+',pg_catalog');
  await engine.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
  await engine.exec(await readFile(new URL('./invariants.sql',import.meta.url),'utf8'));
  const pool=new EventEmitter(),queries=[];
  pool.connect=async()=>{let unlock;const before=gate;gate=new Promise(r=>unlock=r);await before;return {query:(sql,args=[])=>{queries.push(sql);return engine.query(sql,args);},release:()=>unlock()};};pool.end=async()=>{};
  const db=createPostgresDatabase(pool,{schema}),crypto=await loadPersistenceCrypto({keyBase64:randomBytes(32).toString('base64')}),store={db,...crypto};
  const root={id:'a'.repeat(24),email:'root@example.test',password:'root-password-long'};
  await engine.query('INSERT INTO users(id,name,email,password_hash,role,created_at,is_master) VALUES($1,$2,$3,$4,$5,$6,1)',[root.id,'Master',root.email,await passwordHash(root.password),'admin',new Date(clock).toISOString()]);
  await engine.exec("INSERT INTO branding VALUES(1,'WhatsApp API');INSERT INTO general_settings(id) VALUES(1)");
  let handler,alerts;const sent=[];const server=http.createServer(async(req,res)=>{try{if(!await handler(req,res)){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await alerts?.close();await db.close();await engine.close();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port,origin=secure?base.replace('http:','https:'):base;
  if(withAlerts)alerts=createPostgresConnectionAlerts(store,{now:()=>clock,mailReady:()=>true,sendEmail:async value=>{sent.push(value);return {messageId:'synthetic-test'};}});
  handler=await createPostgresControlApi({store,origin,alerts,perOwnerLimit,now:()=>clock});
  async function request(route,{method='GET',cookie,body,headers={}}={}){
    // fetch normalizes Host in this runtime; use the HTTP client to exercise a forged raw header.
    if(headers.Host)return new Promise((resolve,reject)=>{
      const req=http.request(base+route,{method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString()),headers:new Headers(res.headers)}));});req.on('error',reject);req.end();
    });
    const res=await fetch(base+route,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(['POST','PATCH'].includes(method)?{'Content-Type':'application/json','X-Requested-With':'wa-platform',Origin:origin}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const type=res.headers.get('content-type')||'',data=type.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer());return {status:res.status,body:data,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  }
  const login=async(credentials=root)=>{const r=await request('/api/auth/login',{method:'POST',body:{email:credentials.email,password:credentials.password}});assert.equal(r.status,200);return r.cookie;};
  async function account(cookie,name,role='user'){
    const credentials={email:name+'@example.test',password:name+'-long-password'},r=await request('/api/users',{method:'POST',cookie,body:{name,...credentials,role}});assert.equal(r.status,201);return {...credentials,id:r.body.user.id,cookie:await login(credentials)};
  }
  return {db,engine,store,root,request,login,account,queries,alerts,sent,now:()=>clock,advance:ms=>clock+=ms};
}
test('HTTP login keeps hashed sessions, enforces CSRF/host, limits expiry and reveals no password hashes',async t=>{
  const app=await fixture(t,{secure:true});
  assert.equal((await app.request('/api/users')).status,401);
  assert.equal((await app.request('/api/auth/login',{method:'POST',body:{email:app.root.email,password:app.root.password},headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await app.request('/api/branding',{headers:{Host:'attacker.example'}})).status,403);
  const logged=await app.request('/api/auth/login',{method:'POST',body:{email:app.root.email,password:app.root.password}});assert.equal(logged.status,200);assert.match(logged.headers.get('set-cookie'),/HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
  const raw=logged.cookie.split('=')[1],session=await app.db.get('SELECT * FROM sessions');assert.equal(session.id,digest(raw));assert.notEqual(session.id,raw);
  const me=await app.request('/api/auth/me',{cookie:logged.cookie});assert.equal(me.body.user.is_master,true);assert.ok(!JSON.stringify(me.body).includes('password'));
  app.advance(43200001);assert.equal((await app.request('/api/auth/me',{cookie:logged.cookie})).status,401);
});
test('HTTP account management preserves admin sharing, protects Master and revokes sessions on access changes',async t=>{
  const app=await fixture(t),root=await app.login(),admin=await app.account(root,'admin2','admin'),user=await app.account(root,'alice');
  assert.equal((await app.request('/api/users',{cookie:user.cookie})).status,403);
  assert.equal((await app.request('/api/users/'+app.root.id,{method:'PATCH',cookie:admin.cookie,body:{name:'Takeover'}})).status,403);
  assert.equal((await app.request('/api/users/'+app.root.id,{method:'PATCH',cookie:root,body:{active:false}})).status,400);
  assert.equal((await app.request('/api/users/'+user.id,{method:'PATCH',cookie:root,body:{name:'Alice renamed'}})).status,200);
  assert.equal((await app.request('/api/auth/me',{cookie:user.cookie})).status,200);
  assert.equal((await app.request('/api/users/'+user.id,{method:'PATCH',cookie:admin.cookie,body:{active:false}})).status,200);
  assert.equal((await app.request('/api/auth/me',{cookie:user.cookie})).status,401);
  assert.equal((await app.request('/api/auth/login',{method:'POST',body:{email:user.email,password:user.password}})).status,401);
  await app.request('/api/users/'+user.id,{method:'PATCH',cookie:root,body:{active:true}});const fresh=await app.login(user);
  await app.request('/api/users/'+user.id,{method:'PATCH',cookie:root,body:{role:'admin'}});assert.equal((await app.request('/api/auth/me',{cookie:fresh})).status,401);
  const collision=await app.request('/api/users/'+user.id,{method:'PATCH',cookie:root,body:{email:admin.email}});assert.equal(collision.status,409);
  assert.equal((await app.db.get('SELECT email FROM users WHERE id=$1',[user.id])).email,user.email);
  const users=await app.request('/api/users',{cookie:root});assert.ok(!JSON.stringify(users.body).includes('password_hash'));
});
test('HTTP instance creation and cosmetic edits preserve ID/token, audit real actor and isolate owners',async t=>{
  const app=await fixture(t),root=await app.login(),alice=await app.account(root,'alice'),bob=await app.account(root,'bob'),admin=await app.account(root,'secondadmin','admin');
  const created=await app.request('/api/instances',{method:'POST',cookie:alice.cookie,body:{name:'Canal A'}});assert.equal(created.status,201);const i=created.body.instance;
  assert.equal(i.owner_id,alice.id);assert.equal(i.token.length,64);
  assert.notEqual((await app.db.get('SELECT token FROM instances WHERE id=$1',[i.id])).token,i.token);
  assert.equal((await app.request('/api/instances',{method:'POST',cookie:alice.cookie,body:{name:'bad',owner_id:bob.id}})).status,403);
  assert.equal((await app.request('/api/instances/'+i.id,{cookie:bob.cookie})).status,404);
  assert.equal((await app.request('/api/instances/'+i.id,{cookie:admin.cookie})).status,200);
  const renamed=await app.request('/api/instances/'+i.id,{method:'PATCH',cookie:admin.cookie,body:{name:'Corrigido',webhook_url:'https://example.test/private?token=synthetic-secret'}});assert.equal(renamed.status,200);assert.equal(renamed.body.instance.id,i.id);assert.equal(renamed.body.instance.token,i.token);
  const history=await app.request('/api/instances/'+i.id+'/activity',{cookie:alice.cookie});assert.ok(history.body.events.some(e=>e.actor_id===admin.id&&e.action==='instance_updated'&&e.outcome==='success'));assert.ok(!JSON.stringify(history.body).includes('synthetic-secret'));
  const total=history.body.total;await app.request('/api/instances/'+i.id,{cookie:alice.cookie});assert.equal((await app.request('/api/instances/'+i.id+'/activity',{cookie:alice.cookie})).body.total,total);
  assert.equal((await app.request('/api/instances',{cookie:bob.cookie})).body.instances.length,0);
  const listing=await app.request('/api/instances',{cookie:alice.cookie});assert.ok(!JSON.stringify(listing.body).includes(i.token));
  const rotated=await app.request('/api/instances/'+i.id+'/token',{method:'POST',cookie:alice.cookie,body:{}});assert.equal(rotated.status,200);assert.notEqual(rotated.body.instance.token,i.token);
  assert.equal((await app.request('/api/general-admin/activity',{cookie:alice.cookie})).status,403);
});
test('instance quota is enforced atomically and dashboard batching avoids a query per instance',async t=>{
  const app=await fixture(t,{perOwnerLimit:2}),root=await app.login();
  const results=await Promise.all([1,2,3].map(n=>app.request('/api/instances',{method:'POST',cookie:root,body:{name:'Channel '+n}})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,201,409]);assert.equal((await app.db.get('SELECT count(*) AS n FROM instances')).n,2);
  const rows=await app.db.all('SELECT * FROM instances ORDER BY id');
  await app.db.run('UPDATE instances SET active=0 WHERE id=$1',[rows[0].id]);
  const disabled=await app.request('/api/instances?state=disabled',{cookie:root});assert.equal(disabled.body.instances.length,1);assert.equal(disabled.body.instances[0].status,'disabled');assert.deepEqual(disabled.body.totals,{active:1,disabled:1});
  app.queries.length=0;const dashboard=await app.request('/api/dashboard',{cookie:root});assert.equal(dashboard.body.counts.instances,1);assert.equal(dashboard.body.counts.disabled,1);
  const grouped=app.queries.filter(q=>q.includes('GROUP BY instance_id,status'));assert.equal(grouped.length,1);
  assert.equal(app.queries.filter(q=>q.includes('FROM messages')).length,1);
  assert.equal((await app.request('/api/instances?state=bad',{cookie:root})).status,400);
});
test('branding port retains Master-only edits, image sanitization and public raster reads',async t=>{
  const app=await fixture(t),root=await app.login(),other=await app.account(root,'admin2','admin');
  assert.equal((await app.request('/api/branding',{method:'PATCH',cookie:other.cookie,body:{name:'Denied'}})).status,403);
  const png=await sharp({create:{width:4,height:4,channels:3,background:'#14876b'}}).png().toBuffer();
  const updated=await app.request('/api/branding',{method:'PATCH',cookie:root,body:{name:'MF WhatsApp',positive:'data:image/png;base64,'+png.toString('base64')}});assert.equal(updated.status,200);assert.ok(updated.body.branding.positive.startsWith('/brand-assets/positive.png'));
  const image=await app.request(updated.body.branding.positive);assert.equal(image.status,200);assert.equal((await sharp(image.body).metadata()).format,'png');
  const invalid=await app.request('/api/branding',{method:'PATCH',cookie:root,body:{name:'Should not commit',negative:'data:image/png;base64,YmFk'}});assert.equal(invalid.status,400);
  assert.equal((await app.request('/api/branding')).body.branding.name,'MF WhatsApp');
});
test('rate limit uses socket IP despite forged forwarding headers; logout and password changes invalidate sessions',async t=>{
  const app=await fixture(t),root=await app.login(),user=await app.account(root,'alice');
  const changed=await app.request('/api/users/'+user.id,{method:'PATCH',cookie:root,body:{password:'different-password-long'}});assert.equal(changed.status,200);
  assert.equal((await app.request('/api/auth/me',{cookie:user.cookie})).status,401);
  const cookie=await app.login({...user,password:'different-password-long'});
  await app.request('/api/auth/logout',{method:'POST',cookie,body:{}});assert.equal((await app.request('/api/auth/me',{cookie})).status,401);
  for(let n=0;n<20;n++)assert.equal((await app.request('/api/auth/login',{method:'POST',body:{email:'missing'+n+'@example.test',password:'wrong'},headers:{'X-Forwarded-For':'192.0.2.'+n}})).status,401);
  const limited=await app.request('/api/auth/login',{method:'POST',body:{email:'another@example.test',password:'wrong'}});assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'900');
  app.advance(900001);assert.equal((await app.request('/api/auth/login',{method:'POST',body:{email:'another@example.test',password:'wrong'}})).status,401);
});
test('login rechecks a concurrent access change before committing a new session',async t=>{
  const app=await fixture(t);let flipped=false;
  const wrapped={...app.db,get:async(sql,args)=>{const r=await app.db.get(sql,args);if(sql==='SELECT * FROM users WHERE email=$1'&&!flipped){flipped=true;await app.db.run('UPDATE users SET password_hash=$1 WHERE id=$2',[await passwordHash('replacement-password-long'),app.root.id]);}return r;}};
  const accounts=await createPostgresAccounts(wrapped);
  await assert.rejects(accounts.login({email:app.root.email,password:app.root.password}),e=>e.code==='invalid_credentials');
  assert.equal((await app.db.get('SELECT count(*) AS n FROM sessions')).n,0);
});
test('instance creation rolls back both row and successful audit when audit persistence fails',async t=>{
  const app=await fixture(t),actor=await app.db.get('SELECT * FROM users WHERE id=$1',[app.root.id]),activity=createPostgresInstanceActivity(app.db);
  const instances=createPostgresInstances(app.store,{activity:{...activity,record:async()=>{throw Object.assign(new Error('audit unavailable'),{code:'AUDIT_UNAVAILABLE'});}}});
  await assert.rejects(instances.create(actor,{name:'Must rollback'}),e=>e.code==='AUDIT_UNAVAILABLE');assert.equal((await app.db.get('SELECT count(*) AS n FROM instances')).n,0);
  assert.equal((await app.db.get('SELECT count(*) AS n FROM instance_activity')).n,0);
});
test('duplicate concurrent emails, unexpected fields and SQL-shaped names are handled without privilege escalation',async t=>{
  const app=await fixture(t),root=await app.login(),body={name:'Duplicate',email:'duplicate@example.test',password:'duplicate-long-password'};
  const duplicates=await Promise.all([1,2].map(()=>app.request('/api/users',{method:'POST',cookie:root,body})));assert.deepEqual(duplicates.map(r=>r.status).sort(),[201,409]);
  assert.equal((await app.request('/api/users',{method:'POST',cookie:root,body:{...body,email:'master2@example.test',is_master:true}})).status,400);
  assert.equal((await app.request('/api/instances',{method:'POST',cookie:root,body:[]})).status,400);
  const name="O'Reilly'); DROP TABLE users; --",created=await app.request('/api/instances',{method:'POST',cookie:root,body:{name}});assert.equal(created.status,201);assert.equal(created.body.instance.name,name);
  assert.equal((await app.db.get('SELECT count(*) AS n FROM users')).n,2);
  const withoutCsrf=await app.request('/api/auth/logout',{method:'POST',cookie:root,body:{},headers:{'X-Requested-With':'wrong'}});assert.equal(withoutCsrf.status,403);
});
test('general-admin HTTP shares alert email across admins, protects USER and records real email-test actors',async t=>{
  const app=await fixture(t,{withAlerts:true}),root=await app.login(),admin=await app.account(root,'admin2','admin'),user=await app.account(root,'alice');
  assert.equal((await app.request('/api/general-admin',{cookie:user.cookie})).status,403);
  assert.equal((await app.request('/api/general-admin',{method:'PATCH',cookie:root,body:{alert_email:'team@example.test'}})).status,200);
  assert.equal((await app.request('/api/general-admin',{cookie:admin.cookie})).body.settings.alert_email,'team@example.test');
  assert.equal((await app.request('/api/general-admin/test-email',{method:'POST',cookie:admin.cookie,body:{}})).status,200);assert.equal(app.sent.length,1);assert.equal(app.sent[0].test,true);
  assert.equal((await app.request('/api/general-admin/test-email',{method:'POST',cookie:root,body:{}})).status,429);
  const events=(await app.request('/api/general-admin/activity',{cookie:root})).body.events;assert.ok(events.some(e=>e.actor_id===admin.id&&e.action==='alert_email_test'&&e.outcome==='success'));
  assert.equal((await app.request('/api/general-admin',{method:'PATCH',cookie:root,body:{alert_email:'bad@example.test\r\nBcc: other@example.test'}})).status,400);
});
