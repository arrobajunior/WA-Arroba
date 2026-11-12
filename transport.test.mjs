import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './store.mjs';
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
 assert.deepEqual(calls[0].body.data,{id:'wamid1',from:'5511988887777@s.whatsapp.net',to:'5511999999999',fromMe:false,body:'Olá, tenho interesse',type:'chat',time:1700000000,pushname:'Cliente Teste'});
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
 assert.deepEqual(calls[1].body,{event_type:'message_ack',data:{id:'wamid2',ack:'device'}});
});

test('incoming audio is downloaded, hosted at the compatible /media route, included in the webhook and expires old entries',async t=>{
 const audioBytes=Buffer.from('fake-ogg-audio-bytes');
 const downloads=[];
 const mediaDownloader=async(msg,type,opts,ctx)=>{downloads.push({id:msg.key.id,reuploadRequest:ctx.reuploadRequest});return audioBytes;};
 const {store,transport,sockets}=await setup(t,{mediaBaseUrl:'https://wa.example.com',mediaDownloader});
 store.db.prepare('UPDATE instances SET webhook_url=? WHERE id=?').run('https://example.com/hook','abcd1234');
 const calls=[];const realFetch=globalThis.fetch;globalThis.fetch=async(url,opts)=>{calls.push(JSON.parse(opts.body));return {ok:true};};t.after(()=>{globalThis.fetch=realFetch;});
 transport.connect('abcd1234');const s=sockets[0];s.ev.emit('connection.update',{connection:'open'});await tick();
 s.ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'audio1',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{audioMessage:{ptt:true,mimetype:'audio/ogg; codecs=opus'}},messageTimestamp:1700000001,pushName:'Cliente'}]});
 await tick();
 assert.equal(downloads.length,1);assert.equal(downloads[0].id,'audio1');assert.equal(typeof downloads[0].reuploadRequest,'function');
 assert.equal(calls.length,1);
 const token=store.decrypt(store.db.prepare('SELECT token FROM instances WHERE id=?').get('abcd1234').token);
 assert.equal(calls[0].data.media,`https://wa.example.com/instanceabcd1234/media/audio1?token=${token}`);
 assert.equal(calls[0].data.type,'ptt');
 const stored=store.db.prepare("SELECT mimetype,data FROM media WHERE instance_id='abcd1234' AND message_id='audio1'").get();
 assert.equal(stored.mimetype,'audio/ogg; codecs=opus');assert.deepEqual(Buffer.from(stored.data),audioBytes);
 // An oversized download is not stored, and the webhook still fires but without a media URL.
 const bigDownloader=async()=>Buffer.alloc(21*1024*1024);
 const big=await setup(t,{mediaBaseUrl:'https://wa.example.com',mediaDownloader:bigDownloader});
 big.store.db.prepare('UPDATE instances SET webhook_url=? WHERE id=?').run('https://example.com/hook','abcd1234');
 globalThis.fetch=async(url,opts)=>{calls.push(JSON.parse(opts.body));return {ok:true};};
 big.transport.connect('abcd1234');big.sockets[0].ev.emit('connection.update',{connection:'open'});await tick();
 big.sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[{key:{id:'audio2',remoteJid:'5511988887777@s.whatsapp.net',fromMe:false},message:{audioMessage:{ptt:true,mimetype:'audio/ogg'}},messageTimestamp:1700000002}]});
 await tick();
 assert.equal(calls.length,2);assert.equal(calls[1].data.media,undefined);
 assert.equal(big.store.db.prepare("SELECT count(*) AS n FROM media WHERE message_id='audio2'").get().n,0);
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

test('outgoing image/audio queue reads S3 and preserves WhatsApp payload types',async t=>{
 const bytes=Buffer.from('media bytes'),calls=[];
 const mediaStorage={get:async()=>bytes,url:async key=>`https://private.example/${key}?signed=yes`};
 const {store,transport,sockets}=await setup(t,{mediaStorage});
 for(const [index,type,mime] of [[0,'image','image/png'],[1,'audio','audio/mpeg'],[2,'ptt','audio/ogg']]){
  const id=`out${index}`;store.db.prepare('INSERT INTO media_objects VALUES(?,?,?,?,?,?)').run('abcd1234',id,id,mime,bytes.length,'now');
  store.db.prepare('INSERT INTO messages(id,instance_id,recipient,body,type,status,ack,created_at,media_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'abcd1234','5511999999999','caption',type,'queue','pending',`${index}`,id);
 }
 transport.connect('abcd1234');sockets[0].sendMessage=async(jid,payload)=>{calls.push(payload);return {};};sockets[0].ev.emit('connection.update',{connection:'open'});
 for(let n=0;n<150&&calls.length<3;n++)await tick();
 assert.equal(calls.length,3);assert.deepEqual(calls[0].image,bytes);assert.equal(calls[0].caption,'caption');assert.deepEqual(calls[1].audio,bytes);assert.equal(calls[1].ptt,false);assert.equal(calls[2].ptt,true);
});

test('received and phone-sent attachments persist privately in S3 with signed webhook URLs',async t=>{
 const puts=[],payloads=[],bytes=Buffer.from('downloaded media');
 const storage={async put(key,data,mime){puts.push({key,data,mime});},url:async key=>`https://bucket.example/${key}?signed=yes`};
 const realFetch=globalThis.fetch;globalThis.fetch=async(url,options)=>{payloads.push(JSON.parse(options.body));return {ok:true};};t.after(()=>{globalThis.fetch=realFetch;});
 const {store,transport,sockets}=await setup(t,{mediaStorage:storage,mediaDownloader:async()=>bytes});
 store.db.prepare('UPDATE instances SET webhook_url=?').run('https://example.com/hook');transport.connect('abcd1234');sockets[0].ev.emit('connection.update',{connection:'open'});
 for(const [id,fromMe,message] of [['received',false,{audioMessage:{mimetype:'audio/ogg',ptt:true}}],['sent',true,{imageMessage:{mimetype:'image/jpeg',caption:'Foto'}}]]){
  sockets[0].ev.emit('messages.upsert',{type:'notify',messages:[{key:{id,fromMe,remoteJid:'5511988887777@s.whatsapp.net'},message,messageTimestamp:1700000000}]});
 }
 for(let n=0;n<50&&payloads.length<2;n++)await tick();
 assert.equal(puts.length,2);assert.ok(puts[0].key.includes('/in/'));assert.ok(puts[1].key.includes('/out/'));assert.equal(payloads[1].event_type,'message_create');assert.ok(payloads.every(p=>p.data.media.includes('signed=yes')&&!p.data.media.includes('token=')));
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM media_objects').get().n,2);assert.equal(store.db.prepare('SELECT count(*) AS n FROM media').get().n,0);
});
