import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createMediaRelay} from './media-relay.mjs';
import {fetchRemoteMedia,isPublicAddress} from './remote-media.mjs';
test('ephemeral media is instance-scoped, bounded and expires without persistence',()=>{
 let now=0;const relay=createMediaRelay({ttl:100,maxBytes:4,now:()=>now});
 try{const key=relay.put('one',Buffer.from('abc'),'text/plain','test.txt');assert.equal(relay.get('two',key),null);assert.equal(relay.get('one',key).filename,'test.txt');assert.throws(()=>relay.put('two',Buffer.from('de'),'text/plain'),/esgotada/);now=101;assert.equal(relay.get('one',key),null);assert.ok(relay.put('two',Buffer.from('abcd'),'text/plain'));}finally{relay.close();}
});
test('remote media pins public DNS and rejects private addresses, redirects and oversize bodies',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','::1','fc00::1','::ffff:127.0.0.1'])assert.equal(isPublicAddress(ip),false);
 assert.equal(isPublicAddress('8.8.8.8'),true);
 const resolve=async()=>[{address:'8.8.8.8',family:4}];let pinned;
 const request=(url,options,callback)=>{const req=new EventEmitter();req.end=()=>{options.lookup(url.hostname,{},(error,address)=>{pinned=address;});const res=Readable.from([Buffer.from('abc')]);res.statusCode=200;res.headers={};callback(res);};return req;};
 assert.equal((await fetchRemoteMedia('https://public.example/file',4,{resolve,request})).toString(),'abc');assert.equal(pinned,'8.8.8.8');
 await assert.rejects(()=>fetchRemoteMedia('http://private.example/file',4,{resolve:async()=>[{address:'127.0.0.1',family:4}],request}),/público/);
 await assert.rejects(()=>fetchRemoteMedia('https://public.example/file',2,{resolve,request}),/limite/);
 const redirect=(url,options,callback)=>{const req=new EventEmitter();req.end=()=>{const res=Readable.from([]);res.statusCode=302;res.headers={location:'http://internal.example/private'};callback(res);};return req;};
 await assert.rejects(()=>fetchRemoteMedia('https://public.example/file',4,{resolve:async host=>host==='internal.example'?[{address:'10.0.0.1',family:4}]:await resolve(),request:redirect}),/público/);
});
