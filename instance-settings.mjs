export const defaultSettings={sendDelay:1,sendDelayMax:15,webhook_message_received:true,webhook_message_create:true,webhook_message_ack:true,webhook_message_download_media:true};
export function readSettings(row){let saved={};try{saved=JSON.parse(row.settings||'{}');}catch{}return {...defaultSettings,...saved,webhook_url:row.webhook_url||''};}
export function parseSettings(input,row){
 const settings=readSettings(row);
 for(const key of Object.keys(defaultSettings))if(input[key]!==undefined){
  if(key.startsWith('webhook_')){if(![true,false,'true','false','on','off','1','0',1,0].includes(input[key]))throw Object.assign(new Error(`Campo ${key} inválido.`),{status:400,code:'invalid_field'});settings[key]=[true,'true','on','1',1].includes(input[key]);}
  else{const n=Number(input[key]);if(!Number.isFinite(n)||n<0||n>3600)throw Object.assign(new Error(`Campo ${key} inválido.`),{status:400,code:'invalid_field'});settings[key]=n;}
 }
 return settings;
}
export const publicJid=value=>{if(!value)return '';const v=value.replace(/:\d+(?=@)/,'').replace('@s.whatsapp.net','@c.us');return v.includes('@')?v:`${v.replace(/^\+/,'')}@c.us`;};
export const whatsappJid=value=>publicJid(value).replace('@c.us','@s.whatsapp.net');
export const webhookId=(jid,id,fromMe=false)=>`${fromMe?'true':'false'}_${publicJid(jid)}_${id}`;
