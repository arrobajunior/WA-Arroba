import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
const slots=['positive','negative','favicon'];
const invalid=message=>Object.assign(new Error(message),{status:400,code:'invalid_branding'});
export function createPostgresBranding(db){
  const read=()=>db.transaction(async tx=>{
    const row=await tx.get('SELECT name FROM branding WHERE id=1'),assets=await tx.all('SELECT slot,revision FROM brand_assets');
    return {name:row.name,...Object.fromEntries(slots.map(slot=>{const asset=assets.find(r=>r.slot===slot);return [slot,asset?`/brand-assets/${slot}.png?v=${asset.revision}`:null];}))};
  },{readOnly:true,isolation:'REPEATABLE READ'});
  async function update(input){
    if(Object.keys(input).some(key=>!['name',...slots].includes(key)))throw invalid('Campo não reconhecido.');
    if(input.name!==undefined&&(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>60))throw invalid('Use um nome de até 60 caracteres.');
    const prepared=[];
    for(const slot of slots){
      if(input[slot]===undefined)continue;
      if(input[slot]===null){prepared.push([slot,null]);continue;}
      const data=input[slot];
      if(typeof data!=='string'||data.length>1400000||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data))throw invalid('Envie imagens PNG, JPG ou WebP de até 1 MB.');
      const bytes=Buffer.from(data.split(',')[1],'base64');
      if(bytes.length>1024*1024)throw invalid('Cada imagem pode ter até 1 MB.');
      try{
        const source=sharp(bytes,{limitInputPixels:16000000,failOn:'warning'});
        const meta=await source.metadata();
        if(!['png','jpeg','webp'].includes(meta.format)||meta.pages>1)throw new Error('Formato inválido.');
        // Decode and re-encode raster pixels: uploaded metadata or executable markup is never served.
        const size=slot==='favicon'?256:1600;
        prepared.push([slot,await source.rotate().resize({width:size,height:size,fit:'inside',withoutEnlargement:true}).png().toBuffer()]);
      }catch{throw invalid('Imagem inválida. Use um PNG, JPG ou WebP estático de até 16 megapixels.');}
    }
    await db.transaction(async tx=>{
      if(input.name!==undefined)await tx.run('UPDATE branding SET name=$1 WHERE id=1',[input.name.trim()]);
      for(const [slot,data] of prepared){
        if(data===null)await tx.run('DELETE FROM brand_assets WHERE slot=$1',[slot]);
        else await tx.run('INSERT INTO brand_assets(slot,data,revision) VALUES($1,$2,$3) ON CONFLICT(slot) DO UPDATE SET data=EXCLUDED.data,revision=EXCLUDED.revision',[slot,data,randomBytes(8).toString('hex')]);
      }
    });
    return read();
  }
  return {read,update,asset:async slot=>(await db.get('SELECT data FROM brand_assets WHERE slot=$1',[slot]))?.data};
}
