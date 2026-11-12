import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
const bad=message=>Object.assign(new Error(message),{status:400,code:'invalid_media_url'});
export function isPublicAddress(address){try{const ip=ipaddr.process(address);return ip.range()==='unicast';}catch{return false;}}
export async function fetchRemoteMedia(value,maxBytes,{resolve=lookup,request}={}){
 let target;try{target=new URL(value);}catch{throw bad('URL de mídia inválida.');}
 for(let redirects=0;redirects<=3;redirects++){
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw bad('URL de mídia inválida.');
  const hostname=target.hostname.replace(/^\[|\]$/g,'');const addresses=await resolve(hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!isPublicAddress(a.address)))throw bad('URL de mídia deve apontar para um endereço público.');
  const chosen=addresses[0];
  const response=await new Promise((resolve,reject)=>{
   const run=request||(target.protocol==='https:'?https.request:http.request);
   const req=run(target,{method:'GET',headers:{Accept:'*/*'},lookup:(host,options,cb)=>options?.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family),signal:AbortSignal.timeout(20000)},res=>resolve(res));req.on('error',reject);req.end();
  });
  if([301,302,303,307,308].includes(response.statusCode)){
   response.resume();if(!response.headers.location||redirects===3)throw bad('Redirecionamento de mídia inválido.');target=new URL(response.headers.location,target);continue;
  }
  if(response.statusCode!==200){response.resume();throw bad('Não foi possível baixar a mídia.');}
  if(Number(response.headers['content-length'])>maxBytes){response.destroy();throw bad('Arquivo excede o limite.');}
  const chunks=[];let size=0;for await(const chunk of response){size+=chunk.length;if(size>maxBytes){response.destroy();throw bad('Arquivo excede o limite.');}chunks.push(chunk);}
  return Buffer.concat(chunks);
 }
}
