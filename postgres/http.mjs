export const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
export async function body(req,max=65536){
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>max)throw Object.assign(new Error('Corpo muito grande.'),{status:413,code:'body_too_large'});chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');if(!raw)return {};
  const type=(req.headers['content-type']||'').split(';')[0];let value;
  if(type==='application/x-www-form-urlencoded')value=Object.fromEntries(new URLSearchParams(raw));
  else if(type==='application/json'){try{value=JSON.parse(raw);}catch{throw Object.assign(new Error('JSON inválido.'),{status:400,code:'invalid_json'});}}
  else throw Object.assign(new Error('Use JSON ou formulário.'),{status:415,code:'unsupported_type'});
  if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('Envie um objeto.'),{status:400,code:'invalid_body'});return value;
}
