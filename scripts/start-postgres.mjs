// Maintenance must not import store/transport: no database, SMTP or WhatsApp writers.
if(process.env.PG_MAINTENANCE==='true'){
  const http=await import('node:http');
  const port=Number(process.env.PORT||3210),host=process.env.HOST||'127.0.0.1';
  if(process.env.PG_RUNTIME_ENABLED!=='true'||!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_MAINTENANCE_CONFIG');
  const server=http.createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
    if(req.method==='GET'&&req.url==='/api/health'){res.end('{"ok":true,"maintenance":true}');return;}
    if(req.method==='GET'&&req.url==='/api/maintenance'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)){res.end('{"maintenance":true}');return;}
    res.writeHead(503,{'Retry-After':'60'});res.end('{"error":"maintenance"}');
  });
  let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close();server.closeIdleConnections();};
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,stop);
  server.on('error',()=>{process.exitCode=1;console.error('[maintenance] Falha no listener.');stop();});
  server.requestTimeout=30000;server.headersTimeout=15000;
  server.listen(port,host,()=>console.log('[maintenance] Ativa; sem escritores de banco ou conexões WhatsApp.'));
}else{
  const {runPostgresRuntime}=await import('../postgres/runtime.mjs');
  await runPostgresRuntime();
}
