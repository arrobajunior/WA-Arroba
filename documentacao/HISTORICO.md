# Histórico

## Base anterior, verificada no GitHub em 18/11/2026
- Main em 87c4027fc458eee88936ede709e15eb351c4cbc6: merge da PR #3, compatibilidade UltraMsg e retransmissão temporária de mídias.
- README e documentação registram perfis USER/ADMIN/Master, fila e ACKs, comandos de mídia e webhooks. Isso descreve implementação, não certificação integral com o provedor.
- Usuário informou que TI confirmou envio e recebimento do webhook; identificação por telefone estava bloqueada por @lid.

## 18/11/2026 — resolução de identidade no webhook
- Diagnóstico: handleIncoming repassava remoteJid para data.from via publicJid, que preservava @lid sem buscar telefone.
- Implementada resolução por metadados, contatos e compartilhamento de telefone; persistência criptografada por instância e consulta opcional à associação do socket.
- Preservado LID original e adicionado phoneResolved. Mensagens sem associação não recebem números inventados.
- Mantidos ID composto, identificação de grupos e chaves originais do WhatsApp.
- Criados AGENTS.md e pasta documentacao para continuidade.
- Teste novo cobre senderPn, persistência após recriar conexão, contato sincronizado, compartilhamento de telefone, grupo, envio sem confundir telefone próprio, consulta opcional, falha de consulta e isolamento entre instâncias.
- Validação: node --test transport.test.mjs (resultado final registrado no roadmap).
- Pendente: confirmar deploy no Railway e testar remetente real com a TI. Não declarar solução homologada antes disso.

## 18/11/2026 — Administração Geral e alertas
- Criada área independente no menu, disponível para todos os ADMINs, com e-mail compartilhado e botão de teste.
- Alterações registram usuário, data e valores anterior/novo; testes registram solicitação, sucesso/falha. A aplicação não oferece edição/exclusão desse log; triggers impedem UPDATE/DELETE na tabela.
- Instâncias registram primeira/última conexão; migração usa telefone, credenciais registradas ou mensagens com confirmação como evidência histórica.
- Quedas geram ocorrências persistidas e um e-mail por ocorrência. Tentativas de reconexão não duplicam alertas; recuperação encerra a ocorrência; nova queda permite novo alerta. Logout solicitado pelo painel/API também é registrado.
- Quedas de instâncias nunca conectadas não geram alertas. Encerramento normal do processo não gera queda; 60s após iniciar, verifica se instâncias anteriores restabeleceram conexão.
- E-mail HTML/texto via SES SMTP STARTTLS, com credenciais somente em ambiente. Fila persistida, retentativas limitadas e status de falha visível.
- Visão geral e listagem destacam ocorrências abertas em vermelho e atualizam automaticamente a cada 10s, respeitando o escopo do usuário.
- npm test: 42 testes aprovados. Verificação DOM local cobre menu, configuração/log, botão de teste, alerta automático e recuperação. Navegador Chromium local não pôde iniciar por restrição do ambiente; não foi inspecionada captura visual.
- SMTP real não configurado/testado. Revisão automática bloqueou gravação das credenciais no serviço Railway até autorização explícita desse destino. Não copiar o guia com segredos para o repositório.

## 18/11/2026 — autorização e configuração do SMTP
- Usuário autorizou explicitamente gravar as credenciais SES do guia no serviço Railway WA-Arroba, ambiente production.
- SES_SMTP_USER e SES_SMTP_PASS foram cadastradas como variáveis desse serviço, sem incluir valores nos arquivos ou no GitHub.
- A implantação a88ef44 da Administração Geral foi confirmada como SUCCESS. Esta atualização documental dispara a implantação com as novas variáveis.
- Pendente: confirmar implantação com variáveis e homologar e-mail de teste no destinatário escolhido no painel. Não foi desconectada instância real para testar.

## 18/11/2026 — Histórico detalhado de quedas
- Expandido card independente na Administração Geral: todas as ocorrências são acessíveis por paginação, sem limitar a consulta aos 100 últimos registros.
- Filtros por instância, início/fim (data da queda em Brasília), conexão em aberto/resolvida e estado do e-mail.
- Registro preserva nome, ID, número e responsável no momento da queda; início, recuperação, duração e última confirmação de conexão; código numérico informado pelo WhatsApp, origem, tentativas automáticas e referências de implantação/commit quando disponíveis no ambiente.
- Linha do tempo registra abertura, mudanças/QR/reconexão, recuperação, tentativas/envio/falhas/cancelamento do e-mail e reentrada na fila. Mostra destinatário, horário e ID de mensagem SMTP, com retentativas de configuração distinguíveis.
- E-mails aceitos pelo SES são exibidos como enviados ao provedor. Pendente/falha/sem confirmação continuam distintos; a queda não é prova de entrega de e-mail.
- Resumos e recorrências por instância, motivo/código e horário usam todo o filtro, não apenas a página. São frequências observadas, não diagnóstico automático de causa.
- Registros anteriores são preservados e identificados como históricos limitados: nomes/números são recuperados do cadastro disponível e horários/códigos ausentes permanecem não registrados.
- Validação: 46 testes automatizados aprovados; verificação DOM local passou para filtros, detalhes, linha do tempo SMTP, paginação e recuperação. Nenhum canal real foi desconectado para teste e nenhum e-mail real de teste foi enviado nesta mudança.

## 18/11/2026 — Auditoria de ações por instância e central
- Criada aba Histórico e segurança por instância e card central na Administração Geral.
- Registro de criação, acesso aos dados/credenciais, consulta de mensagens, pedidos de exibição/cópia do token, renovação do token, alterações de nome/webhook e solicitações de conexão/desconexão.
- Configuração/teste de e-mail geral entram também no log central; operações POST autenticadas da API compatível registram comando, instância e resultado sem conteúdo/tokens. QR via API que inicia conexão também é rastreado.
- Eventos automáticos registram QR, quedas, tentativas e confirmação de conexão. Troca de número confirmado preserva o anterior mesmo após logout/reset.
- Autoria é da sessão real no painel. API com token é integração (não o proprietário humano); eventos automáticos não reutilizam autoria de admin.
- Correlacionada a confirmação ao pedido de conexão quando existe contexto explícito no processo; contexto é apagado após confirmar. Isso identifica quem solicitou a conexão, sem afirmar quem fisicamente leu o QR; após reiniciar, não inventa autoria perdida.
- Log preserva snapshots de pessoa/instância, data em Brasília na interface, ação, resultado, valores anteriores/novos seguros, origem, correlação e IP da conexão (que pode ser proxy).
- Tabela com triggers de proteção contra UPDATE/DELETE e sem rotina de limpeza pela aplicação. Reset de instância preserva auditoria. Acesso USER fica restrito à própria instância; ADMIN consulta o central.
- Migração única importa criação/data original, quedas/recuperações existentes e auditoria anterior de e-mail. Autorias ausentes continuam desconhecidas; não atribui ao dono atual.
- Webhook registra somente origem e SHA-256 da URL, sem senha, rota ou parâmetros; tokens antigos/novos nunca são gravados.
- Validação: 52 testes automatizados aprovados; DOM local verificou aba por instância, solicitação de token, renovação, filtros globais, identificação do executor, paginação e manutenção do histórico de quedas. Não houve envio real de e-mail nem desconexão de canal real para testar.

## 18/11/2026 — Redução de ruído nos acessos
- Por solicitação do usuário, removido o evento instance_viewed da simples consulta de detalhes da instância.
- Mantido messages_viewed ao consultar mensagens (incluindo acesso à aba, filtros e atualização manual), com autoria real.
- Alterações, token, conexão e acessos negados continuam auditados. Registros antigos são preservados.
- Teste de integração atualizado para verificar ausência de instance_viewed e presença de messages_viewed para o executor correto.

## 19/11/2026 — Correção de alertas falsos por reconexão breve
- Usuário reportou 27 e-mails/ocorrências, sendo várias recuperações de 2–4s e uma sessão encerrada intencionalmente. A causa no código era abertura/envio no primeiro evento close, antes da recuperação automática.
- Implementada tolerância padrão de 60s em connection-alerts.mjs. Suspeitas ficam em connection_candidates, com prazo original persistido e snapshot seguro; tentativas não prolongam a espera.
- Retorno breve cancela suspeita sem e-mail, ocorrência, vermelho no dashboard ou par de eventos de queda/reconexão na auditoria. Atualização de telefone e ações humanas permanecem auditadas.
- Confirmada interrupção persistente: uma ocorrência e um e-mail por episódio; mantém horário original da detecção e linha do tempo de tentativas. Recuperação encerra a ocorrência. Se retornar antes de iniciar o envio, cancela e-mail pendente.
- Logout explícito, códigos 401/440, tentativas esgotadas e QR exigido para sessão anteriormente conectada geram alerta imediato.
- Migração aditiva classifica ocorrências antigas como transient apenas quando resolvidas em menos de 60s, fonte whatsapp e códigos recuperáveis conhecidos (408/428/500/503/515). Mantém datas/e-mails/provas e exclui-as do filtro padrão; não reclassifica logout intencional, 401/440 ou duração >=60s.
- Acrescentado filtro Classificação: quedas confirmadas (padrão), reconexões breves anteriores e todos os registros. Resumos/padrões usam a classificação escolhida.
- Cancelado timer antigo de tentativa quando o socket já recuperou, evitando reconexão forçada desnecessária. Verificação de uma ocorrência já aberta após reiniciar não gera novo evento de queda nem novo e-mail.
- Validação: 61 testes na suíte aprovados, mais verificações focadas no limite exato de 60s e não repetição em verificação de startup; DOM local passou em filtros, detalhes, paginação, auditoria e histórico. SMTP e WhatsApp simulados; nenhum canal real foi desconectado para teste.

## 19/11/2026 — Nome e ciclo de ativação
- Edição de nome destacada no topo de Gerenciar, sem alterar ID/token/URL.
- Desativar/reativar com confirmação, abas Ativas/Desativadas e autoria auditada.
- Socket, API, fila e restauração automática respeitam desativação; sessão e dados preservados. Reativação não conecta automaticamente.
- Monitoramento inativo não dispara alertas; queda aberta termina por desativação, separada de recuperação real.
- 64 testes automatizados aprovados. Ver INSTANCIAS.md. Publicação/implantação e homologação real são etapas distintas; verificar commit e status Railway antes de afirmar implantação.
- Implantação anterior da tolerância de 60s: SUCCESS (2c4d98d9-0f26-454f-a1bb-cb2ebb30ae0e, commit 7351d1b).

## 19/11/2026 — Preparação isolada de PostgreSQL
Usuário autorizou adiantar sem subir. Criados schema de transferência, snapshot SQLite somente leitura com chave original, importador transacional com verificação completa e 6 testes em PostgreSQL embarcado. Suíte operacional de 64 testes preservada. Nenhum dado real transferido, segredo lido ou deploy solicitado. A aplicação ainda depende de SQLite: portabilidade assíncrona, pausa/drenagem e ensaio no banco real continuam obrigatórios. Ver POSTGRESQL.md para retomar.

## 19/11/2026 — Início da adaptação assíncrona para PostgreSQL
- Criados postgres/database.mjs, persistence-crypto.mjs e store.mjs: pool limitado, transações em conexão única, erros redigidos, preservação da chave e validação de schema/usuário restrito.
- Portados repositórios de auditoria e histórico de quedas para queries PostgreSQL assíncronas, com escopo de filtros, atribuição, troca de número atômica e horários Brasília.
- Corrigido trigger PostgreSQL para permitir exclusão de usuário comum, preservando o Master.
- Validação: 17 testes PostgreSQL locais (PGlite e pool simulado) e 64 testes operacionais SQLite aprovados. Sem teste TCP/TLS do serviço real, sessões reais ou capacidade 100+.
- Mantidos server.mjs, store.mjs e demais módulos operacionais atuais sem alteração. Backend PostgreSQL ainda não selecionável pelo servidor; não houve migração ou deploy.
- Próximo: portar autenticação, cadastro/rotas, branding, alertas e transporte/fila/credenciais, concluir regressões e pausa/drenagem. Ver POSTGRESQL.md. Branch isolada; main permanece ccc85f1.

## 19/11/2026 — Contas, cadastro e rotas HTTP para PostgreSQL
- Portados login/sessões/usuários, cadastro/listagem/detalhes/nome/webhook/token de instâncias e identidade visual, com módulo HTTP preparatório não ligado ao servidor atual.
- Preservados perfis/Master, revogação de sessão, ID/token no rename, token criptografado, auditoria e ausência de log em visitas comuns.
- Adicionados rechecagem de conta após scrypt, locks determinísticos, limite de criação por proprietário atômico e contagens/alertas de listagem em lote.
- 26 testes PostgreSQL locais (incluindo 9 de controle/HTTP) e 64 testes SQLite aprovados; dados sintéticos e HTTP em loopback. Sem TCP/TLS do banco Railway nem sessão WhatsApp real.
- Nenhuma alteração em main/deploy/variáveis/dados reais. Próximo: alertas e transporte/fila/wa_keys, composição de servidor e API de integração, ensaio completo/pausa antes da virada. Detalhes e limites em POSTGRESQL.md.

## 19/11/2026 — Alertas e credenciais em PostgreSQL
- Portado controlador de alertas: grace persistida/timer, terminais imediatos, recuperação/desativação, mail claim atômico, retry limitado e unknown explícito em envio interrompido. Persistência pós-SMTP não dispara novo SMTP ao falhar.
- Configuração e teste de e-mail compartilhados/ADMIN/auditados adicionados ao roteador preparatório quando alerts é injetado.
- Criados serial-tasks e auth-state: credenciais Baileys criptografadas compatíveis, snapshots na chamada, lote atômico, filas por estado e invalidação que evita gravação antiga após reset.
- Validação: 43 testes PostgreSQL locais e 64 testes atuais SQLite aprovados. Testes usam PGlite, dados sintéticos e SMTP simulado. Sem banco/credenciais/conversas reais ou deploy.
- Próximo: transporte completo, coordenação de dono único e fila de mensagens, API de integração, rotas restantes e composição/pausa. RecoverInterrupted exige startup exclusivo; auth-state não habilita múltiplos donos. Ver POSTGRESQL.md.

## 19/11/2026 — Transporte assíncrono e fila PostgreSQL
- Criados transport.mjs, message-queue.mjs e transport-ownership.mjs dentro de postgres/, preservando arquivos operacionais da raiz.
- Ligadas credenciais ordenadas, eventos de conexão/recebimento/ACK/webhooks, LID, mídias voláteis e lifecycle interno. Adicionadas reserva atômica/prioridade/expiração e recuperação sem repetir envios ambíguos.
- Guard por banco/schema usa conexão dedicada, heartbeat e verificação no pg_locks; perda de propriedade fecha sockets. Índices de fila/provider/status adicionados ao schema de destino.
- Corrigidas na adaptação: recuperação de uma instância não altera outra; reconexão preserva mídia ainda em memória; payload inválido não entra em loop; encerramento drena eventos já capturados.
- Validação: 66 testes PostgreSQL locais e 64 testes SQLite aprovados. Sockets/serviços simulados e motor PGlite; sem conexão WhatsApp/SMTP/Railway real e sem deploy.
- Próximo: API compatível, rotas de conexão/mensagens/lifecycle, composição do servidor/build e pausa. Guard não cobre o serviço SQLite antigo nem schema diferente; virada exige parar sessões antigas e validação real. Detalhes em POSTGRESQL.md.

## 19/11/2026 — API compatível e lifecycle HTTP PostgreSQL
- Criados compatibility-api, http e panel-messages; ligados comandos de conexão/QR/desativação/reativação e leitura auditada da aba Mensagens ao roteador preparatório.
- Mantidos token, IDs públicos, formulários/anexos, filtros/settings e operações de integração. Rechecagem de acesso após mídia e trava transacional de quota/limpeza/reenvio; sucesso dessas mutações e auditoria são atômicos.
- 77 testes PostgreSQL locais e 64 testes SQLite aprovados; dados sintéticos/PGlite e provedores simulados. Sem deploy, acesso a conversas reais ou mudança de variáveis.
- Próximo: compor servidor, readiness/ownership/recuperação/pausa/drenagem/build, validar banco/WhatsApp/carga reais antes da virada. Detalhes e limites em POSTGRESQL.md.

## 23/11/2026 — Composição do servidor PostgreSQL
- Criada fábrica explícita postgres/server.mjs sem efeitos ao importar; liga módulos preparados, painel/API/estáticos/relay e startup com ownership antes de recuperar/restaurar.
- Readiness sem dados sensíveis; pausa terminal drena requisições, transporte e alertas; shutdown libera dono/banco somente após concluir. Perda de dono bloqueia admissão e fecha transporte/alertas.
- 85 testes PostgreSQL e 64 SQLite aprovados localmente; oito novos testes HTTP/lifecycle/composição com PGlite e socket/owner sintéticos. Sem produção, segredos Railway ou conversas reais.
- Próximo: entrada/build e supervisão de processo, ensaios reais e carga. Não houve deploy nem mudança de backend operacional. Ver POSTGRESQL.md.

## 24/11/2026 — Entrada executável e build PostgreSQL separados
- Criados runtime.mjs e scripts/start-postgres.mjs, npm run start:postgres e Dockerfile.postgres. Ativação explícita, restauração opt-in, configuração/TLS e tratamento seguro de erro/sinal durante startup/listen.
- Runtime encerra ao perder readiness; drena sem process.exit forçado. Dockerfile operacional, npm start e produção preservados.
- 94 testes PostgreSQL e 64 SQLite aprovados, com nove testes de runtime/build/subprocesso. Docker indisponível: não houve build/executação de imagem nem conexão Railway/WhatsApp/SMTP real.
- Próximo: construir imagem e validar PostgreSQL isolado real/TLS/privilégios/backup/restauração/concorrência/carga antes de planejar virada autorizada. Ver POSTGRESQL.md.

## 24/11/2026 — Ensaio isolado no GitHub Actions
- Criados workflow postgres-rehearsal e real.test.mjs para build/imagem, TCP/TLS/CA, role restrita, ownership/claim com conexões reais e dump/restore integral, somente dados sintéticos e containers efêmeros.
- Workflow não usa secrets, não publica imagem e não faz deploy. Produção/main/variáveis preservados.
- Local: 94 PG aprovados + 1 real ignorado, 64 SQLite aprovados; YAML/sintaxe validados. Execução de CI ainda precisa ser conferida, sem presumir aprovação do build/ensaio real.
- Próximo: acompanhar Actions e corrigir resultado, depois carga100+/particularidades do destino isolado autorizado. Ver POSTGRESQL.md.

## 24/11/2026 — Auditoria e preparação da virada autorizada
Arroba autorizou avançar para produção, com objetivo de concluir em até uma hora. Ainda não ocorreu virada. Confirmados serviços WA-Arroba/WhatsAPI_DB saudáveis e volumes preservados na Railway. Conexão OAuth retorna somente nomes de variáveis e não executa comandos no volume; acesso CLI/SSH para backup consistente e chave original ainda precisa ser habilitado. Não parar o serviço antes desse acesso e do backup.
Envios rotineiros de texto/anexos/contatos/localização e upload deixam de gerar auditoria por mensagem (SQLite e PostgreSQL); registros próprios das mensagens mantidos. Configurações, lifecycle, limpeza/reenvio e outras ações sensíveis continuam auditados. Nenhum histórico antigo foi excluído, nem política de retenção destrutiva aplicada. Validados 64 testes SQLite e 8 da API PostgreSQL. Código somente na branch de preparação. Próximo: obter acesso CLI/SSH, conferir CI real, backup/chave, validar destino/TLS/role, drenar e executar migração na janela autorizada; preservar retorno sem repetir envios.
