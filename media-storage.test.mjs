import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createMediaStorage,MAX_MEDIA_BYTES} from './media-storage.mjs';
const env={S3_ENDPOINT:'https://s3.example.com',S3_REGION:'auto',S3_BUCKET:'private-bucket',S3_ACCESS_KEY_ID:'test',S3_SECRET_ACCESS_KEY:'test'};
test('S3 adapter stores private objects, downloads bytes and signs expiring GET URLs',async()=>{
 const commands=[];const client={send:async command=>{commands.push(command);return command.constructor.name==='GetObjectCommand'?{ContentLength:3,Body:Readable.from([Buffer.from('abc')])}:{};}};
 const storage=createMediaStorage(env,{client,sign:async(c,command,options)=>{assert.equal(options.expiresIn,3600);assert.equal(command.input.Bucket,'private-bucket');return 'https://signed.example/file';}});
 await storage.ready();await storage.put('instances/id/out/one',Buffer.from('abc'),'audio/ogg');assert.deepEqual(await storage.get('instances/id/out/one'),Buffer.from('abc'));assert.equal(await storage.url('instances/id/out/one'),'https://signed.example/file');assert.equal(commands[1].input.ACL,undefined);assert.equal(commands[1].input.ContentType,'audio/ogg');
 await assert.rejects(()=>storage.put('large',Buffer.alloc(MAX_MEDIA_BYTES+1),'image/png'));
 assert.equal(createMediaStorage({}),null);assert.throws(()=>createMediaStorage({S3_BUCKET:'missing'}),/incompleta/);
});
