import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from './store.mjs';
import {createTransport} from './transport.mjs';
async function setup(t){const dir=await mkdtemp(path.join(tmpdir(),'wa-transport-test-'));const store=openStore(dir),sockets=[];store.db.prepare('INSERT INTO users(id,name,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)').run('owner','Owner','owner@example.com','unused','user','now');store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES(?,?,?,?,?)').run('abcd1234','test',store.encrypt('token'),'now','now');store.db.prepare('UPDATE instances SET owner_id=?').run('owner');const transport=createTransport(store,{socketFactory:config=>{const s={ev:new EventEmitter(),user:{id:'5511999999999:1@s.whatsapp.net'},config,end(){},logout:async()=>{},sendMessage:async()=>({})};sockets.push(s);return s;},retryDelay:5});t.after(async()=>{await transport.close();store.close();await rm(dir,{recursive:true,force:true});});return {store,transport,sockets,dir};}
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
