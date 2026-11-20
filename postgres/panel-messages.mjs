import {fail,text} from './validation.mjs';

export function createPostgresPanelMessages({db,relay,baseUrl,legacy=()=>null}){
  return async function list(id,p){
    const status=p.get('status')==='all'?'':p.get('status')||'',query=p.get('query')||'';text(query,'busca',4096,false);
    if(status&&!['invalid','queue','sent','sending','unsent','unknown','received','expired'].includes(status))throw fail(400,'invalid_status','Status inválido.');
    const page=Number(p.get('page')||1),limit=Number(p.get('limit')||100),sort=p.get('sort')||'desc';
    if(!Number.isSafeInteger(page)||page<1||!Number.isInteger(limit)||limit<1||limit>100||!['asc','desc'].includes(sort)||!Number.isSafeInteger((page-1)*limit))throw fail(400,'invalid_pagination','Paginação inválida.');
    const where="m.instance_id=$1 AND ($2='' OR m.status=$2) AND ($3='' OR strpos(m.body,$3)>0 OR strpos(m.recipient,$3)>0)";
    const data=await db.transaction(async tx=>{
      const rows=await tx.all(`SELECT m.id,m.recipient AS "to",m.body,m.type,m.status,m.ack,m.created_at,m.error,m.media_id,m.provider_id,m.reference_id,m.filename,o.object_key,o.mimetype FROM messages m LEFT JOIN media_objects o ON o.instance_id=m.instance_id AND o.message_id=COALESCE(NULLIF(m.media_id,''),m.provider_id) WHERE ${where} ORDER BY m.created_at ${sort==='asc'?'ASC':'DESC'},m.id ${sort==='asc'?'ASC':'DESC'} LIMIT $4 OFFSET $5`,[id,status,query,limit,(page-1)*limit]);
      const total=(await tx.get(`SELECT count(*) AS n FROM messages m WHERE ${where}`,[id,status,query])).n;return {rows,total};
    },{readOnly:true,isolation:'REPEATABLE READ'});
    const messages=[];
    for(const row of data.rows){
      const {media_id,provider_id,reference_id,object_key,mimetype,...item}=row,entry=relay?.get(id,media_id);
      if(entry)item.media=relay.url(baseUrl,id,media_id);
      // Preserve the panel's existing epoch field; API integration uses the true sent_at separately.
      messages.push({...item,referenceId:reference_id,sent_at:Math.floor(Date.parse(row.created_at)/1000),...(object_key&&legacy()?{media:await legacy().url(object_key),mimetype}:{})});
    }
    return {messages,total:data.total,limit,page};
  };
}
