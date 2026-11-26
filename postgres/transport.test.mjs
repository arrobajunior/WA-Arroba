import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {postgresFixture} from './test-fixture.mjs';
import {createPostgresTransport} from './transport.mjs';
import {createPostgresMessageQueue} from './message-queue.mjs';
import {createPostgresConnectionAlerts} from './connection-alerts.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createMediaRelay} from '../media-relay.mjs';

function syntheticOwnership(){
  let active=true;const callbacks=new Set();
  return {active:()=>active,assert:async()=>{if(!active)throw Object.assign(new Error('TRANSPORT_OWNERSHIP_LOST'),{code:'TRANSPORT_OWNERSHIP_LOST',status:503});},onLost:fn=>{callbacks.add(fn);return ()=>callbacks.delete(fn);},lose:()=>{active=false;for(const fn of callbacks)fn();}};
}
async function fixture(t,options={}){
  const f=await postgresFixture(),ownership=syntheticOwnership(),sockets=[],hooks=[],transports=[],relay=createMediaRelay();
  await f.db.run('UPDATE instances SET settings=$1',[JSON.stringify({sendDelay:0,sendDelayMax:0})]);
  const defaults={ownership,mediaRelay:relay,retryDelay:50,webhookRetryMs:5,mediaBaseUrl:'https://synthetic.example.test',socketFactory:config=>{
    const socket={config,ev:new EventEmitter(),onWhatsApp:async jid=>[{exists:true,jid}],user:{id:'5511000000000:1@s.whatsapp.net',name:'Synthetic'},endCalls:0,logoutCalls:0,sends:[],end(){this.endCalls++;},async logout(){this.logoutCalls++;},async sendMessage(jid,content,settings){this.sends.push({jid,content,settings});return {};},updateMediaMessage:async()=>{}};sockets.push(socket);return socket;
  },webhookSender:async(url,payload)=>{hooks.push({url,payload});}};
  const create=opts=>{const transport=createPostgresTransport(f.store,{...defaults,...options,...opts});transports.push(transport);return transport;};
  const transport=create();
  t.after(async()=>{for(const tr of transports)await tr.close();await f.close();});
  async function message(id,fields={}){
    const row={instance_id:f.ids[0],recipient:'5511999999999',body:'synthetic body',type:'chat',status:'queue',ack:'pending',created_at:new Date().toISOString(),priority:10,...fields,id};
    const names=Object.keys(row),params=names.map((_,i)=>'$'+(i+1));await f.db.run('INSERT INTO messages('+names.join(',')+') VALUES('+params.join(',')+')',Object.values(row));return row;
  }
  const open=async(id=f.ids[0])=>{await transport.connect(id);const socket=sockets.at(-1);socket.ev.emit('connection.update',{connection:'open'});await transport.idle();return socket;};
  return {...f,ownership,sockets,hooks,relay,transport,create,message,open};
}
test('PostgreSQL transport persists QR/credentials, reuses one socket and restores without logging out',async t=>{
  const f=await fixture(t),id=f.ids[0];await Promise.all([f.transport.connect(id),f.transport.connect(id)]);assert.equal(f.sockets.length,1);
  const first=f.sockets[0];first.ev.emit('connection.update',{qr:'synthetic-private-qr'});first.ev.emit('creds.update',{registered:true,marker:'synthetic-private-secret'});await f.transport.idle();assert.equal(f.transport.state(id).status,'qr');
  const saved=await f.db.get("SELECT value FROM wa_keys WHERE instance_id=$1 AND kind='creds'",[id]);assert.ok(!saved.value.includes('synthetic-private-secret'));
  first.ev.emit('connection.update',{connection:'open'});await f.transport.idle();await f.transport.close();assert.equal(first.logoutCalls,0);
  const next=f.create();await next.restore();assert.equal(f.sockets.length,2);assert.equal(f.sockets[1].config.auth.creds.marker,'synthetic-private-secret');
  first.ev.emit('connection.update',{qr:'stale'});await next.idle();assert.equal(next.state(id).qr,null);
});
test('single-flight queue sends once, preserves higher ACKs and never automatically repeats an uncertain send',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();await f.message('m1');
  socket.sendMessage=async(jid,content,options)=>{socket.sends.push(options);socket.ev.emit('messages.update',[{key:{id:options.messageId,remoteJid:jid},update:{status:4}}]);return {};};
  await Promise.all([f.transport.flush(id),f.transport.flush(id),f.transport.flush(id)]);await f.transport.idle();assert.equal(socket.sends.length,1);
  const sent=await f.db.get("SELECT * FROM messages WHERE id='m1'");assert.equal(sent.ack,'read');assert.equal(sent.status,'sent');
  socket.ev.emit('messages.update',[{key:{id:sent.provider_id},update:{status:2}}]);await f.transport.idle();assert.equal((await f.db.get("SELECT ack FROM messages WHERE id='m1'")).ack,'read');
  await f.message('m2');let attempts=0;socket.sendMessage=async()=>{attempts++;throw new Error('uncertain synthetic timeout');};
  await f.transport.flush(id);await f.transport.idle();assert.equal((await f.db.get("SELECT status FROM messages WHERE id='m2'")).status,'unknown');await f.transport.flush(id);assert.equal(attempts,1);
});
test('priority, expiry, blocked owner and targeted recovery respect separate instance queues',async t=>{
  const f=await fixture(t),id=f.ids[0],other=f.ids[1],socket=await f.open();
  await f.message('expired',{created_at:new Date(Date.now()-25*3600000).toISOString()});await f.message('normal',{priority:10});await f.message('urgent',{priority:0});
  await f.message('other-sending',{instance_id:other,status:'sending',provider_id:'external'});
  await f.db.run('UPDATE users SET active=0 WHERE id=$1',[f.user.id]);await f.transport.flush(id);assert.equal(socket.sends.length,0);
  await f.db.run('UPDATE users SET active=1 WHERE id=$1',[f.user.id]);await f.transport.flush(id);await f.transport.idle();assert.equal(socket.sends.length,2);
  assert.equal((await f.db.get("SELECT status FROM messages WHERE id='expired'")).status,'expired');
  const queue=createPostgresMessageQueue(f.store,{ownership:f.ownership});await queue.recoverInterrupted(id);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='other-sending'")).status,'sending');
  await queue.recoverInterrupted();assert.equal((await f.db.get("SELECT status FROM messages WHERE id='other-sending'")).status,'unknown');
});
test('suspension preserves credentials, excludes inactive restore and requires an explicit reconnect',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();socket.ev.emit('creds.update',{registered:true,marker:'retained'});await f.transport.idle();await f.message('paused');
  await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[id]);await f.transport.suspend(id);assert.equal(socket.logoutCalls,0);assert.ok(await f.db.get('SELECT value FROM wa_keys WHERE instance_id=$1',[id]));
  await f.transport.flush(id);assert.equal(socket.sends.length,0);await assert.rejects(f.transport.connect(id),e=>e.code==='instance_disabled');
  const count=f.sockets.length;await f.transport.restore();assert.equal(f.sockets.length,count);await f.db.run('UPDATE instances SET active=1 WHERE id=$1',[id]);await f.transport.restore();assert.equal(f.sockets.length,count);
  await f.transport.connect(id);assert.equal(f.sockets.length,count+1);assert.equal(f.sockets.at(-1).config.auth.creds.marker,'retained');
});
test('disconnect clears keys after draining old callbacks, reset preserves other instances and the audit log',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();socket.ev.emit('creds.update',{registered:true,marker:'remove'});await f.transport.idle();
  await f.db.run('INSERT INTO wa_keys VALUES($1,$2,$3,$4)',[f.ids[1],'session','one',f.store.encrypt('{}')]);
  const activity=createPostgresInstanceActivity(f.db);await activity.record({instance:{id,name:'Synthetic'},action:'test_event'});
  await f.transport.disconnect(id);assert.equal(socket.logoutCalls,1);assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys WHERE instance_id=$1',[id])).n,0);
  socket.ev.emit('creds.update',{marker:'late'});await f.transport.idle();assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys WHERE instance_id=$1',[id])).n,0);
  await f.transport.connect(id);await f.message('own');await f.message('other',{instance_id:f.ids[1]});await f.transport.reset(id);
  assert.equal((await f.db.get("SELECT count(*) AS n FROM messages WHERE id='own'")).n,0);assert.equal((await f.db.get("SELECT count(*) AS n FROM messages WHERE id='other'")).n,1);assert.equal((await activity.list()).total,1);assert.ok(await f.db.get('SELECT value FROM wa_keys WHERE instance_id=$1',[f.ids[1]]));
});
test('incoming LID messages resolve known phones, remain durable once and unresolved/group identities are preserved',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();await f.db.run('UPDATE instances SET webhook_url=$1 WHERE id=$2',['https://receiver.example.test/private',id]);
  const msg={key:{id:'incoming1',remoteJid:'224652626501854@lid',senderPn:'5511988887777@s.whatsapp.net',fromMe:false},message:{conversation:'synthetic incoming'},messageTimestamp:Math.floor(Date.now()/1000),pushName:'Synthetic client'};
  socket.ev.emit('messages.upsert',{type:'notify',messages:[msg,msg]});await f.transport.idle();assert.equal(f.hooks.length,1);assert.equal(f.hooks[0].payload.data.from,'5511988887777@c.us');assert.equal(f.hooks[0].payload.data.phoneResolved,true);assert.equal(f.hooks[0].payload.data.remoteJid,'224652626501854@lid');
  assert.equal((await f.db.get('SELECT count(*) AS n FROM messages')).n,1);await f.transport.restart(id);const next=f.sockets.at(-1);next.ev.emit('connection.update',{connection:'open'});
  next.ev.emit('messages.upsert',{type:'notify',messages:[{...msg,key:{id:'incoming2',remoteJid:msg.key.remoteJid}}]});await f.transport.idle();assert.equal(f.hooks.at(-1).payload.data.from,'5511988887777@c.us');
  next.ev.emit('messages.upsert',{type:'notify',messages:[{...msg,key:{id:'unknown',remoteJid:'123456789@lid'}},{...msg,key:{id:'group',remoteJid:'123456-789@g.us',participant:'224652626501854@lid'}}]});await f.transport.idle();
  assert.equal(f.hooks.find(h=>h.payload.data.id.endsWith('_unknown')).payload.data.phoneResolved,false);assert.equal(f.hooks.find(h=>h.payload.data.id.endsWith('_group')).payload.data.from,'123456-789@g.us');assert.equal(f.hooks.find(h=>h.payload.data.id.endsWith('_group')).payload.data.author,'5511988887777@c.us');
});
test('recovered sockets cancel retries and the async alert integration stays quiet for natural reconnects',async t=>{
  const base=await postgresFixture(),sent=[],activity=createPostgresInstanceActivity(base.db),alerts=createPostgresConnectionAlerts(base.store,{mailReady:()=>true,sendEmail:async value=>{sent.push(value);return {};},onConnectionEvent:activity.connectionState});
  const owner=syntheticOwnership(),sockets=[];
  const transport=createPostgresTransport(base.store,{ownership:owner,retryDelay:100,socketFactory:config=>{const s={config,ev:new EventEmitter(),onWhatsApp:async jid=>[{exists:true,jid}],user:{id:'5511000000000@s.whatsapp.net'},end(){},sendMessage:async()=>({})};sockets.push(s);return s;},onConnectionState:alerts.stateChanged});
  t.after(async()=>{await transport.close();await alerts.close();await base.close();});
  await transport.connect(base.ids[0]);const s=sockets[0];s.ev.emit('connection.update',{connection:'open'});await transport.idle();const count=(await activity.list()).total;
  s.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:428}}}});s.ev.emit('connection.update',{connection:'open'});await transport.idle();await new Promise(r=>setTimeout(r,150));await transport.idle();await alerts.drain();
  assert.equal(sockets.length,1);assert.equal(transport.state(base.ids[0]).status,'authenticated');assert.equal(sent.length,0);assert.equal((await activity.list()).total,count);
});
test('media survives an in-process reconnect and eligibility is checked again after async loading',async t=>{
  let began,release;const entered=new Promise(r=>began=r),barrier=new Promise(r=>release=r);
  const f=await fixture(t,{mediaLoader:async()=>{began();await barrier;return {bytes:Buffer.from('synthetic bytes'),mimetype:'image/png'};}}),id=f.ids[0];
  const media=f.relay.put(id,Buffer.from('retained bytes'),'image/png','synthetic.png');await f.message('local-media',{type:'image',media_id:media});
  await f.open();assert.equal((await f.db.get("SELECT status FROM messages WHERE id='local-media'")).status,'sent');
  await f.message('remote-media',{type:'image',source_url:f.store.encrypt('https://synthetic.example.test/image.png')});const flushing=f.transport.flush(id);await entered;
  try{await f.db.run('UPDATE instances SET active=0 WHERE id=$1',[id]);}finally{release();await flushing;}
  assert.equal((await f.db.get("SELECT status FROM messages WHERE id='remote-media'")).status,'queue');assert.equal(f.sockets[0].sends.length,1);
});
test('losing ownership stops all sockets and prevents sends even if old socket events arrive',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();f.ownership.lose();assert.equal(f.transport.state(id).status,'disconnected');assert.ok(socket.endCalls>0);
  await f.message('never-send');socket.ev.emit('connection.update',{connection:'open'});await f.transport.flush(id);await f.transport.idle();assert.equal(socket.sends.length,0);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='never-send'")).status,'queue');
  await assert.rejects(f.transport.connect(id),e=>e.code==='TRANSPORT_OWNERSHIP_LOST');
});
test('terminal logout clears only its own credentials and exhausted retries stop after five reconnects',async t=>{
  const events=[],f=await fixture(t,{retryDelay:1,onConnectionState:async(...args)=>events.push(args)}),id=f.ids[0],socket=await f.open();
  socket.ev.emit('creds.update',{registered:true,marker:'remove-on-401'});await f.transport.idle();socket.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:401}}}});await f.transport.idle();
  assert.match(f.transport.state(id).error,/QR Code/);assert.equal((await f.db.get('SELECT count(*) AS n FROM wa_keys WHERE instance_id=$1',[id])).n,0);assert.equal((await f.db.get('SELECT auto_connect FROM instances WHERE id=$1',[id])).auto_connect,0);
  await f.transport.close();let count=0;
  const retry=f.create({socketFactory:config=>{const s={config,ev:new EventEmitter(),onWhatsApp:async jid=>[{exists:true,jid}],user:{id:'5511000000000@s.whatsapp.net'},end(){},sendMessage:async()=>({})};count++;queueMicrotask(()=>s.ev.emit('connection.update',{connection:'close',lastDisconnect:{error:{output:{statusCode:503}}}}));return s;}});
  await retry.connect(id);const deadline=Date.now()+5000;while((count<6||retry.state(id).status!=='disconnected')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));await retry.idle();
  assert.equal(count,6);assert.equal(retry.state(id).status,'disconnected');assert.equal((await f.db.get('SELECT auto_connect FROM instances WHERE id=$1',[id])).auto_connect,0);assert.ok(events.some(e=>e[3].terminal&&e[3].reconnectAttempt===5));
});
test('graceful close drains already captured incoming messages and latest credential snapshots before ending',async t=>{
  const f=await fixture(t),id=f.ids[0],socket=await f.open();await f.db.run('UPDATE instances SET webhook_url=$1 WHERE id=$2',['https://receiver.example.test/hook',id]);
  socket.ev.emit('creds.update',{registered:true,marker:'latest-before-close'});
  socket.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'last-before-close',remoteJid:'5511888888888@s.whatsapp.net'},message:{conversation:'captured before stop'},messageTimestamp:Math.floor(Date.now()/1000)}]});
  await f.transport.close();assert.equal((await f.db.get("SELECT body FROM messages WHERE provider_id='last-before-close'")).body,'captured before stop');assert.equal(f.hooks.length,1);
  assert.equal(JSON.parse(f.store.decrypt((await f.db.get("SELECT value FROM wa_keys WHERE instance_id=$1 AND kind='creds'",[id])).value)).marker,'latest-before-close');
  assert.throws(()=>createPostgresTransport(f.store,{}),/OWNERSHIP_REQUIRED/);
});
test('media payloads use volatile bytes, preserve document filenames and malformed payloads stop without a retry loop',async t=>{
  const f=await fixture(t),socket=await f.open();
  for(const type of ['image','audio','ptt','video','document','sticker']){
    const media=f.relay.put(f.ids[0],Buffer.from('synthetic-'+type),type==='document'?'application/pdf':type.startsWith('a')||type==='ptt'?'audio/ogg':'image/png','synthetic.'+type);
    await f.message(type,{type,media_id:media,filename:'arquivo.pdf'});
  }
  await f.transport.flush(f.ids[0]);await f.transport.idle();assert.equal(socket.sends.length,6);assert.ok(socket.sends.some(s=>s.content.document&&s.content.fileName==='arquivo.pdf'));assert.ok(socket.sends.some(s=>s.content.audio&&s.content.ptt===true));
  assert.equal((await f.db.get('SELECT count(*) AS n FROM media')).n,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM media_objects')).n,0);
  await f.message('bad-json',{payload:'{invalid'});await f.transport.flush(f.ids[0]);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='bad-json'")).status,'unsent');assert.equal(socket.sends.length,6);
});
test('incoming media and webhook retries retain the public payload without persisting attachment bytes',async t=>{
  let attempts=0;const delivered=[];const f=await fixture(t,{mediaDownloader:async()=>Buffer.from('synthetic-media-bytes'),webhookSender:async(_url,payload)=>{attempts++;if(attempts<3)throw new Error('temporary');delivered.push(payload);}}),socket=await f.open(),id=f.ids[0];
  await f.db.run('UPDATE instances SET webhook_url=$1 WHERE id=$2',['https://receiver.example.test/hook',id]);
  socket.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'media-in',remoteJid:'5511888888888@s.whatsapp.net'},message:{imageMessage:{caption:'synthetic attachment',mimetype:'image/png'}},messageTimestamp:Math.floor(Date.now()/1000)}]});await f.transport.idle();
  assert.equal(attempts,3);assert.equal(delivered.length,1);assert.ok(delivered[0].data.media.includes('/instance'+id+'/media/'));assert.ok(!delivered[0].data.media.includes('synthetic-token'));
  assert.equal((await f.db.get('SELECT count(*) AS n FROM media')).n,0);assert.equal((await f.db.get('SELECT count(*) AS n FROM media_objects')).n,0);
});
test('cached contacts/chats and non-queued operations still require an active authenticated owner',async t=>{
  const f=await fixture(t),socket=await f.open(),id=f.ids[0];socket.onWhatsApp=async jid=>[{exists:true,jid}];socket.profilePictureUrl=async()=>'';socket.readMessages=async()=>{};
  socket.ev.emit('contacts.upsert',[{id:'5511888888888@s.whatsapp.net',name:'Synthetic contact'}]);socket.ev.emit('chats.upsert',[{id:'5511888888888@s.whatsapp.net',name:'Synthetic chat'}]);await f.transport.idle();
  assert.equal((await f.transport.operation(id,'contacts','GET',{}))[0].name,'Synthetic contact');assert.equal((await f.transport.operation(id,'contacts/check','GET',{chatId:'5511888888888'})).status,'valid');assert.equal((await f.transport.me(id)).number,'5511000000000');
  await f.db.run('UPDATE users SET active=0 WHERE id=$1',[f.user.id]);await assert.rejects(f.transport.operation(id,'contacts','GET',{}),e=>e.code==='owner_disabled');
  socket.config.auth.creds.registered=true;await f.transport.disconnect(id);assert.equal(socket.logoutCalls,1);
});

test('direct sends use WhatsApp canonical phone JID, preserve requested recipient and cache per connection',async t=>{
 let clock=Date.now();const f=await fixture(t,{now:()=>clock}),socket=await f.open();let lookups=0;
 socket.onWhatsApp=async()=>{lookups++;return [{exists:true,jid:'551188888888@s.whatsapp.net'}];};
 for(const id of ['canonical1','canonical2'])await f.message(id,{recipient:'5511988888888'});
 await f.transport.flush(f.ids[0]);await f.transport.idle();assert.equal(lookups,1);assert.equal(socket.sends.length,2);assert.ok(socket.sends.every(s=>s.jid==='551188888888@s.whatsapp.net'));
 assert.equal((await f.db.get("SELECT recipient FROM messages WHERE id='canonical1'")).recipient,'5511988888888');
 clock+=300001;await f.message('canonical3',{recipient:'5511988888888'});await f.transport.flush(f.ids[0]);assert.equal(lookups,2);
 await f.transport.restart(f.ids[0]);const next=f.sockets.at(-1);next.onWhatsApp=async()=>{lookups++;return [{exists:true,jid:'551188888888@s.whatsapp.net'}];};next.ev.emit('connection.update',{connection:'open'});await f.transport.idle();await f.message('canonical4',{recipient:'5511988888888'});await f.transport.flush(f.ids[0]);assert.equal(lookups,3);
});
test('unregistered or failed recipient lookup never sends and groups/LIDs bypass phone lookup',async t=>{
 const f=await fixture(t),socket=await f.open();let lookups=0;
 socket.onWhatsApp=async()=>{lookups++;return [];};await f.message('invalid-number');await f.transport.flush(f.ids[0]);assert.equal(socket.sends.length,0);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='invalid-number'")).status,'unsent');
 socket.onWhatsApp=async()=>{lookups++;throw Error('synthetic private failure');};await f.message('lookup-error');await f.transport.flush(f.ids[0]);assert.equal(socket.sends.length,0);assert.ok(!(await f.db.get("SELECT error FROM messages WHERE id='lookup-error'")).error.includes('synthetic private'));
 await f.message('group',{recipient:'12000000000@g.us'});await f.message('lid',{recipient:'1234567890@lid'});await f.transport.flush(f.ids[0]);assert.equal(lookups,2);assert.deepEqual(socket.sends.map(s=>s.jid),['12000000000@g.us','1234567890@lid']);
});
test('owner blocked during canonical address lookup cannot send a queued message',async t=>{
 const f=await fixture(t),socket=await f.open();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 socket.onWhatsApp=async()=>{entered();await gate;return [{exists:true,jid:'551188888888@s.whatsapp.net'}];};await f.message('lookup-race');const sending=f.transport.flush(f.ids[0]);await started;await f.db.run('UPDATE users SET active=0 WHERE id=$1',[f.user.id]);release();await sending;assert.equal(socket.sends.length,0);assert.equal((await f.db.get("SELECT status FROM messages WHERE id='lookup-race'")).status,'queue');
});
