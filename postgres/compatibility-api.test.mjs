import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {apiFixture} from './api-fixture.mjs';

test('integration keeps form/Bearer/query tokens, numeric IDs, outgoing filters and verified ACK epochs',async t=>{
  const f=await apiFixture(t),id=f.ids[0],token=f.tokens.get(id),socket=await f.connect();
  const queued=await f.request('/instance'+id+'/messages/chat',{method:'POST',form:new URLSearchParams({token,to:'5511888888888',body:'synthetic hello',referenceId:'ref-1'}),headers:{'Content-Type':'application/x-www-form-urlencoded'}});assert.equal(queued.status,200);assert.equal(queued.body.sent,'true');assert.equal(typeof queued.body.id,'number');
  await f.transport.idle();assert.equal(socket.sends.length,1);
  const list=await f.api('messages',{params:{id:String(queued.body.id),to:'5511888888888@c.us',ack:'device',referenceId:'ref-1',sort:'desc'}});assert.equal(list.status,200);assert.equal(list.body.total,1);assert.equal(list.body.messages[0].referenceId,'ref-1');assert.equal(typeof list.body.messages[0].sent_at,'number');assert.ok(list.body.messages[0].sent_at>0);
  const stored=await f.db.get('SELECT * FROM messages');assert.equal((await f.api('messages',{params:{id:stored.id}})).body.total,1);
  const bearer=await f.request('/instance'+id+'/instance/status',{headers:{Authorization:'Bearer '+token}});assert.equal(bearer.status,200);assert.equal(bearer.body.status.accountStatus,'authenticated');
  assert.equal((await f.api('messages',{params:{id:"'; DROP TABLE users; --"}})).body.total,0);assert.equal((await f.api('messages',{params:{sort:'desc; drop'}})).status,400);
});
test('tokens are instance scoped; blocked owner, inactive instance and rotation keep their distinct responses',async t=>{
  const f=await apiFixture(t),id=f.ids[0],token=f.tokens.get(id);
  assert.equal((await f.api('instance/status',{id:f.ids[1],token})).status,401);
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[id]);assert.equal((await f.api('instance/status')).status,409);assert.equal((await f.api('instance/status',{token:'wrong'})).status,401);
  await f.db.run('UPDATE instances SET active=1 WHERE id=$1',[id]);await f.db.run('UPDATE users SET active=0 WHERE id=$1',[f.user.id]);assert.equal((await f.api('instance/status')).status,401);
  await f.db.run('UPDATE users SET active=1 WHERE id=$1',[f.user.id]);const root=await f.login();const rotated=await f.request('/api/instances/'+id+'/token',{method:'POST',cookie:root,data:{}});assert.equal(rotated.status,200);assert.equal((await f.api('instance/status',{token})).status,401);assert.equal((await f.api('instance/status',{token:rotated.body.instance.token})).status,200);
});
test('asynchronous media preparation rechecks token and activation immediately before enqueue',async t=>{
  let started,release;const began=new Promise(r=>started=r),barrier=new Promise(r=>release=r);
  const f=await apiFixture(t,{mediaLoader:async()=>{started();await barrier;return {bytes:Buffer.from('synthetic'),mimetype:'image/png',filename:''};}}),id=f.ids[0];
  const pending=f.api('messages/image',{method:'POST',data:{to:'5511888888888',image:'https://synthetic.example.test/file.png'}});await began;
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[id]);release();const res=await pending;assert.equal(res.status,409);assert.equal((await f.db.get('SELECT count(*) AS n FROM messages')).n,0);
});
test('media upload, reuse, multipart and legacy reads keep attachments temporary and instance scoped',async t=>{
  const f=await apiFixture(t),id=f.ids[0],token=f.tokens.get(id),png=await sharp({create:{width:3,height:3,channels:3,background:'#117755'}}).png().toBuffer();
  const upload=await f.api('media/upload',{method:'POST',data:{file:png.toString('base64'),filename:'sample.png'}});assert.equal(upload.status,200);
  const own=await f.api('messages/image',{method:'POST',data:{to:'5511888888888',image:upload.body.url}});assert.equal(own.status,200);
  const form=new FormData();form.set('token',token);form.set('to','5511888888888');form.set('filename','sample.pdf');form.set('document',new Blob([Buffer.from('%PDF-1.4\nsynthetic')],{type:'application/pdf'}),'sample.pdf');
  const document=await f.request('/instance'+id+'/messages/document',{method:'POST',form});assert.equal(document.status,200);
  const key=new URL(upload.body.url).pathname.split('/').pop();assert.equal((await f.request('/instance'+f.ids[1]+'/media/'+key)).status,404);assert.equal((await f.request(new URL(upload.body.url).pathname)).status,200);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM media')).n,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM media_objects')).n,0);
  await f.db.run('INSERT INTO media(instance_id,message_id,mimetype,data,created_at) VALUES($1,$2,$3,$4,$5)',[id,'legacy','application/pdf',Buffer.from('legacy synthetic'),new Date().toISOString()]);const old=await f.api('media/legacy');assert.equal(old.status,200);assert.equal(old.body.toString(),'legacy synthetic');
});
test('queue capacity is atomic, clear skips sending/incoming rows and resends require an explicit command',async t=>{
  const f=await apiFixture(t),id=f.ids[0];await f.db.run("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) SELECT 'bulk-'||n::text,$1,'5511888888888','synthetic','chat','queue','pending',$2 FROM generate_series(1,999) n",[id,new Date().toISOString()]);
  const result=await Promise.all([1,2].map(n=>f.api('messages/chat',{method:'POST',data:{to:'5511888888888',body:'last '+n}})));assert.deepEqual(result.map(r=>r.status).sort(),[200,429]);assert.equal((await f.db.get("SELECT count(*) AS n FROM messages WHERE status='queue'")).n,1000);
  await f.db.run("UPDATE messages SET status='sending',provider_id='inflight' WHERE id='bulk-1'");await f.db.run("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,direction) VALUES('in',$1,'5511888888888','incoming','chat','received','device',$2,'in')",[id,new Date().toISOString()]);
  assert.equal((await f.api('messages/clear',{method:'POST',data:{status:'all'}})).status,200);assert.equal((await f.db.get('SELECT count(*) AS n FROM messages')).n,2);
  await f.db.run("UPDATE messages SET status='unknown' WHERE id='bulk-1'");assert.equal((await f.api('messages/resendById',{method:'POST',data:{id:'bulk-1'}})).status,200);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='bulk-1'")).status,'queue');assert.equal((await f.api('messages/resendById',{method:'POST',data:{id:'bulk-1'}})).status,409);
  assert.equal((await f.api('messages/resendByStatus',{method:'POST',data:{status:'unknown'}})).status,400);
});
test('settings and API audit preserve integration attribution and exclude message content, tokens and webhook secrets',async t=>{
  const f=await apiFixture(t),id=f.ids[0],token=f.tokens.get(id);
  const settings=await f.api('instance/settings',{method:'POST',data:{sendDelay:'2',webhook_message_received:'false',webhook_url:'https://receiver.example.test/private?token=synthetic-private-secret'}});assert.equal(settings.status,200);
  const read=await f.api('instance/settings');assert.equal(read.body.sendDelay,2);assert.equal(read.body.webhook_message_received,false);
  await f.api('messages/chat',{method:'POST',data:{to:'5511888888888',body:'synthetic-private-conversation'}});const events=await f.activity.list();assert.ok(events.events.some(e=>e.actor_kind==='api'&&e.actor_id==='api:'+id&&e.outcome==='success'));
  const serialized=JSON.stringify(events);assert.ok(!serialized.includes(token));assert.ok(!serialized.includes('synthetic-private-secret'));assert.ok(!serialized.includes('synthetic-private-conversation'));
  assert.ok(!events.events.some(e=>e.action==='api.messages.chat'));assert.equal((await f.db.get('SELECT count(*) AS n FROM messages')).n,1);
});
test('QR endpoints preserve JSON/PNG contracts and await restart/logout with integration attribution',async t=>{
  const f=await apiFixture(t),id=f.ids[0];const qr=await f.api('instance/qrCode');assert.equal(qr.status,200);assert.equal(qr.body.qrCode,null);assert.equal(f.sockets.length,1);
  const socket=f.sockets[0];socket.ev.emit('connection.update',{qr:'synthetic-qr'});await f.transport.idle();const png=await f.api('instance/qr');assert.equal(png.status,200);assert.equal(png.headers.get('content-type'),'image/png');assert.equal(png.body.subarray(1,4).toString(),'PNG');
  socket.ev.emit('creds.update',{registered:true});socket.ev.emit('connection.update',{connection:'open'});await f.transport.idle();assert.equal((await f.api('instance/me')).body.number,'5511000000000');
  assert.equal((await f.api('instance/restart',{method:'POST',data:{}})).status,200);assert.equal(f.sockets.length,2);const next=f.sockets[1];next.ev.emit('connection.update',{connection:'open'});await f.transport.idle();
  assert.equal((await f.api('instance/logout',{method:'POST',data:{}})).status,200);await f.alerts.drain();assert.equal(next.logouts,1);assert.equal((await f.api('instance/status')).body.status.accountStatus,'disconnected');
  const audit=await f.activity.list();assert.ok(audit.events.some(e=>e.action==='api.instance.qrCode'&&e.actor_kind==='api'&&e.outcome==='success'));assert.ok(audit.events.some(e=>e.action==='api.instance.logout'&&e.actor_id==='api:'+id));
});
test('contact/link/location/vcard/voice payload contracts survive PostgreSQL and reject invalid input',async t=>{
  const f=await apiFixture(t),socket=await f.connect(),to='5511888888888';const opus=Buffer.alloc(64);opus.write('OggS');opus.write('OpusHead',28);
  for(const [kind,data] of [['link',{link:'https://example.test/offer'}],['contact',{contact:'5511888888888,5511777777777'}],['location',{address:'Synthetic place',lat:'-22',lng:'-50'}],['vcard',{vcard:'BEGIN:VCARD\nVERSION:3.0\nFN:Synthetic\nEND:VCARD'}],['voice',{audio:opus.toString('base64')}]])assert.equal((await f.api('messages/'+kind,{method:'POST',data:{to,...data}})).status,200);
  await f.transport.idle();assert.equal(socket.sends.length,5);assert.ok(socket.sends.some(s=>s.content.location?.degreesLatitude===-22));assert.ok(socket.sends.some(s=>s.content.audio&&s.content.ptt));
  assert.equal((await f.api('messages/location',{method:'POST',data:{to,address:'bad',lat:91,lng:0}})).status,400);assert.equal((await f.api('messages/chat',{method:'POST',data:{to,body:'ok',priority:20}})).status,400);
  socket.onWhatsApp=async jid=>[{exists:true,jid}];assert.equal((await f.api('contacts/check',{params:{chatId:to}})).body.status,'valid');
});
