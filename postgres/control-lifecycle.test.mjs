import test from 'node:test';
import assert from 'node:assert/strict';
import {apiFixture} from './api-fixture.mjs';

test('panel connect/QR/disconnect keep owner permissions and real administrator attribution',async t=>{
  const f=await apiFixture(t),id=f.ids[0],root=await f.login(),other=await f.login(f.other);
  assert.equal((await f.request('/api/instances/'+id+'/connect',{method:'POST',cookie:other,data:{}})).status,404);
  const connected=await f.request('/api/instances/'+id+'/connect',{method:'POST',cookie:root,data:{}});assert.equal(connected.status,202);const socket=f.sockets[0];socket.ev.emit('connection.update',{qr:'synthetic-qr'});await f.transport.idle();
  const qr=await f.request('/api/instances/'+id+'/qr',{cookie:root});assert.equal(qr.status,200);assert.ok(qr.body.qr.startsWith('data:image/png;base64,'));
  socket.ev.emit('creds.update',{registered:true});socket.ev.emit('connection.update',{connection:'open'});await f.transport.idle();
  const events=(await f.activity.list()).events,confirmed=events.find(e=>e.action==='connection_established');assert.equal(confirmed.actor_id,f.root.id);assert.equal(confirmed.actor_kind,'user');assert.ok(confirmed.request_id);
  assert.equal((await f.request('/api/instances/'+id+'/disconnect',{method:'POST',cookie:root,data:{}})).status,200);await f.transport.idle();await f.alerts.drain();assert.equal(socket.logouts,1);assert.equal(f.mail.length,1);
  const lost=(await f.activity.list()).events.find(e=>e.action==='connection_lost');assert.equal(lost.actor_id,f.root.id);assert.equal(lost.source,'panel');
});
test('panel deactivation preserves token/history/keys, cancels brief outage and reactivation never reconnects automatically',async t=>{
  const f=await apiFixture(t),id=f.ids[0],root=await f.login(),socket=await f.connect();socket.ev.emit('creds.update',{marker:'preserved'});await f.transport.idle();const token=f.tokens.get(id),keysBefore=(await f.db.get('SELECT count(*) AS n FROM wa_keys WHERE instance_id=$1',[id])).n;
  socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:500}}}});await f.transport.idle();assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_candidates')).n,1);
  const disabled=await f.request('/api/instances/'+id+'/lifecycle',{method:'POST',cookie:root,data:{active:false}});assert.equal(disabled.status,200);assert.equal(disabled.body.instance.token,token);assert.equal(disabled.body.instance.status,'disabled');assert.equal(socket.logouts,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys WHERE instance_id=$1',[id])).n,keysBefore);
  await f.alerts.drain();assert.equal(f.mail.length,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM connection_candidates')).n,0);
  const stamp=disabled.body.instance.disabled_at;assert.equal((await f.request('/api/instances/'+id+'/lifecycle',{method:'POST',cookie:root,data:{active:false}})).body.instance.disabled_at,stamp);
  const archived=await f.request('/api/instances?state=disabled',{cookie:root});assert.ok(archived.body.instances.some(i=>i.id===id));assert.equal((await f.api('instance/status')).status,409);assert.equal((await f.request('/api/instances/'+id+'/qr',{cookie:root})).body.qr,null);
  const count=f.sockets.length;assert.equal((await f.request('/api/instances/'+id+'/lifecycle',{method:'POST',cookie:root,data:{active:true}})).status,200);assert.equal(f.sockets.length,count);assert.equal((await f.db.get('SELECT auto_connect FROM instances WHERE id=$1',[id])).auto_connect,0);
  await f.request('/api/instances/'+id+'/qr',{cookie:root});assert.equal(f.sockets.length,count);assert.equal((await f.request('/api/instances/'+id+'/connect',{method:'POST',cookie:root,data:{}})).status,202);assert.equal(f.sockets.length,count+1);assert.equal(f.sockets.at(-1).config.auth.creds.marker,'preserved');
});
test('only message-tab reads are logged, search/pagination stay scoped and audit never includes message bodies',async t=>{
  const f=await apiFixture(t),id=f.ids[0],owner=await f.login(f.user),other=await f.login(f.other);
  await f.api('messages/chat',{method:'POST',data:{to:'5511888888888',body:'outgoing synthetic-private-body'}});await f.api('messages/chat',{id:f.ids[1],method:'POST',data:{to:'5511777777777',body:'other private body'}});
  await f.db.run("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,direction) VALUES('incoming',$1,'5511888888888','100% synthetic-private-body','chat','received','device',$2,'in')",[id,new Date().toISOString()]);
  const before=(await f.activity.list()).events.filter(e=>e.action==='messages_viewed').length;await f.request('/api/instances/'+id,{cookie:owner});await f.request('/api/instances/'+id+'/activity',{cookie:owner});assert.equal((await f.activity.list()).events.filter(e=>e.action==='messages_viewed').length,before);
  const all=await f.request('/api/instances/'+id+'/messages?limit=1',{cookie:owner});assert.equal(all.status,200);assert.equal(all.body.total,2);assert.equal(all.body.messages.length,1);
  const filtered=await f.request('/api/instances/'+id+'/messages?query=%25',{cookie:owner});assert.equal(filtered.body.total,1);assert.equal(filtered.body.messages[0].id,'incoming');assert.equal(typeof filtered.body.messages[0].sent_at,'number');
  assert.equal((await f.request('/api/instances/'+id+'/messages',{cookie:other})).status,404);
  const audit=await f.activity.list();assert.equal(audit.events.filter(e=>e.action==='messages_viewed'&&e.actor_id===f.user.id).length,before+2);assert.ok(!JSON.stringify(audit).includes('synthetic-private-body'));assert.ok(!JSON.stringify(audit).includes('other private body'));
});
