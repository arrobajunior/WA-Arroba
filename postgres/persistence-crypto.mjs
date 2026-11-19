import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv,timingSafeEqual} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
export async function loadPersistenceCrypto({dataDir,keyBase64}={}){
  let fromEnvironment,fromFile;
  if(keyBase64!==undefined){
    if(typeof keyBase64!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(keyBase64))throw fail('INVALID_MASTER_KEY');
    fromEnvironment=Buffer.from(keyBase64,'base64');
    if(fromEnvironment.length!==32||fromEnvironment.toString('base64')!==keyBase64)throw fail('INVALID_MASTER_KEY');
  }
  if(dataDir){
    const filename=path.join(dataDir,'master.key');
    try{
      const info=await lstat(filename);
      if(!info.isFile()||(info.mode&0o077)!==0)throw fail('INSECURE_MASTER_KEY_FILE');
      fromFile=await readFile(filename);
    }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  const key=fromEnvironment||fromFile;if(!key)throw fail('MASTER_KEY_REQUIRED');
  if(key.length!==32)throw fail('INVALID_MASTER_KEY');
  if(fromFile&&fromEnvironment&&(fromFile.length!==32||!timingSafeEqual(fromFile,fromEnvironment)))throw fail('MASTER_KEY_MISMATCH');
  const encrypt=value=>{
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
  };
  const decrypt=value=>{
    try{
      const bytes=Buffer.from(value,'base64');if(bytes.length<28)throw new Error();
      const cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));
      return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8');
    }catch{throw fail('PERSISTENCE_DECRYPT_FAILED');}
  };
  // Original key is only in the closure. It is never returned, logged, regenerated or overwritten.
  return {encrypt,decrypt};
}
