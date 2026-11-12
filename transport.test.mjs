import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './store.mjs';
import {createMediaRelay} from './media-relay.mjs';
import {createTransport} from './transport.mjs';
async function setup(t,extra={}){const dir=await mkdtemp(path.join(tmpdir(),'wa-transport-test-'));const store=openStore(dir),sockets=[];store.db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('owner','Owner','owner@example.com','unused','user','now');store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES(?,?,?,?,?)').run('abcd1234','test',store.encrypt('token'),'now','now');store.db.prepare('UPDATE instances SET owner_id=?').run('owner');const transport=createTransport(store,{socketFactory:config=>{const s={ev:new EventEmitter(),user:{id:'5511999999999:1@s.whatsapp.net'},config,end(){},logout:async()=>{},sendMessage:async()=>({}),updateMediaMessage:async()=>{}};sockets.push(s);return s;},retryDelay:5,...extra});t.after(async()=>{await transport.close();store.close();await rm(dir,{recursive:true,force:true});});return {store,transport,sockets,dir};}
const tick=()=>new Promise(r=>setTimeout(r,20));
test('QR lifecycle persists encrypted authentication, ignores stale events and handles logout',async t=>{
 const {store,transport,sockets,dir}=await setup(t);transport.connect('abcd1234');const first=sockets[0];first.ev.emit('connection.update',{qr:'test-qr'});assert.equal(transport.state('abcd1234').qr,'test-qr');transport.connect('abcd1234');assert.equal(sockets.length,1);
 first.config.auth.creds.testSecret='sensitive-test-secret';first.ev.emit('creds.update',{});await first.config.auth.keys.set({test:{one:Buffer.from('private-key')}});
 const stored=store.db.prepare('SELECT value FROM wa_keys').all();assert.ok(stored.every(r=>!r.value.includes('sensitive-test-secret')));assert.equal((await readFile(path.join(dir,'platform.sqlite-wal'))).includes(Buffer.from('sensitive-test-secret')),false);
 first.ev.emit('connection.update',{connection:'open'});assert.equal(transport.state('abcd1234').status,'authenticated');
 await transport.disconnect('abcd1234');assert.equal(transport.state('abcd1234').status,'disconnected');assert.equal(store.db.prepare('SELECT count(*) AS n FROM wa_keys').get().n,0);
 first.ev.emit('connection.update',{connection:'open',qr:'stale'});assert.equal(transport.state('abcd1234').qr,null);
 transport.connect('abcd1234');assert.equal(sockets.length,2);
});
test('queue drains once, ACK is preserved and uncertain sends are not automatically repeated',async t=>{
 const {store,transport,sockets}=await setup(t);transport.connect('abcd1234');const s=sockets[0];let calls=0;
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('m1','abcd1234','5511999999999','hello','chat','queue','pending','now');
 s.sendMessage=async(jid,payload,options)=>{calls++;assert.equal(jid,'5511999999999@s.whatsapp.net');s.ev.emit('messages.update',[{key:{id:options.messageId},update:{status:3}}]);return {};};
 s.ev.emit('connection.update',{connection:'open'});transport.flush('abcd1234');transport.flush('abcd1234');await tick();assert.equal(calls,1);assert.equal(store.db.prepare('SELECT ack FROM messages WHERE id=?').get('m1').ack,'device');
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('m2','abcd1234','5511999999999','uncertain','chat','queue','pending','later');s.sendMessage=async()=>{calls++;throw new Error('timeout');};
 await new Promise(r=>setTimeout(r,1100));assert.equal(store.db.prepare('SELECT status FROM messages WHERE id=?').get('m2').status,'unknown');transport.flush('abcd1234');await tick();assert.equal(calls,2);
});
test('authentication state survives process recreation and in-flight sends become unknown',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'wa-recovery-test-'));let store=openStore(dir);let socket;
 const factory=config=>{socket={config,ev:new EventEmitter(),end(){},logout:async()=>{}};return socket;};
 store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES(?,?,?,?,?)').run('abcd1234','test',store.encrypt('token'),'now','now');
 let transport=createTransport(store,{socketFactory:factory});transport.connect('abcd1234');socket.config.auth.creds.testSecret='retained-session';socket.ev.emit('creds.update',{});
 await socket.config.auth.keys.set({test:{one:Buffer.from('retained-key')}});
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('m1','abcd1234','5511999999999','hello','chat','sending','pending','now');
 await transport.close();store.close();store=openStore(dir);transport=createTransport(store,{socketFactory:factory});
 t.after(async()=>{await transport.close();store.close();await rm(dir,{recursive:true,force:true});});
 transport.restore();assert.equal(socket.config.auth.creds.testSecret,'retained-session');assert.equal((await socket.config.auth.keys.get('test',['one'])).one.toString(),'retained-key');
 assert.equal(store.db.prepare('SELECT status FROM messages').get().status,'unknown');
});

test('blocked owners keep pending messages without sending, then resume when reactivated',async t=>{
 const {store,transport,sockets}=await setup(t);transport.connect('abcd1234');const socket=sockets[0];let calls=0;
 socket.sendMessage=async()=>{calls++;};
 store.db.prepare("INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES('blocked','abcd1234','5511999999999','pending','chat','queue','pending','now')").run();
 store.db.prepare('UPDATE users SET active=0 WHERE id=?').run('owner');
 socket.ev.emit('connection.update',{connection:'open'});await tick();transport.flush('abcd1234');await tick();assert.equal(calls,0);
 assert.equal(store.db.prepare("SELECT status FROM messages WHERE id='blocked'").get().status,'queue');
 store.db.prepare('UPDATE users SET active=1 WHERE id=?').run('owner');transport.flush('abcd1234');await tick();assert.equal(calls,1);
});

test('incoming message triggers UltraMsg-shaped webhook, is stored once, and ACK updates are also delivered',async t=>{
 const {store,transport,sockets}=await setup(t);
 store.db.prepare('UPDATE instances SET webhook_url=? WHERE id=?').run('https://example.com/hook','abcd1234');
 const calls=[];const realFetch=globalThis.fetch;
 globalThis.fetch=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return {ok:true};};
 t.after(()=>{globalThis.fetch=realFetch;});
 transport.connect('abcd1234');const s=sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();
 s.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'wamid1',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{conversation:'Olá, tenho interesse'},messageTimestamp:1700000000,pushName:'Cliente Teste'}]});
 await tick();
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://example.com/hook');
 assert.equal(calls[0].body.event_type,'message_received');
 assert.equal(calls[0].body.data.id,'false_5511988887777@c.us_wamid1');assert.equal(calls[0].body.data.from,'5511988887777@c.us');assert.equal(calls[0].body.data.to,'5511999999999@c.us');assert.equal(calls[0].body.data.body,'Olá, tenho interesse');assert.deepEqual(calls[0].body.data.mentionedIds,[]);assert.equal(calls[0].body.data.media,'');
 const saved=store.db.prepare("SELECT direction,status,body FROM messages WHERE provider_id='wamid1'").get();
 assert.deepEqual({...saved},{direction:'in',status:'received',body:'Olá, tenho interesse'});
 // Replaying the same history event (type 'append', as on reconnect) must not re-deliver or duplicate it.
 s.ev.emit('messages.upsert',{type:'append',messages:[{key:{id:'wamid1',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{conversation:'Olá, tenho interesse'},messageTimestamp:1700000000,pushName:'Cliente Teste'}]});
 await tick();assert.equal(calls.length,1);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages').get().n,1);
 // ACK on an API-sent message is also forwarded to the webhook, with the string label UltraMsg clients expect.
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,provider_id) VALUES(?,?,?,?,?,?,?,?,?)').run('m-out','abcd1234','5511988887777','oi','chat','sending','pending','now','wamid2');
 s.ev.emit('messages.update',[{key:{id:'wamid2'},update:{status:3}}]);
 await tick();
 assert.equal(calls.length,2);
 assert.deepEqual(calls[1].body,{event_type:'message_ack',instanceId:'abcd1234',data:{id:'true_5511988887777@c.us_wamid2',ack:'device'}});
});

test('incoming audio is relayed temporarily without persistence or API token exposure',async t=>{
 const bytes=Buffer.from('fake-ogg-audio-bytes'),relay=createMediaRelay(),payloads=[];
 const {store,transport,sockets}=await setup(t,{mediaBaseUrl:'https://wa.example.com',mediaRelay:relay,mediaDownloader:async()=>bytes});
 store.db.prepare('UPDATE instances SET webhook_url=?').run('https://example.com/hook');
 const realFetch=globalThis.fetch;globalThis.fetch=async(url,opts)=>{payloads.push(JSON.parse(opts.body));return {ok:true};};t.after(()=>{globalThis.fetch=realFetch;});
 transport.connect('abcd1234');sockets[0].ev.emit('connection.update',{connection:'open'});
 sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'audio1',remoteJid:'5511988887777@s.whatsapp.net'},message:{audioMessage:{ptt:true,mimetype:'audio/ogg'}}}]});
 await tick();assert.equal(payloads.length,1);assert.equal(payloads[0].instanceId,'abcd1234');
 const url=new URL(payloads[0].data.media),key=url.pathname.split('/').pop();assert.equal(url.search,'');assert.deepEqual(relay.get('abcd1234',key).bytes,bytes);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_objects').get().n,0);
});

test('webhook delivery retries on transient failure before giving up',async t=>{
 const {store,transport,sockets}=await setup(t);
 store.db.prepare('UPDATE instances SET webhook_url=? WHERE id=?').run('https://example.com/hook','abcd1234');
 const realFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=realFetch;});
 // Fails twice (simulating a transient network blip), then succeeds — must not be lost.
 let attempts=0;
 globalThis.fetch=async()=>{attempts++;if(attempts<3)throw new Error('network blip');return {ok:true};};
 transport.connect('abcd1234');const s=sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();
 s.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'retry1',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{conversation:'oi'},messageTimestamp:1700000003}]});
 await new Promise(r=>setTimeout(r,3200));
 assert.equal(attempts,3);
 // Permanent failure (every attempt rejected) is logged, not silently retried forever.
 attempts=0;let gaveUp=false;
 const realError=console.error;console.error=(...args)=>{if(args.join(' ').includes('após 3 tentativas'))gaveUp=true;};
 globalThis.fetch=async()=>{attempts++;throw new Error('down');};
 s.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'retry2',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{conversation:'oi de novo'},messageTimestamp:1700000004}]});
 await new Promise(r=>setTimeout(r,3200));
 console.error=realError;
 assert.equal(attempts,3);assert.equal(gaveUp,true);
});

test('outgoing image, audio, voice, video and document payloads use ephemeral bytes only',async t=>{
 const bytes=Buffer.from('media bytes'),calls=[],relay=createMediaRelay();
 const {store,transport,sockets}=await setup(t,{mediaRelay:relay});
 const kinds=[['image','image/png'],['audio','audio/mpeg'],['ptt','audio/ogg'],['video','video/mp4'],['document','application/pdf']];
 for(const [index,[type,mime]] of kinds.entries()){
  const key=relay.put('abcd1234',bytes,mime,'file.pdf');
  store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,media_id,filename) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`out${index}`,'abcd1234','5511999999999','caption',type,'queue','pending',new Date(Date.now()+index).toISOString(),key,'file.pdf');
 }
 transport.connect('abcd1234');sockets[0].sendMessage=async(jid,payload)=>{calls.push(payload);return {};};sockets[0].ev.emit('connection.update',{connection:'open'});
 for(let n=0;n<260&&calls.length<5;n++)await tick();
 assert.equal(calls.length,5);assert.deepEqual(calls[0].image,bytes);assert.equal(calls[1].ptt,false);assert.equal(calls[2].ptt,true);assert.deepEqual(calls[3].video,bytes);assert.deepEqual(calls[4].document,bytes);assert.equal(calls[4].fileName,'file.pdf');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_objects').get().n,0);
});

test('webhook flags, group documents, compound IDs and mentions follow the UltraMsg contract',async t=>{
 const hooks=[],bytes=Buffer.from('%PDF group');let downloads=0;
 const {store,transport,sockets}=await setup(t,{mediaBaseUrl:'https://relay.example.com',mediaDownloader:async()=>{downloads++;return bytes;}});
 store.db.prepare('UPDATE instances SET webhook_url=?,settings=?').run('https://example.com/hook',JSON.stringify({webhook_message_received:false,webhook_message_ack:false,webhook_message_download_media:false}));
 const realFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{hooks.push(JSON.parse(options.body));return {ok:true};};t.after(()=>{globalThis.fetch=realFetch;});
 transport.connect('abcd1234');const socket=sockets[0];socket.ev.emit('connection.update',{connection:'open'});
 const make=id=>({key:{id,remoteJid:'12345-67890@g.us',participant:'5511888888888@s.whatsapp.net',fromMe:false},message:{documentWithCaptionMessage:{message:{documentMessage:{fileName:'report.pdf',caption:'Report',mimetype:'application/pdf'}}}},messageTimestamp:1700000000});
 socket.ev.emit('messages.upsert',{type:'notify',messages:[make('off')]});await tick();assert.equal(hooks.length,0);assert.equal(downloads,0);
 store.db.prepare('UPDATE instances SET settings=?').run(JSON.stringify({webhook_message_received:true,webhook_message_ack:true,webhook_message_download_media:true}));
 socket.ev.emit('messages.upsert',{type:'notify',messages:[make('on')]});await tick();assert.equal(hooks.length,1);assert.equal(downloads,1);
 const event=hooks[0];assert.equal(event.data.id,'false_12345-67890@g.us_on');assert.equal(event.data.author,'5511888888888@c.us');assert.equal(event.data.type,'document');assert.equal(event.data.body,'Report');assert.ok(event.data.media.startsWith('https://relay.example.com/instanceabcd1234/media/'));assert.equal(event.referenceId,'');
 socket.ev.emit('messages.upsert',{type:'notify',messages:[make('on')]});await tick();assert.equal(hooks.length,1);
});

test('contact, group and chat operations normalize JIDs and reject unsynchronized mutations',async t=>{
 const {transport,sockets}=await setup(t);await assert.rejects(()=>transport.operation('abcd1234','contacts','GET',{}),/não está conectado/);
 transport.connect('abcd1234');const s=sockets[0],actions=[];s.ev.emit('connection.update',{connection:'open'});
 s.ev.emit('contacts.upsert',[{id:'5511888888888@s.whatsapp.net',name:'Client'}]);s.ev.emit('chats.upsert',[{id:'5511888888888@s.whatsapp.net',name:'Client',unreadCount:2}]);
 s.onWhatsApp=async jid=>[{exists:!jid.startsWith('999'),jid}];s.updateBlockStatus=async(...args)=>actions.push(args);s.fetchBlocklist=async()=>['5511888888888@s.whatsapp.net'];
 s.groupFetchAllParticipating=async()=>({g:{id:'123-456@g.us',subject:'Team',participants:[{id:'5511888888888@s.whatsapp.net',admin:'admin'}]}});s.groupMetadata=async()=>({id:'123-456@g.us',subject:'Team',participants:[]});s.chatModify=async(...args)=>actions.push(args);s.readMessages=async keys=>actions.push(keys);s.sendMessage=async(jid,payload)=>actions.push({jid,payload});
 assert.deepEqual(await transport.operation('abcd1234','contacts/ids','GET',{}),['5511888888888@c.us']);
 assert.equal((await transport.operation('abcd1234','contacts/check','GET',{chatId:'9998887777'})).status,'invalid');assert.deepEqual(await transport.operation('abcd1234','contacts/invalid','GET',{}),['9998887777@c.us']);
 await transport.operation('abcd1234','contacts/block','POST',{chatId:'5511888888888@c.us'});assert.deepEqual(actions[0],['5511888888888@s.whatsapp.net','block']);
 assert.deepEqual(await transport.operation('abcd1234','groups/ids','GET',{}),['123-456@g.us']);assert.equal((await transport.operation('abcd1234','groups','GET',{}))[0].participants[0].isAdmin,true);
 await assert.rejects(()=>transport.operation('abcd1234','chats/archive','POST',{chatId:'5511888888888'}),/não sincronizada/);
 s.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'cached',remoteJid:'5511888888888@s.whatsapp.net',fromMe:false},message:{conversation:'hi'},messageTimestamp:1700000000}]});await tick();
 const messages=await transport.operation('abcd1234','chats/messages','GET',{chatId:'5511888888888',limit:1});assert.equal(messages[0].id,'false_5511888888888@c.us_cached');
 await transport.operation('abcd1234','chats/archive','POST',{chatId:'5511888888888'});assert.equal(actions.at(-1)[0].archive,true);assert.equal(actions.at(-1)[0].lastMessages[0].key.id,'cached');
 await transport.react('abcd1234',messages[0].id,'👍');assert.equal(actions.at(-1).payload.react.key.id,'cached');
 await transport.deleteMessage('abcd1234','true_5511888888888@c.us_outgoing');assert.equal(actions.at(-1).payload.delete.id,'outgoing');
});

test('URL media can be retried after memory loss and ACKs never downgrade',async t=>{
 const calls=[],bytes=Buffer.from('url image');
 const {store,transport,sockets}=await setup(t,{mediaLoader:async(input,kind)=>{assert.equal(kind,'image');assert.equal(input.image,'https://client.example/photo.png');return {bytes,mimetype:'image/png'};}});
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,source_url) VALUES(?,?,?,?,?,?,?,?,?)').run('urlmedia','abcd1234','5511888888888','caption','image','queue','pending',new Date().toISOString(),store.encrypt('https://client.example/photo.png'));
 transport.connect('abcd1234');const s=sockets[0];s.sendMessage=async(jid,payload,opts)=>{calls.push(payload);s.ev.emit('messages.update',[{key:{id:opts.messageId},update:{status:4}},{key:{id:opts.messageId},update:{status:2}}]);return {};};s.ev.emit('connection.update',{connection:'open'});await tick();
 assert.equal(calls.length,1);assert.deepEqual(calls[0].image,bytes);const m=store.db.prepare('SELECT status,ack,sent_at FROM messages WHERE id=?').get('urlmedia');assert.equal(m.status,'sent');assert.equal(m.ack,'read');assert.ok(m.sent_at>0);
});

test('instance reset clears its own state, preserves other instances and reopens QR connection',async t=>{
 const relay=createMediaRelay(),{store,transport,sockets}=await setup(t,{mediaRelay:relay});
 store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at,owner_id) VALUES(?,?,?,?,?,?)').run('eeeeffff','Other',store.encrypt('other'),'now','now','owner');
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('owned','abcd1234','5511888888888','body','chat','sent','device','now');
 store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at) VALUES(?,?,?,?,?,?,?,?)').run('other','eeeeffff','5511888888888','body','chat','sent','device','now');
 store.db.prepare('UPDATE instances SET webhook_url=?,settings=? WHERE id=?').run('https://example.com/hook','{"sendDelay":10}','abcd1234');
 const key=relay.put('abcd1234',Buffer.from('media'),'image/png');transport.connect('abcd1234');sockets[0].ev.emit('connection.update',{qr:'qr'});
 await transport.reset('abcd1234');assert.equal(sockets.length,2);assert.equal(transport.state('abcd1234').status,'initialize');assert.equal(relay.get('abcd1234',key),null);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages WHERE instance_id=?').get('abcd1234').n,0);assert.equal(store.db.prepare('SELECT count(*) AS n FROM messages WHERE instance_id=?').get('eeeeffff').n,1);assert.equal(store.db.prepare('SELECT webhook_url FROM instances WHERE id=?').get('abcd1234').webhook_url,'');
});
