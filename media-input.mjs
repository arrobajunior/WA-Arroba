import Busboy from 'busboy';
import {fileTypeFromBuffer} from 'file-type';
import sharp from 'sharp';
import {MAX_MEDIA_BYTES} from './media-relay.mjs';
import {fetchRemoteMedia} from './remote-media.mjs';
const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'invalid_media'});
export async function multipart(req){
 return new Promise((resolve,reject)=>{
  let parser;try{parser=Busboy({headers:req.headers,limits:{fileSize:MAX_MEDIA_BYTES,files:1,fields:8,fieldSize:4096,parts:9}});}catch{reject(invalid('Formulário multipart inválido.'));return;}
  const fields={},chunks=[];let file,error;
  parser.on('field',(name,value,info)=>{if(info.valueTruncated||Object.hasOwn(fields,name))error=invalid('Campo inválido.');fields[name]=value;});
  parser.on('file',(name,stream,info)=>{if(!['file','image','audio','video','document'].includes(name))error=invalid('Use file, image ou audio para o arquivo.');file={filename:info.filename};stream.on('limit',()=>{error=invalid('Limite de 20 MB por arquivo.',413);});stream.on('data',chunk=>chunks.push(chunk));});
  for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>{error=invalid('Limite de campos/arquivos excedido.');});
  parser.on('error',()=>reject(invalid('Formulário multipart inválido.')));req.on('aborted',()=>reject(invalid('Upload interrompido.')));
  parser.on('close',()=>error?reject(error):resolve({...fields,...(file?{_file:Buffer.concat(chunks),filename:fields.filename||file.filename}:{})}));req.pipe(parser);
 });
}
export async function mediaInput(input,type,{fetchMedia=fetchRemoteMedia}={}){
 const field=type==='voice'?'audio':type,maxBytes=(type==='video'?32:type==='document'?30:16)*1024*1024;
 let bytes=input._file;
 if(!bytes){
  let value=input[field]??input.base64;if(typeof value!=='string')throw invalid('Informe '+field+'.');
  if(/^https?:\/\//i.test(value))bytes=await fetchMedia(value,maxBytes);
  else{
   if(value.startsWith('data:'))value=value.replace(/^data:[^,]*;base64,/,'');
   if(value.length>10000000)throw invalid('Base64 excede 10.000.000 caracteres.',413);
   if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw invalid('Base64 inválido.');bytes=Buffer.from(value,'base64');
  }
 }
 if(!bytes.length||bytes.length>maxBytes)throw invalid('Arquivo excede o limite.',413);
 let format;try{format=await fileTypeFromBuffer(bytes);}catch{if(type!=='document')throw invalid('Arquivo inválido.');}
 const mime=format?.mime.split(';')[0];
 const allowed=type==='image'?['image/jpeg','image/png','image/webp','image/gif','image/bmp']:type==='video'?['video/mp4','video/3gpp','video/quicktime']:['audio/mpeg','audio/ogg','audio/wav','audio/x-wav','audio/flac','audio/mp4','audio/x-m4a','audio/aac'];
 if(type!=='document'&&(!format||!allowed.includes(mime)))throw invalid('Formato de '+type+' inválido.');
 if(type==='image'&&mime!=='image/bmp')try{await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{throw invalid('Imagem inválida ou grande demais.');}
 const ptt=type==='voice'||input.ptt===true||input.ptt==='true';
 if(ptt&&(mime!=='audio/ogg'||!bytes.includes(Buffer.from('OpusHead'))))throw invalid('Mensagem de voz requer OGG/Opus.');
 if(type==='document'&&(typeof input.filename!=='string'||!input.filename.trim()||input.filename.length>255||/[\r\n\/\\]/.test(input.filename)))throw invalid('filename é obrigatório (até 255 caracteres, sem caminho).');
 return {bytes,mimetype:mime==='audio/x-m4a'?'audio/mp4':format?.mime||'application/octet-stream',ptt,filename:input.filename||''};
}
