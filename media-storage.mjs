import {S3Client,PutObjectCommand,GetObjectCommand,HeadBucketCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

export const MAX_MEDIA_BYTES=20*1024*1024;
export function createMediaStorage(env=process.env,{client,sign=getSignedUrl}={}){
 const names=['S3_ENDPOINT','S3_BUCKET','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'];
 if(!client&&!names.some(k=>env[k]))return null;
 if(names.some(k=>!env[k]))throw new Error('Configuração S3 incompleta: '+names.filter(k=>!env[k]).join(', '));
 const endpoint=new URL(env.S3_ENDPOINT);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw new Error('S3_ENDPOINT deve usar HTTPS sem credenciais na URL.');
 client??=new S3Client({endpoint:endpoint.href,region:env.S3_REGION,credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY},forcePathStyle:env.S3_FORCE_PATH_STYLE==='true',requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:3});
 const Bucket=env.S3_BUCKET;
 return {
  ready:()=>client.send(new HeadBucketCommand({Bucket})),
  async put(key,bytes,mimetype){if(!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw new Error('Mídia fora do limite de 20 MB.');await client.send(new PutObjectCommand({Bucket,Key:key,Body:bytes,ContentType:mimetype}));},
  async get(key){const result=await client.send(new GetObjectCommand({Bucket,Key:key}));if(result.ContentLength>MAX_MEDIA_BYTES){result.Body?.destroy?.();throw new Error('Mídia excede 20 MB.');}let size=0;const chunks=[];for await(const chunk of result.Body){size+=chunk.length;if(size>MAX_MEDIA_BYTES){result.Body.destroy?.();throw new Error('Mídia excede 20 MB.');}chunks.push(chunk);}return Buffer.concat(chunks);},
  url:key=>sign(client,new GetObjectCommand({Bucket,Key:key}),{expiresIn:3600}),
  close:()=>client.destroy?.()
 };
}
