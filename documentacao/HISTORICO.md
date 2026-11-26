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

## 25/11/2026 — Ordem histórica das colunas e acesso ao destino
Usuário confirmou acesso SSH ao serviço WA-Arroba, backup inicial em /app/data/backup-pre-postgres-1795613466535 (quick_check=ok, foreign_key_check=0), certificado público CA salvo em /app/data/postgres-root.crt, TLS validado para postgres.railway.internal e destino sem tabelas. Credencial atual é superadmin: ainda falta role runtime restrita. Não copiar credenciais para documentação. Origem permanece SQLite ativa; backup inicial não é snapshot final de virada.
O ensaio parou com SOURCE_SCHEMA_MISMATCH: instances/messages tinham as mesmas colunas/tipos/PK, mas ordem física histórica diferente da base nova. Corrigida somente a comparação de metadados da origem para ignorar ordem; tipos/PK/colunas desconhecidos continuam rejeitados. Hashes/INSERTs continuam mapeados por nomes no manifest, e destino mantém schema canônico. Sete testes de transferência aprovados, incluindo SQLite real com ordem física diferente, snapshot/digests/importação e manutenção da rejeição de mudanças estruturais. Não altera banco ativo, backup nem schema destino.
Próximo: atualizar clone temporário /tmp/wa-postgres-preparacao para o commit desta correção, preparar ensaio a partir do backup inicial e validar importação em schema rehearsal antes de drenar e tirar snapshot final. Ainda não houve importação nem virada; confirmação de CI Docker/carga/SMTP/WhatsApp reais segue pendente.

## 25/11/2026 — Ensaio real aprovado e manutenção para virada
Usuário confirmou importação verificada por hashes/contagens das 17 tabelas em wa_rehearsal_validacao: 3 usuários, 6 instâncias, 7.102 mensagens e 5.663 registros de chaves. Usuário wa_runtime criado com senha aleatória em /app/data/postgres-runtime.json (0600); openPostgresStore validou restrições, schema, invariantes e chave original. Servidor composto foi iniciado localmente contra PostgreSQL real do projeto, com socket WhatsApp/webhook/SMTP bloqueados: ownership exclusivo, readiness200 e dashboard401 aprovados, shutdown concluído. Isso não comprova envio WhatsApp/SMTP real nem carga100+.
Preparada entrada PG_MAINTENANCE=true que NÃO importa store/transporte/runtime, retorna health200 e API/readiness503, sem escritores ou sessões. PG_RUNTIME_CONFIG_FILE lê arquivo regular protegido (0600), usa URL restrita em preferência ao DATABASE_URL administrativo e rejeita divergência entre schema do arquivo e PG_SCHEMA. Dockerfile.postgres inclui ferramentas de transferência para execução manual via SSH. Suítes locais: 97 PG aprovados + 1 ensaio Docker opcional ignorado; 64 SQLite aprovados. Dois novos testes cobrem arquivo restrito e subprocesso de manutenção/SIGTERM. Não confundir preparação, deploy e ativação final.
Próximo: deploy pinado da receita PostgreSQL em MANUTENÇÃO, overlap0 e drenagem; confirmar old process parado e modo manutenção. /tmp será perdido no redeploy; backup inicial, certificado e credencial persistem no volume /app/data. Depois tirar snapshot final com escritores parados, importar em schema NOVO wa_app, conceder grants wa_runtime, validar com chave original e mudar APENAS o schema no arquivo protegido. Só então remover manutenção e restaurar sessões. Não ativar runtime contra rehearsal com credenciais de sessões antigas, nem usar banco vazio como backend. Não imprimir/copiar senhas para chat/GitHub.
Retorno antes de ativar PG: redeploy do build SQLite original 00b5328a-3820-4051-b31d-03a913f77d80, código main e Dockerfile original. Certificado/backup/credencial não alteram SQLite. Depois de aceitar novas mensagens no PG, retorno ao SQLite exige reconciliar filas/ACK/mensagens e evitar reenvio; não é rollback cego. Estado do banco original e volume devem permanecer preservados.

## 25/11/2026 — Manutenção implantada (virada ainda não concluída)
Deploy b38209e7-18d9-44ec-827d-f252e59afea6 confirmado SUCCESS na Railway, pinado em 0e35223469da3e36c18a038bfeaff5c48c22ac4d com Dockerfile.postgres. Build Docker real concluído. Log confirma maintenance ativa sem banco/SMTP/WhatsApp. Deploy antigo 00b5328a-3820-4051-b31d-03a913f77d80 consta REMOVED. Fonte segue preparacao/postgresql pinada; main não foi alterada. API responde manutenção e números temporariamente desconectados. /app/data preservado; /tmp anterior perdido.
Flags live: PG_RUNTIME_ENABLED=true, PG_MAINTENANCE=true, PG_RUNTIME_CONFIG_FILE=/app/data/postgres-runtime.json, PG_SCHEMA=wa_app, PG_CA_FILE=/app/data/postgres-root.crt, PG_RESTORE_CONNECTIONS=true. Arquivo de credencial ainda aponta para wa_rehearsal_validacao, portanto NÃO remover manutenção antes da importação final e atualização segura desse schema. Runtime normal rejeita divergência de schema.
Próxima ação obrigatória: usuário reconectar SSH WA-Arroba, conferir maintenance local, gerar backup/snapshot FINAL dos escritores parados, importar wa_app novo e grants, validar store com role restrita/chave original, atualizar schema no arquivo 0600 e só então desativar manutenção/redeploy. Não usar backup inicial como fonte final. Nenhuma importação final ou reconexão WhatsApp em PG foi feita até este registro.

## 25/11/2026 — PostgreSQL ATIVO EM PRODUÇÃO
Virada executada. Após deploy de manutenção e encerramento do SQLite, snapshot final validado em /app/data/postgres-final-1795616352699 (não confundir com backup inicial). Importação em schema NOVO wa_app confirmou hashes/contagens das 17 tabelas: 3 usuários, 6 instâncias, 7.203 mensagens, 5.671 registros wa_keys, 7.203 IDs públicos e demais históricos preservados. Grants wa_runtime aplicados; store definitivo validou role restrita, schema/invariantes/chave original e contagens. Arquivo /app/data/postgres-runtime.json (0600) atualizado atomicamente para schema wa_app; cópia anterior .pre-cutover preservada. Não publicar/abrir esses arquivos no chat: contêm credencial.
PG_MAINTENANCE=false aplicado. Deploy 97cac596-55ff-4c61-a21f-c7441d25cd19 confirmado SUCCESS; manutenção b38209e7-18d9-44ec-827d-f252e59afea6 REMOVED. Log novo: [postgres] Serviço iniciado. Probes HTTPS públicos conferidos: /api/ready200 com oktrue, /api/health200 com oktrue, /api/dashboard401 sem sessão. Isso confirma aplicação/dono/banco ativos e autenticação exigida, NÃO confirmação individual de todas as sessões WhatsApp nem homologação de envio/recebimento/SMTP.
Configuração Railway: fonte preparacao/postgresql com commitSha 0e35223469da3e36c18a038bfeaff5c48c22ac4d e Dockerfile.postgres; metadado do deploy aponta 65e2abbe7fe41645f8c78a2a489a2c1f81fc677d, commit somente documental com mesmo código. Registrar ambos; não supor que um novo redeploy usa automaticamente a versão desejada. main ainda contém código SQLite e npm start ainda inicia SQLite no checkout main. NÃO reconectar main/Dockerfile original nem iniciar SQLite contra as mesmas sessões por engano. Consolidar main/fonte de deploy em etapa controlada após validação funcional.
Credencial runtime vem de PG_RUNTIME_CONFIG_FILE=/app/data/postgres-runtime.json com role wa_runtime, schema wa_app e TLS via PG_CA_FILE=/app/data/postgres-root.crt. DATABASE_URL administrativo antigo continua presente para manutenção; não é a URL escolhida pelo runtime. PG_RUNTIME_ENABLED=true, PG_SCHEMA=wa_app e PG_RESTORE_CONNECTIONS=true. Não compartilhar valores de conexão. Volume /app/data e SQLite original/backups preservados; master.key original continua necessária. NÃO apagar volume após migrar: ainda armazena chave, CA, credencial e backups. Planejar backup protegido externo de PG+chave/config e retirada posterior da credencial superadmin do app com acesso de manutenção alternativo.
Próximo: Arroba entrar no painel e confirmar quantidade/status das instâncias, testar uma mensagem enviada e uma recebida/webhook com a TI, observar reconexões/alertas e teste de e-mail autorizado. Carga100+/1000 não homologada. Conferir logs de bibliotecas para evitar emissão de material de sessão, definir retenção/backup/restore e consolidar branch/main. Após tráfego no PostgreSQL, NÃO voltar cegamente ao SQLite: reconciliar mensagens/filas/ACK e evitar envios duplicados. Para suspender com segurança, usar manutenção e shutdown; não rodar dois backends simultaneamente.

## 26/11/2026 — Destinatário canônico em novas conversas (correção)
Investigação de boas-vindas pending: consulta somente leitura mostrou ACKs device/read/played operando em várias instâncias, inclusive na mesma instância dos exemplos. Consulta contacts/check dos dois exemplos retornou valid, mas JID com 12 dígitos para entrada de 13; números completos, nomes/corpos/tokens não devem ser registrados aqui. Transporte anterior montava JID diretamente do recipient solicitado, sem usar o JID canônico. Não presumir que toda mensagem pending tenha a mesma causa nem que consulta de validade comprove entrega.
Corrigido postgres/transport.mjs: antes de enviar para telefone individual, consultar onWhatsApp e usar o JID PN válido retornado. Nenhuma regra automática de adicionar/remover dígitos; preservados recipient original/IDs públicos/referência no banco/API. Cache positivo por conexão limitado a 2.000 entradas e 5min, descartado em reconexão; grupos e LIDs não consultam esse caminho. Falha/retorno inválido da consulta vira unsent com erro seguro antes de iniciar envio; timeout de envio continua unknown sem reenvio automático. Recheca dono/instância/propriedade após lookup assíncrono. Credenciais/sockets/logs não são expostos.
Validação local: 100 testes PostgreSQL aprovados e 1 ensaio Docker opcional ignorado; 64 testes SQLite aprovados. Três regressões cobrem canônico/cache/expiração/reconexão e preservação da entrada, lookup inválido/erro/grupos/LID e bloqueio durante consulta. Fixtures agora simulam onWhatsApp. A correção é no backend PostgreSQL ativo; transporte SQLite histórico não foi portado nesta alteração.
Próximo: publicar/deploy controlado desta correção, conferir health/readiness e pedir à TI uma NOVA mensagem autorizada a contato de teste para confirmar ACK/device/recebimento. NÃO reenviar automaticamente mensagens antigas sent+pending, alterar ACK ou limpar fila. Se a TI quiser recuperar mensagens antigas, confirmar destinatário/recebimento antes de reenvio explícito para evitar duplicação. Status sent do legado significa função sendMessage retornou, não prova entrega. Manter diagnóstico separado de confirmação pós-deploy.

## 26/11/2026 — Correção de JID publicada em produção
Deploy f86d77c8-0401-4c77-9c01-3cce7ab7f9e4 da revisão 731aabc4b88883dc80f9ad629b0a8be198b34abf confirmado SUCCESS; log [postgres] Serviço iniciado. Código passa a consultar JID PN canônico antes de novos envios diretos. Fonte conectada/pinada nessa revisão na branch preparacao/postgresql; main não consolidada. Durante troca houve timeout de sonda externa; após estabilização, sondas públicas e logs HTTP confirmaram /api/ready200, /api/health200 e /api/dashboard401 sem sessão. 100 testes PG locais e 64 SQLite aprovados, 1 ensaio Docker opcional ignorado. Imagem de produção construída na Railway.
Nenhuma mensagem antiga sent+pending foi reenviada ou marcada entregue. A confirmação de que a correção resolveu os exemplos depende de novo envio autorizado pela TI e confirmação do receptor/ACK. Não assumir que todo pending seja problema de nono dígito: offline, restrições ou falta de confirmação também precisam diagnóstico próprio. Próximo imediato: teste funcional de nova mensagem para contato de teste e acompanhar ACK; recuperar antigas apenas após checar recebimento e obter solicitação explícita.

## 26/11/2026 — Interface mobile em cards
Implementado apenas em public/app.js e public/style.css: até 680px, tabelas de instâncias ativas/desativadas e visão geral viram cards com rótulos, nome completo, responsável (quando autorizado), telefone, conexão, mensagens e botão Gerenciar de 44px. Alertas de conexão permanecem vermelhos. Gerenciamento adapta abas, credenciais, formulários, mensagens completas e histórico com detalhes expansíveis. Cabeçalhos/roles de tabela preservados para acessibilidade; mensagens continuam escapadas. Nenhuma mudança em banco, transporte, tokens, fila ou reconexão.
Validação local em Chromium com dados fictícios: 48 estados combinando perfis admin/usuário, larguras 320/375/390/680px, visão geral, ativas/desativadas e gerenciamento/conexão/mensagens/histórico. Sem overflow horizontal nessas páginas e tabelas, inclusive nomes/textos longos e histórico expandido. Comparação de capturas em 1280 e 1440px: pixels idênticos ao CSS anterior. node --check public/app.js aprovado. Teste visual automatizado usa API simulada; não comprova envio real nem homologação em Safari/iPhone. Demais tabelas administrativas não fazem parte desta adaptação.
Estado: código preparado para publicar na branch preparacao/postgresql; deploy ainda pendente neste registro. Próximo: publicar revisão, deploy pinado com Dockerfile.postgres, conferir readiness/health e arquivos públicos; depois Arroba conferir no próprio celular. Manter pendência de teste de nova mensagem/ACK com TI e demais itens operacionais anteriores.

### Publicação mobile confirmada
Revisão de interface 16567e69b2c4dcb55fcc6d3658c36f09c34e7ca4 publicada na branch preparacao/postgresql. Deploy Railway a9affb3e-39f8-4bb8-ac8b-9929ba108ddd confirmado SUCCESS; fonte pinada nessa revisão, Dockerfile.postgres e volume preservados. Log [postgres] Serviço iniciado. Arquivos públicos /app.js e /style.css conferidos byte a byte com a versão local validada. Durante a troca houve 502/timeouts nas primeiras sondas; após estabilizar, /api/ready e /api/health responderam 200 e /api/dashboard respondeu 401 sem sessão. Isso confirma disponibilidade/autenticação e publicação dos arquivos, não valida ACKs reais ou todas as conexões individuais.
Próximo: Arroba recarregar o painel no celular e revisar cards/abas. Persistem teste funcional de mensagem/ACK com TI, backup/restore protegido, consolidação controlada de main (ainda SQLite), retenção e ensaio de carga. Este registro documental posterior não requer reiniciar o serviço pinado.

## 26/11/2026 — Mobile completo: navegação inferior e administração
Interface até 680px: menu principal fixo inferior com ícones SVG, rótulos curtos, indicação da página e espaço seguro para o rodapé do aparelho. Admin vê Início/Instâncias/API/Usuários/Gestão; usuário vê somente os três primeiros. Menu oculto no login. Cabeçalho compacto preserva a marca. Administração de usuários, identidade visual, auditoria, quedas e documentação passam a cards com campos rotulados; filtros, formulários, janelas de edição/detalhes, paginações e exemplos de código se ajustam à largura. Instâncias desconectadas recebem badge laranja com texto; queda confirmada mantém vermelho. Cor alterada somente no mobile.
Listas da visão geral/ativas/desativadas exibem 10 instâncias por página no mobile, com Anterior/Próxima, intervalo e total. Página atual é preservada durante atualização periódica; limite se ajusta à quantidade e ao alternar desktop/mobile. Ordenação de alertas preservada. Paginação é de apresentação no cliente: o endpoint continua trazendo metadados de todas as instâncias autorizadas; não foi implementada paginação de rede/backend. PC continua mostrando a lista completa. Nenhuma mudança em autenticação, permissões do servidor, banco, envios, tokens ou sessões.
Estado: validação local em andamento; publicação/deploy ainda pendentes neste registro. Próximo: concluir checagens de leitura mobile, paginação/abas por perfil e comparação do desktop; publicar revisão e conferir deploy/arquivos públicos/health. Manter pendências operacionais anteriores e confirmação do usuário em celular real, inclusive Safari/iOS.

### Validação local concluída
Chromium com API e dados fictícios: 109 verificações no total, incluindo 8 comparações pixel a pixel do desktop (visão geral, usuários, documentação e administração geral, em 1280/1440px), todas idênticas à revisão anterior. Mobile verificado em 320/375/390/680px para admin/usuário: páginas sem overflow horizontal, navegação inferior fixa com 5/3 atalhos conforme perfil, edição de usuário e detalhes de queda em modal, troca de breakpoint e login sem menu. Com 23 instâncias, sequência de páginas 10/10/3 e retorno Anterior/Próxima aprovados nas três listas; desktop volta às 23 linhas. Nenhum erro JavaScript ou requisição mutante disparado pela navegação dos testes. node --check public/app.js aprovado. Safari/iPhone físico e backend real não foram exercitados por esse ensaio de UI.

### Publicação da navegação mobile concluída
Revisão 9f05e5e08da4b8fa69c49e2c122d54dea4a50f97 publicada na branch preparacao/postgresql e pinada no serviço WA-Arroba. Deploy a934f8da-17e9-4399-8a83-5e4824b89d2a confirmado SUCCESS, com log [postgres] Serviço iniciado. Após 503/502 transitórios da troca, sondas finais: /api/ready200, /api/health200 e /api/dashboard401 sem sessão. HTML, app.js e style.css públicos conferidos byte a byte com os arquivos locais testados. Banco, variáveis e volume mantidos. Nenhuma mensagem real enviada pelo teste de interface; confirmar visual final em celular do usuário continua sendo a próxima ação. Registro posterior é apenas documental; não exige novo deploy do serviço pinado.
