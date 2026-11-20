import {sessionToken,publicUser} from '../auth.mjs';
import {createPostgresAccounts} from './accounts.mjs';
import {createPostgresInstances} from './instances.mjs';
import {createPostgresInstanceActivity} from './instance-activity.mjs';
import {createPostgresIncidentHistory} from './incident-history.mjs';
import {createPostgresBranding} from './branding.mjs';
import {fail,keys} from './validation.mjs';

import {body,json} from './http.mjs';
import QRCode from 'qrcode';
import {createPostgresPanelMessages} from './panel-messages.mjs';
import {createSerialTasks} from './serial-tasks.mjs';

// Preparatory router: not imported by server.mjs and never restores sessions on construction.
// Explicit connection commands require an injected transport. false means another module owns the route.
export async function createPostgresControlApi({store,origin,transport,state=transport?.state,alerts,relay,legacy=()=>null,now=Date.now,perOwnerLimit=50,onUserEnabled=async()=>{}}={}){
  let base;try{base=new URL(origin);}catch{throw new Error('INVALID_PUBLIC_ORIGIN');}
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('INVALID_PUBLIC_ORIGIN');
  const {db}=store,activity=createPostgresInstanceActivity(db,{now}),history=createPostgresIncidentHistory(db,{now}),branding=createPostgresBranding(db);
  const accounts=await createPostgresAccounts(db,{now}),instances=createPostgresInstances(store,{activity,state,now,perOwnerLimit,onDeactivate:async id=>{try{await alerts?.deactivate(id);}finally{await transport?.suspend(id);}}});
  const panelMessages=createPostgresPanelMessages({db,relay,baseUrl:base.origin,legacy}),actions=createSerialTasks();
  const cookie=(token,maxAge)=>`wa_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${base.protocol==='https:'?'; Secure':''}`;
  return async function handle(req,res){
    const path=(req.url||'/').split('?')[0],userMatch=path.match(/^\/api\/users\/([a-f0-9]{24})$/),instanceMatch=path.match(/^\/api\/instances\/([a-f0-9]{8})(?:\/(token|activity|credential-access|messages|qr|connect|disconnect|lifecycle))?$/),incidentMatch=path.match(/^\/api\/general-admin\/incidents\/(\d+)$/),assetMatch=path.match(/^\/brand-assets\/(positive|negative|favicon)\.png$/);
    const known=['/api/auth/login','/api/auth/me','/api/auth/logout','/api/users','/api/instances','/api/dashboard','/api/branding','/api/general-admin/activity','/api/general-admin/incidents'].includes(path)||(alerts&&['/api/general-admin','/api/general-admin/test-email'].includes(path))||userMatch||instanceMatch||incidentMatch||assetMatch;
    if(!known)return false;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    try{
      if(req.headers.host!==base.host)throw fail(403,'invalid_host','Host não permitido.');
      if(!['GET','POST','PATCH'].includes(req.method))throw fail(405,'method_not_allowed','Método não permitido.');
      if(['POST','PATCH'].includes(req.method)&&((req.headers.origin&&req.headers.origin!==base.origin)||req.headers['x-requested-with']!=='wa-platform'))throw fail(403,'csrf_rejected','Origem não permitida.');
      const url=new URL(req.url,base.origin),method=req.method;
      if(path==='/api/branding'&&method==='GET'){json(res,200,{branding:await branding.read()});return true;}
      if(assetMatch&&method==='GET'){
        const data=await branding.asset(assetMatch[1]);if(!data)throw fail(404,'not_found','Imagem não encontrada.');res.writeHead(200,{'Content-Type':'image/png'});res.end(data);return true;
      }
      const token=sessionToken(req);
      if(path==='/api/auth/login'&&method==='POST'){
        const result=await accounts.login(await body(req),{ip:req.socket.remoteAddress||'',previousToken:token});res.setHeader('Set-Cookie',cookie(result.token,result.maxAge));json(res,200,{user:result.user});return true;
      }
      const actor=await accounts.current(token);if(!actor)throw fail(401,'unauthorized','Faça login para continuar.');
      const metadata={peer_ip:req.socket.remoteAddress||''};
      if(path==='/api/auth/me'&&method==='GET'){json(res,200,{user:publicUser(actor)});return true;}
      if(path==='/api/auth/logout'&&method==='POST'){keys(await body(req),[]);await accounts.logout(token);res.setHeader('Set-Cookie',cookie('',0));json(res,200,{ok:true});return true;}
      if(path==='/api/users'){
        if(method==='GET'){json(res,200,{users:await accounts.list(actor)});return true;}
        if(method==='POST'){if(actor.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');json(res,201,{user:await accounts.create(actor,await body(req))});return true;}
      }
      if(userMatch&&method==='PATCH'){
        if(actor.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
        const result=await accounts.update(actor,userMatch[1],await body(req));
        // Callback is optional and supplied only when an async transport is ready. Persisted change is not retried.
        await onUserEnabled(result.resumeInstanceIds);json(res,200,{user:result.user});return true;
      }
      if(path==='/api/branding'&&method==='PATCH'){
        if(!actor.is_master)throw fail(403,'forbidden','Somente o Admin Master pode alterar a identidade visual.');json(res,200,{branding:await branding.update(await body(req,4500000))});return true;
      }
      if(alerts&&['/api/general-admin','/api/general-admin/test-email'].includes(path)){
        if(actor.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
        if(path==='/api/general-admin'&&method==='GET'){
          const data=await db.transaction(async tx=>({settings:await alerts.settings(),smtp_ready:alerts.mailReady(),audit:await tx.all('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 100'),incidents:await tx.all('SELECT c.*,c.instance_phone AS phone FROM connection_incidents c ORDER BY c.id DESC LIMIT 100')}),{readOnly:true,isolation:'REPEATABLE READ'});
          json(res,200,data);return true;
        }
        if(path==='/api/general-admin'&&method==='PATCH'){
          const input=await body(req);keys(input,['alert_email']);const before=await alerts.settings();
          const settings=await activity.run({instance:null,actor:activity.userActor(actor),action:'alert_email_updated',before:{alert_email:before.alert_email},source:'panel',peer_ip:metadata.peer_ip},()=>alerts.updateEmail(actor,input.alert_email),value=>({alert_email:value.alert_email}));
          json(res,200,{settings});return true;
        }
        if(path==='/api/general-admin/test-email'&&method==='POST'){
          keys(await body(req),[]);await activity.run({instance:null,actor:activity.userActor(actor),action:'alert_email_test',source:'panel',peer_ip:metadata.peer_ip},()=>alerts.sendTest(actor));json(res,200,{ok:true});return true;
        }
      }
      if(path==='/api/instances'&&method==='POST'){json(res,201,{instance:await instances.create(actor,await body(req),metadata)});return true;}
      if(['/api/instances','/api/dashboard'].includes(path)&&method==='GET'){json(res,200,await instances.list(actor,{filter:url.searchParams.get('state')||'active',dashboard:path==='/api/dashboard'}));return true;}
      if(instanceMatch){
        const [,id,action]=instanceMatch;
        if(!action&&method==='GET'){json(res,200,{instance:await instances.get(actor,id)});return true;}
        if(!action&&method==='PATCH'){json(res,200,{instance:await instances.patch(actor,id,await body(req),metadata)});return true;}
        if(action==='token'&&method==='POST'){json(res,200,{instance:await instances.rotate(actor,id,await body(req),metadata)});return true;}
        if(action==='activity'&&method==='GET'){await instances.authorized(actor,id);json(res,200,await activity.list(url.searchParams,id));return true;}
        if(action==='messages'&&method==='GET'){
          const {row,user}=await instances.authorized(actor,id);await activity.record({instance:row,actor:activity.userActor(user),action:'messages_viewed',outcome:'observed',source:'panel',peer_ip:metadata.peer_ip});json(res,200,await panelMessages(id,url.searchParams));return true;
        }
        if(transport&&action==='qr'&&method==='GET'){
          const {row}=await instances.authorized(actor,id);if(!row.active){json(res,200,{status:'disabled',error:null,qr:null});return true;}
          const status=transport.state(id);json(res,200,{status:status.status,error:status.error??null,qr:status.qr?await QRCode.toDataURL(status.qr,{width:280,margin:2}):null});return true;
        }
        if(transport&&['connect','disconnect','lifecycle'].includes(action)&&method==='POST'){
          const result=await actions.run(id,async()=>{
            const {row,user}=await instances.authorized(actor,id),input=await body(req);
            if(action==='lifecycle')return instances.lifecycle(user,id,input,metadata);
            keys(input,[]);if(!row.active)throw fail(409,'instance_disabled','Reative a instância antes de conectar.');
            await activity.run({instance:row,actor:activity.userActor(user),action:action==='connect'?'connection_requested':'disconnection_requested',source:'panel',peer_ip:metadata.peer_ip},async context=>{if(action==='connect')await transport.connect(id,0,context);else await transport.disconnect(id,context);});
            return instances.get(user,id);
          });json(res,action==='connect'?202:200,{instance:result});return true;
        }
        if(action==='credential-access'&&method==='POST'){
          const input=await body(req);keys(input,['action']);if(!['copy','reveal'].includes(input.action))throw fail(400,'invalid_field','Ação inválida.');
          const {row,user}=await instances.authorized(actor,id);await activity.record({instance:row,actor:activity.userActor(user),action:input.action==='copy'?'token_copy_requested':'token_reveal_requested',outcome:'requested',source:'panel',peer_ip:metadata.peer_ip});json(res,200,{ok:true});return true;
        }
      }
      if(path.startsWith('/api/general-admin/')){
        if(actor.role!=='admin')throw fail(403,'forbidden','Acesso administrativo necessário.');
        if(method==='GET'){
          if(path.endsWith('/activity'))json(res,200,await activity.list(url.searchParams));
          else if(incidentMatch)json(res,200,await history.detail(incidentMatch[1],url.searchParams));
          else json(res,200,await history.list(url.searchParams));
          return true;
        }
      }
      throw fail(405,'method_not_allowed','Método não permitido.');
    }catch(error){
      const clientError=Number.isInteger(error.status)&&((error.status>=400&&error.status<500)||(error.status===502&&['email_test_failed','logout_failed'].includes(error.code)));
      if(error.retryAfter)res.setHeader('Retry-After',String(error.retryAfter));
      json(res,clientError?error.status:500,{error:clientError?error.code:'internal_error',message:clientError?error.message:'Erro interno.'});return true;
    }
  };
}
