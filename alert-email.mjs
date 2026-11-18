import nodemailer from 'nodemailer';

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const smtpReady=()=>Boolean(process.env.SES_SMTP_USER&&process.env.SES_SMTP_PASS);

export function alertMessage({to,instance,incident,appName='WhatsApp API',publicUrl,test=false}) {
  const heading=test?'Teste de alerta por e-mail':'Atenção: WhatsApp desconectado';
  const moment=new Date(incident?.opened_at||Date.now()).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'});
  const name=String(instance?.name||'Instância de demonstração').replace(/[\r\n]/g,' ');
  const url=publicUrl?`${publicUrl}/#${instance?.id?`instance/${encodeURIComponent(instance.id)}`:'general-admin'}`:'';
  const summary=test?'Este é um teste da configuração de alertas. Nenhuma conexão foi alterada.':'Uma instância que já estava em uso perdeu a conexão com o WhatsApp. Os envios podem ficar na fila até a conexão ser restabelecida.';
  const details=test?'':`Instância: ${name}\nID: ${instance.id}\nNúmero: ${instance.phone||'Não informado'}\nResponsável: ${instance.owner_name||'Não informado'}\nMotivo: ${incident.reason}\n`;
  return {from:{name:appName,address:'contato@mfrural.com.br'},to,subject:`${test?'[TESTE]':'[ALERTA]'} ${heading}${test?'':` — ${name}`}`,
    text:`${appName}\n${heading}\n\n${summary}\n\n${details}Data: ${moment} (Brasília)\n${url?`\nAbra o painel: ${url}\n`:''}Confira a conexão e, se necessário, gere um novo QR Code.`,
    html:`<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,sans-serif;color:#253b3d;padding:28px 12px"><table role="presentation" style="width:100%;max-width:620px;margin:auto;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb"><tr><td style="padding:24px 28px;background:#17372f;color:white;font-size:20px;font-weight:bold">${escapeHtml(appName)}</td></tr><tr><td style="padding:28px"><div style="border-left:5px solid #dc2626;background:#fff1f2;padding:20px"><p style="margin:0 0 8px;color:#b91c1c;font-size:12px;font-weight:bold;letter-spacing:1px">${test?'VERIFICAÇÃO DE CONFIGURAÇÃO':'ALERTA DE CONEXÃO'}</p><h1 style="font-size:24px;color:#991b1b;margin:0">${heading}</h1></div><p style="font-size:15px;line-height:1.7">${summary}</p>${test?'':`<table role="presentation" style="width:100%;font-size:14px;line-height:1.8;border-collapse:collapse">${[['Instância',name],['ID',instance.id],['Número',instance.phone||'Não informado'],['Responsável',instance.owner_name||'Não informado'],['Motivo',incident.reason]].map(([key,value])=>`<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;color:#667085">${key}</td><td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:bold">${escapeHtml(value)}</td></tr>`).join('')}</table>`}<p style="font-size:13px;color:#667085">${escapeHtml(moment)} · Horário de Brasília</p>${url?`<p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#b91c1c;color:white;text-decoration:none;border-radius:7px;padding:14px 24px;font-weight:bold">Abrir painel e verificar conexão</a></p>`:''}<p style="font-size:13px;color:#667085;line-height:1.6">Confira a conexão da instância e, se necessário, gere um novo QR Code no painel.</p></td></tr><tr><td style="padding:18px 28px;background:#f8fafc;color:#667085;font-size:12px">Notificação automática · ${escapeHtml(appName)}</td></tr></table></body></html>`};
}

export async function sendAlertEmail(input,{createTransport=nodemailer.createTransport}={}) {
  if(!smtpReady())throw Object.assign(new Error('Credenciais SMTP não configuradas.'),{code:'SMTP_NOT_CONFIGURED'});
  const transport=createTransport({host:'email-smtp.us-east-1.amazonaws.com',port:587,secure:false,requireTLS:true,
    auth:{user:process.env.SES_SMTP_USER,pass:process.env.SES_SMTP_PASS},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,
    disableFileAccess:true,disableUrlAccess:true});
  try{const info=await transport.sendMail(alertMessage(input));if(info.rejected?.length)throw Object.assign(new Error('Destinatário recusado.'),{code:'RECIPIENT_REJECTED'});return info;}finally{transport.close?.();}
}
