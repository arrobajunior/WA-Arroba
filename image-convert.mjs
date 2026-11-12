import {spawn} from 'node:child_process';
export function bmpToPng(bytes){
 if(bytes.length<54||bytes.readUInt32LE(14)<40)throw new Error('BMP inválido.');
 const width=Math.abs(bytes.readInt32LE(18)),height=Math.abs(bytes.readInt32LE(22));
 if(!width||!height||width*height>40000000)throw new Error('BMP grande demais.');
 return new Promise((resolve,reject)=>{
  const process=spawn('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{stdio:['pipe','pipe','ignore']});
  const chunks=[];let size=0,finished=false;
  const done=(error,bytes)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(bytes);};
  const timer=setTimeout(()=>{process.kill('SIGKILL');done(new Error('Conversão de BMP expirou.'));},15000);
  process.stdout.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){process.kill('SIGKILL');done(new Error('Imagem convertida excede 16 MB.'));}else chunks.push(chunk);});
  process.on('error',()=>done(new Error('Conversor de imagem indisponível.')));process.stdin.on('error',()=>{});
  process.on('close',code=>code===0&&size?done(null,Buffer.concat(chunks)):done(new Error('Não foi possível converter o BMP.')));process.stdin.end(bytes);
 });
}
