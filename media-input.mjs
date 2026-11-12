import Busboy from 'busboy';
import {fileTypeFromBuffer} from 'file-type';
import sharp from 'sharp';
import {MAX_MEDIA_BYTES} from './media-storage.mjs';
const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'invalid_media'});
export async function multipart(req){
 return new Promise((resolve,reject)=>{
  let parser;try{parser=Busboy({headers:req.headers,limits:{fileSize:MAX_MEDIA_BYTES,files:1,fields:8,fieldSize:4096,parts:9}});}catch{reject(invalid('Formulário multipart inválido.'));return;}
  const fields={},chunks=[];let file,error;
  parser.on('field',(name,value,info)=>{if(info.valueTruncated||Object.hasOwn(fields,name))error=invalid('Campo inválido.');fields[name]=value;});
  parser.on('file',(name,stream,info)=>{if(!['file','image','audio'].includes(name))error=invalid('Use file, image ou audio para o arquivo.');file={filename:info.filename};stream.on('limit',()=>{error=invalid('Limite de 20 MB por arquivo.',413);});stream.on('data',chunk=>chunks.push(chunk));});
  for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>{error=invalid('Limite de campos/arquivos excedido.');});
  parser.on('error',()=>reject(invalid('Formulário multipart inválido.')));req.on('aborted',()=>reject(invalid('Upload interrompido.')));
  parser.on('close',()=>error?reject(error):resolve({...fields,...(file?{_file:Buffer.concat(chunks)}:{})}));req.pipe(parser);
 });
}
export async function mediaInput(input,type){
 let bytes=input._file;
 if(!bytes){let value=input[type]??input.base64;if(typeof value!=='string')throw invalid('Envie arquivo multipart ou base64.');if(value.startsWith('data:'))value=value.replace(/^data:[^,]*;base64,/,'');if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw invalid('Base64 inválido. URLs não são aceitas.');bytes=Buffer.from(value,'base64');}
 if(!bytes.length||bytes.length>MAX_MEDIA_BYTES)throw invalid('Limite de 20 MB por arquivo.',413);
 let format;try{format=await fileTypeFromBuffer(bytes);}catch{throw invalid('Arquivo inválido.');}
 const allowed=type==='image'?['image/jpeg','image/png','image/webp']:['audio/mpeg','audio/ogg','audio/wav','audio/x-wav','audio/flac','audio/mp4','audio/x-m4a','audio/aac'];
 const mime=format?.mime.split(';')[0];
 if(!format||!allowed.includes(mime))throw invalid(type==='image'?'Use JPEG, PNG ou WebP.':'Use MP3, OGG, WAV, FLAC, M4A ou AAC.');
 if(type==='image')try{await sharp(bytes,{limitInputPixels:40000000}).metadata();}catch{throw invalid('Imagem inválida ou grande demais.');}
 const ptt=input.ptt===true||input.ptt==='true';if(input.ptt!==undefined&&![true,false,'true','false'].includes(input.ptt))throw invalid('ptt deve ser true ou false.');
 if(ptt&&(mime!=='audio/ogg'||!bytes.includes(Buffer.from('OpusHead'))))throw invalid('Mensagem de voz (ptt) requer OGG/Opus.');
 return {bytes,mimetype:mime==='audio/x-m4a'?'audio/mp4':format.mime,ptt};
}
