import {randomBytes} from 'node:crypto';
// Ephemeral transport only: no filesystem, database or object-store writes.
export const MAX_MEDIA_BYTES=32*1024*1024;
export function createMediaRelay({ttl=3600000,maxBytes=128*1024*1024,now=Date.now}={}){
 const entries=new Map();let size=0;
 const remove=key=>{const e=entries.get(key);if(e){size-=e.bytes.length;entries.delete(key);}};
 const prune=()=>{for(const [key,e] of entries)if(e.expires<=now())remove(key);};
 const timer=setInterval(prune,60000);timer.unref();
 return {
  put(instance,bytes,mimetype,filename='file'){
   prune();if(!Buffer.isBuffer(bytes))bytes=Buffer.from(bytes);
   if(!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw Object.assign(new Error('Arquivo excede o limite.'),{status:413,code:'media_too_large'});
   if(size+bytes.length>maxBytes)throw Object.assign(new Error('Capacidade temporária de mídia esgotada. Tente novamente.'),{status:503,code:'relay_full'});
   const key=randomBytes(24).toString('hex');entries.set(key,{instance,bytes,mimetype,filename,expires:now()+ttl});size+=bytes.length;return key;
  },
  get(instance,key){prune();const entry=entries.get(key);return entry?.instance===instance?entry:null;},
  remove,close(){clearInterval(timer);entries.clear();size=0;},
  url:(base,instance,key)=>`${base}/instance${instance}/media/${key}`
 };
}
