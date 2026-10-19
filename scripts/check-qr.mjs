// Explicit live smoke test: requests a fresh, unpaired QR and closes its own connection.
// Does not authenticate a phone, send a message, or reuse production data.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {openStore} from '../store.mjs';
import {createTransport} from '../transport.mjs';
const dir=await mkdtemp(path.join(tmpdir(),'whatsapp-qr-check-'));
const store=openStore(dir),transport=createTransport(store);
try{
 store.db.prepare('INSERT INTO instances(id,name,token,created_at,updated_at) VALUES(?,?,?,?,?)').run('abcd1234','Temporary QR verification',store.encrypt('not-used'),'now','now');
 transport.connect('abcd1234');let succeeded=false;
 for(let i=0;i<225;i++){await sleep(200);const state=transport.state('abcd1234');if(state.qr){console.log(JSON.stringify({qr_received:true,status:state.status,paired:false,messages_sent:0}));succeeded=true;break;}if(state.error){console.log(JSON.stringify({qr_received:false,status:state.status,error:state.error}));break;}}
 if(!succeeded){console.error('Não foi recebido QR dentro da janela de 45 segundos.');process.exitCode=1;}
}finally{await transport.close();store.close();await rm(dir,{recursive:true,force:true});}
