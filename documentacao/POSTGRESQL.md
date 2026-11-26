# PostgreSQL — preparação e virada controlada

Data: 19/11/2026. Base: ccc85f1237567c08fba5df4f506e8c09ae44645f.
Autorização atual (atualizada em 25/11/2026): Arroba autorizou avançar a produção. Ensaio real validado pelo usuário via SSH; próxima etapa é manutenção com backup final antes da ativação. As seções antigas abaixo são histórico; consultar a última etapa para o estado corrente.

## Estado real (25/11/2026)
**PostgreSQL ativo em produção** no schema wa_app, role restrita/TLS/chave original validados. Deploy e probes públicos aprovados. Confirmação individual das sessões e envio/recebimento real pendentes do usuário. Fonte Railway é a branch preparacao/postgresql, Dockerfile.postgres; main ainda usa SQLite. Consultar a última seção para configurações, backups e restrições de retorno. As etapas anteriores abaixo são histórico, não instrução para repetir a importação.

## Entregue nesta branch
- postgres/schema.sql: 17 tabelas e índices correspondentes ao SQLite atual, com BIGINT, BYTEA e identidades. Datas/textos são preservados, sem conversão implícita de fuso.
- postgres/invariants.sql: proteção de auditoria e Master e criação dos IDs públicos de mensagens.
- postgres/manifest.json: estrutura de origem conhecida; coluna/tabela desconhecida interrompe a transferência.
- postgres/transfer.mjs: snapshot consistente com API online backup do SQLite (inclui WAL), origem somente leitura, cópia da chave, verificação de integridade/FKs e de todos os tokens/wa_keys criptografados. Não chama openStore no banco real, pois abrir o store operacional executa migrações e altera filas.
- Importação com transação única, schema novo obrigatório, bloqueio entre importadores, inserção em lotes e comparação por contagem e SHA-256 de cada tabela antes do COMMIT. Falha desfaz o schema inteiro.
- Preservação dos limites sqlite_sequence mesmo quando IDs altos foram excluídos; não reutilizar IDs públicos.
- Scripts são manuais, sem vínculo com npm start ou deploy. PG_MIGRATION_URL é explícita; DATABASE_URL não é usada pelo preparador.
- Sem novas sessões WhatsApp, sockets, webhooks ou e-mails no ensaio.

## Testes
npm test: suíte operacional existente (64 testes).
npm run test:postgres: 95 testes (94 locais e 1 ensaio real opcional; a divisão dos 94 locais é 6 de transferência + 11 da camada assíncrona/repositórios + 10 de controle/HTTP + 10 de alertas + 6 de credenciais/ordenação + 5 de fila + 4 de propriedade + 14 de transporte + 8 da API compatível + 3 de lifecycle/painel + 8 de composição do servidor + 9 de runtime/build). Usam PostgreSQL embarcado PGlite com dados sintéticos; concorrência entre conexões também tem teste de isolamento com pool simulado. Cobrem backup/WAL, chaves, blobs, Unicode, IDs, rollback, privilégios, auditoria, horários e erros sem conteúdo sensível.
Não é uma validação da conexão TCP/TLS nem do PostgreSQL real provisionado. Não é teste de capacidade para 100 sessões nem homologação WhatsApp real.

## Comandos de ensaio — só com dados sintéticos/cópia autorizada
Instalar com npm ci --ignore-scripts.
Criar snapshot: npm run postgres:prepare -- snapshot --source /caminho/origem --out /caminho/novo-snapshot
Inspecionar sem rede nem escrita PostgreSQL: npm run postgres:prepare -- import --snapshot /caminho/novo-snapshot --schema wa_rehearsal_teste
Importar em banco de ensaio: definir PG_MIGRATION_URL por ambiente seguro; npm run postgres:prepare -- import --snapshot /caminho/novo-snapshot --schema wa_rehearsal_teste --apply
O destino exige schema novo. Não apaga, limpa, atualiza ou sobrescreve schema existente.
Snapshots contêm dados privados e master.key; permissões 0700/0600 reduzem exposição local, mas não os criptografam. Não guardar no GitHub nem compartilhar. Backups duráveis devem ser criptografados com segredo independente.

## Trabalho obrigatório antes da virada
1. Concluir a portabilidade do acesso síncrono. Cliente PostgreSQL assíncrono com pool limitado, transações por conexão e queries parametrizadas já existe em postgres/database.mjs; ainda falta ligar os consumidores operacionais. Abrange server.mjs, store.mjs, transport.mjs, compatibility-api.mjs, branding.mjs, connection-alerts.mjs, instance-activity.mjs e incident-history.mjs. Não simular sincronismo com bloqueios no event loop.
2. Ajustar dialeto: INSERT OR IGNORE/REPLACE, strftime/julianday, triggers, indicadores inteiros/booleanos, tipos BIGINT retornados pelo driver e contagem/paginação.
3. Garantir transações atômicas, reivindicação da fila sem duplicidade, gravação de credenciais em ordem e dono único por sessão; PostgreSQL sozinho não autoriza múltiplas réplicas.
4. Portar e executar toda a suíte usando o backend PostgreSQL. Testar envio, mídia, LID, ACK, logout, reset, desativação, alertas de 60s, auditoria, escopo entre usuários e reinício.
5. Implementar pausa/drenagem controlada: recusar novas operações mutáveis com resposta temporária e parar processamento/socket sem logout. Não matar envios em andamento sem registrar estado ambíguo.
6. Conferir serviço/banco e variáveis reais de forma redigida, rede privada, TLS quando aplicável, usuário operacional de privilégio mínimo e credencial de migração separada. Testar backup/restauração.
7. Preservar master.key original e configurar carregamento seguro antes de trocar backend. Não gerar nova chave ao perder a anterior. Não remover o volume atual.
8. Somente após aviso explícito de virada: pausar escritores; drenar; gerar NOVO snapshot final (não reutilizar ensaio antigo); importar em wa_app com --apply --writers-stopped; validar; iniciar uma única aplicação com o backend novo.
9. --writers-stopped é uma declaração do operador, não detector automático de pausa. O preparador não muda o serviço e não garante sozinho que os escritores foram parados.
10. Monitorar saúde, sessões, filas, ACKs e webhooks. Preservar SQLite/backup. Depois de aceitar gravações no PostgreSQL, voltar ao SQLite antigo perde dados novos: não usar fallback automático nem rollback para cópia desatualizada. Planejar reconciliação antes de qualquer retorno.

## Segurança e escala — trabalho separado pendente
As mensagens atuais não têm criptografia de conteúdo no armazenamento; admin continua tendo acesso amplo às instâncias. Esta preparação não muda isso.
Definir MFA para administradores, permissão específica para mensagens, separação/proteção das chaves, criptografia de conteúdo e retenção. Não impor retenção nem retirar permissões sem definição do produto.
Para 100+ sessões, medir CPU/memória, latência, fila e tempestades de reconexão; planejar divisão entre workers com coordenação. Não prometer capacidade só pela troca do banco.

## Fontes
- Código desta branch e store.mjs da base acima.
- https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options
- https://www.postgresql.org/docs/current/sql-begin.html
- https://www.postgresql.org/docs/current/sql-createtable.html
- https://docs.railway.com/networking/private-networking


## Adaptação iniciada — 19/11/2026, segunda etapa
Usuário pediu começar a adaptação; mantém-se a autorização de trabalhar apenas na branch preparacao/postgresql, sem publicar main, deploy, migração real ou alterações de variáveis.

### Implementado e testado
- postgres/database.mjs: Pool pg limitado a 10 conexões por padrão (configurável de 1 a 30), aquisição com timeout, limite de execução/locks, cliente reservado por transação e isolamento de contexto com AsyncLocalStorage. Consultas são assíncronas e usam parâmetros nativos $1, $2 etc. Não há tradutor geral de SQL SQLite.
- Rollback em erro, rejeição de transações aninhadas, rejeição de reutilização do contexto depois do término, BIGINT convertido somente quando inteiro seguro e blobs como Buffer. Nenhum retry implícito que possa repetir envio ou mutação. Erros do driver são reduzidos ao código, sem SQL, valores ou credenciais.
- TLS com validação do certificado; não aceita rejectUnauthorized=false nem modos de URL que reduzam validação. Ainda precisa confirmar CA/TLS do banco real. Não contornar erro real de certificado desabilitando verificação.
- postgres/persistence-crypto.mjs: lê a master.key original (arquivo regular 0600 ou mais restrito) ou chave base64 explícita. Se ambos existirem, têm que coincidir. Mantém formato AES-256-GCM compatível; não gera, modifica nem expõe chave.
- postgres/store.mjs: verifica schema conhecido e triggers antes de entregar o backend. Exige usuário operacional sem superuser/BYPASSRLS/CREATEDB/CREATEROLE, propriedade de objetos ou associação ao dono do schema. Verifica capacidade de ler tokens/credenciais usando a chave original, em transação só de leitura. Não faz bootstrap, DDL, recuperação de fila ou conexão WhatsApp.
- postgres/instance-activity.mjs: versão assíncrona da auditoria com identidade/correlação, snapshots seguros e filtros isolados por instância. Confirmação/troca de número usa bloqueio de linha e atualização atômica do telefone anterior. Reconexão breve continua sem evento redundante; nenhuma simples visita é adicionada ao log.
- postgres/incident-history.mjs: paginação, filtros, contagens e durações em SQL PostgreSQL; consulta consistente em REPEATABLE READ só de leitura e agrupamento de horários em America/Sao_Paulo. Encerramento por desativação permanece distinto de recuperação.
- Correção em postgres/invariants.sql: trigger do Master permite DELETE de usuário comum (RETURN OLD), mantendo o bloqueio do Master. A primeira preparação ainda não havia testado a exclusão de usuário comum.

### Próxima etapa concreta
Portar autenticação/usuários e cadastro de instâncias, branding e rotas HTTP para o contrato assíncrono; depois alertas e transporte/fila/wa_keys com serialização das operações. Consumidores devem aguardar as Promises dos novos repositórios. Não substituir imports atuais sem portar chamadas e testes.
A seleção do backend ainda não foi adicionada ao server.mjs: definir DATABASE_URL continua sem efeito sobre o serviço atual.
Uma única aplicação deve ser dona das sessões; a fundação de pool não habilita várias réplicas.
Continuam pendentes todos os ensaios operacionais de envio/ACK/webhooks, pausa/drenagem, banco Railway real, chave/backup e carga 100+.

### Fontes adicionais
- https://node-postgres.com/features/transactions
- https://node-postgres.com/apis/pool
- Código e testes desta branch.

## Cadastro e autenticação — 19/11/2026, terceira etapa
Autorização continua limitada à preparação em branch separada. Não houve deploy, alteração de variáveis ou acesso aos dados reais.

### Implementado
- postgres/accounts.mjs: login com scrypt, sessão de 12h cujo identificador é persistido como hash, logout, listagem/criação/alteração de usuários e invalidação de sessões por senha/e-mail/perfil/bloqueio. Mantém ADMIN/USER/Master; somente o próprio Master pode alterar sua conta, sem bloqueio/rebaixamento.
- Login relê e bloqueia a conta depois da validação assíncrona da senha antes de emitir sessão, evitando aceitar credencial que tenha sido trocada/bloqueada enquanto o hash era verificado. Atualização de contas bloqueia linhas em ordem determinística.
- Limite de tentativas mantém regra atual de 20 por usuário/IP em 15min, armazenamento em memória por processo e IP do socket (não confia em X-Forwarded-For). Isso ainda não é um limitador distribuído.
- postgres/instances.mjs: cadastro, listagem/dashboard, consulta, nome/webhook e renovação de token com queries parametrizadas e autoria real. Visita comum continua sem log; consulta de atividade respeita escopo de instância.
- Cadastro e auditoria de sucesso são atômicos; falha ao persistir auditoria desfaz a criação. Limite por proprietário protegido por advisory lock transacional, e colisão de ID tem tentativas limitadas. Padrão continua 50 por proprietário; parâmetro perOwnerLimit permite ensaiar outros limites. Isso não comprova capacidade para 100 sessões conectadas.
- Nome não muda ID/token; token é criptografado e nunca aparece no log. Listagens não devolvem token. Dashboard e abas consultam contagens/alertas em lote (sem uma consulta de contagem por instância).
- postgres/branding.mjs: identidade visual assíncrona com gravação atômica, imagem decodificada/reconvertida para PNG, limites de tamanho/pixels e remoção por slot. Permissão Master fica na rota, como no servidor atual.
- postgres/control-api.mjs: roteador HTTP preparatório para login/me/logout, usuários, cadastro/detalhes/edição/token de instâncias, dashboard, identidade visual, auditoria e histórico de quedas. Confere Host, origem/marcador CSRF nas mutações, sessão, permissões e corpo limitado; erros internos não devolvem SQL/dados privados. Não é um servidor novo e NÃO é importado pelo server.mjs.
- O roteador retorna false para rotas não cobertas, para futura composição explícita. Não trata envio, mensagens, QR, conexão, logout WhatsApp, desativação/reativação nem configuração/envio de e-mail. Não usar como substituto completo da aplicação.

### Validação
26 testes PostgreSQL locais aprovados e 64 testes existentes SQLite aprovados. Os 9 novos testes exercitam HTTP real em loopback e PostgreSQL embarcado PGlite com dados sintéticos: sessão/hash/cookie/expiração, Host/CSRF, proteção Master, revogação de sessão, escopo de proprietários/ADMIN, identidade/token, auditoria, quota, consultas em lote, branding, rate limit, mudança de senha concorrente, rollback com falha de auditoria, e-mail duplicado e texto com aparência de SQL tratado como dado.
Cookie Secure foi verificado no cabeçalho; não houve ensaio HTTPS/TLS real. O motor embarcado usa uma conexão serializada por fixture: os testes de quota HTTP não substituem ensaio com múltiplas conexões PostgreSQL reais.
Nenhuma sessão WhatsApp foi aberta e nenhum e-mail/webhook real foi disparado.

### Próximo ponto concreto de retomada
Portar alertas de 60s e transporte/fila/wa_keys para PostgreSQL assíncrono, garantindo ordenação dos eventos/credenciais e dono único da sessão. Depois compor o servidor HTTP completo com a API de integração e todas as rotas restantes; fazer ensaio ponta a ponta e de pausa/drenagem antes de selecionar backend ou preparar virada.
Mantêm-se todos os bloqueios de implantação das seções anteriores. Não fazer merge em main nem executar importação final só porque as rotas de cadastro passaram.

## Alertas e credenciais — 19/11/2026, quarta etapa
Autorização mantida: preparar na branch preparacao/postgresql; não fazer merge/deploy, trocar backend, alterar variáveis nem importar dados reais.

### Implementado
- postgres/connection-alerts.mjs: controlador assíncrono PostgreSQL para suspeitas persistidas, prazo contínuo de 60s, confirmação por timer, quedas terminais imediatas, recuperação, desativação e rechecagem de startup. Usa fila por instância e lock de linha; callbacks de auditoria são aguardados depois do COMMIT para evitar transações aninhadas.
- Reconexões de 3–10s não abrem ocorrência, não enviam e-mail e não adicionam par redundante de queda/reconexão. Retries não prolongam o prazo. Logout explícito/401/440/QR exigido/tentativas esgotadas continuam imediatos; instância nunca conectada não alerta.
- Destinatário compartilhado exige ADMIN ativo, valida um único endereço e gera admin_audit. Falhas anteriores em quedas abertas podem ser recolocadas na fila após corrigir destinatário, preservando todos os eventos anteriores. Testes manuais reservam um intervalo global de 60s com lock antes de enviar SMTP.
- Cada e-mail é reivindicado em transação antes do SMTP, com rechecagem de instância ativa/queda aberta/status/prazo. SMTP não mantém conexão/transação de banco aberta. Resultado e evento são persistidos juntos. A rotina de SMTP tem até 5 tentativas com backoff; uma falha ao persistir um sucesso NÃO entra na retentativa de SMTP.
- O método recoverInterrupted() marca envios em sending como unknown de forma explícita. A composição futura DEVE chamá-lo só uma vez no startup, depois de adquirir propriedade exclusiva do serviço. Não chamá-lo enquanto outro processo está enviando e-mails. Ele não é acionado automaticamente pelo construtor nem pelo roteador.
- Se o e-mail já começou quando há recuperação/desativação, pode terminar: histórico preserva envio e fechamento. Não há promessa de entrega exactly-once pelo SMTP nem confirmação de caixa de entrada. Estado sending/unknown exige conferência e não é reenviado automaticamente.
- Ao desativar, suspeita é descartada e queda em aberto é encerrada por deactivated/monitoring_disabled, sem inventar recuperação. Filas de alertas não selecionam instâncias inativas.
- postgres/serial-tasks.mjs: filas independentes por chave; erro em uma operação não impede as seguintes.
- postgres/auth-state.mjs: adaptador assíncrono de credenciais Baileys, com mesmo formato BufferJSON/AES-GCM/wa_keys do legado, upsert explícito PostgreSQL e conversão de app-state-sync-key. Atualizações são fotografadas no momento da chamada e gravadas em ordem por estado de instância; lote de chaves é atômico. Não usa um pool/conexão permanente por instância.
- invalidate() bloqueia novas gravações e aguarda/desfaz operações em andamento daquele estado, para impedir ressuscitar chaves depois de reset/desativação. O transporte futuro deve invalidar o estado antigo ANTES de apagar/reiniciar a sessão e fornecer valid() associado à geração/propriedade da sessão. O adaptador sozinho NÃO coordena dois processos donos da mesma instância.
- postgres/control-api.mjs passou a aceitar alerts injetado e disponibilizar configuração e teste de e-mail geral, com autoria/CSRF/permissões e erro SMTP seguro. Sem alerts, essas duas rotas retornam false para composição futura; o roteador não cria controlador nem inicia SMTP sozinho.

### Validação
43 testes PostgreSQL locais aprovados e 64 testes SQLite existentes aprovados.
Os novos testes cobrem limite exato de 60s e timer real reduzido, retomada de suspeita após recriar controlador, startup com socket restaurado, quedas terminais, desativação, retry SMTP, concorrência entre reivindicações/testes, falha no banco depois de enviar, e-mail compartilhado por HTTP e autoria real. O log genérico de falha durante o teste de persistência SMTP é provocado intencionalmente.
Credenciais testadas com buffers/instâncias isoladas, persistência/recriação, alteração de objetos enquanto gravação espera, rollback de lote parcial, invalidação durante transação e recuperação após erro na fila. Tudo usa dados sintéticos/PGlite e SMTP simulado. Não houve envio de e-mail real, socket WhatsApp, conversa real, leitura de segredo Railway ou implantação.
As fixtures usam conexões serializadas ao motor embarcado; apesar dos locks e testes com controladores concorrentes, ainda é obrigatório ensaiar com múltiplas conexões PostgreSQL reais.

### Próximo passo concreto
Portar o transporte completo (connect/disconnect/restore/retry/eventos/ACK/webhooks), ligando createPostgresAuthState, await de persistência e invalidação em troca/reset/suspensão. Implementar propriedade exclusiva das sessões e fila de mensagens com reivindicação atômica, rechecagem antes de enviar e estados ambíguos preservados.
Depois portar API de integração e rotas restantes de mensagens/QR/conexão/lifecycle, compor servidor e startup/shutdown/pausa, e executar ensaios completos antes de selecionar backend. Os arquivos operacionais server.mjs/transport.mjs continuam inalterados; produção permanece SQLite.

## Transporte e fila — 19/11/2026, quinta etapa
Mantida a preparação em branch separada, sem deploy, main, importação final, sessões reais, e-mails reais ou alteração de variáveis.

### Implementado
- postgres/transport.mjs: transporte Baileys assíncrono com connect/disconnect/restart/reset/suspend/restore, QR/credenciais, estados, retries limitados, eventos aguardados, envio/recebimento/ACK, LID e caches de contatos/chats/grupos/operações existentes. Usa os helpers de mídia atuais e não atualiza a biblioteca Baileys.
- Operações de ciclo de vida ficam ordenadas por instância; eventos de controle e mensagens têm filas separadas para uma mídia não bloquear a notificação de conexão. Falha de persistência encerra o socket afetado com erro genérico. Callbacks de conexão devem ser de persistência/auditoria, sem iniciar restart/disconnect de dentro do próprio callback (evitar espera circular).
- createPostgresAuthState foi ligado ao transporte: novo estado invalida a geração anterior depois da drenagem; logout/reset limpa somente as próprias chaves. close encerra a recepção, drena eventos já capturados/credenciais/envios/hooks e preserva a sessão sem logout. Operação de rede já iniciada pode terminar; um timeout/queda não é prova de que o destinatário não recebeu.
- Recuperação natural cancela retries obsoletos; 401/440/tentativas esgotadas não reconectam indefinidamente. Contexto humano é mantido durante o pedido/retries e removido depois de confirmar. Suspensão mantém credenciais e auto_connect=0; reativar exige Conectar. Proprietário bloqueado impede abertura/envio/operações, mas desconexão administrativa continua permitida.
- postgres/message-queue.mjs: claim transacional com FOR UPDATE SKIP LOCKED, prioridade, expiração de 24h, reserva do provider_id antes do envio e verificação de instância/proprietário/propriedade imediatamente antes de transmitir. Consumidores concorrentes não reservam a mesma linha. ACK não regride para nível inferior e finalização não sobrescreve confirmação já recebida.
- Envio ambíguo permanece unknown, fora da fila automática; preparação inválida/mídia indisponível vira unsent. Se desativar/bloquear antes de transmitir, a reserva volta à fila de forma explícita. Se perder propriedade/banco, a reserva fica conservadoramente para a recuperação, sem enviar de novo às cegas.
- Recuperação segmentada por instância não altera envios de outras. Recuperação de processo pode marcar voláteis perdidos como unsent; uma simples reconexão no mesmo processo NÃO descarta anexos ainda presentes no relay. Texto e mídia por URL podem continuar em fila; URLs de origem permanecem criptografadas.
- Recebimento deduplicado por instância/provider_id com lock e transação, mantendo IDs públicos e referências. LID conhecido é resolvido por metadados/contatos/wa_keys/lidMapping opcional; desconhecido continua LID com phoneResolved=false. Grupos/author mantêm identidade própria.
- Mídias novas continuam somente no relay temporário, com leitura legada sob demanda. Webhook usa até três tentativas, sem imprimir URL, corpo ou credenciais em erro. Não há outbox durável nem garantia exactly-once para webhook: payload possui ID estável e o receptor deve deduplicar. Mídias/links temporários continuam sujeitos ao TTL/reinício.
- postgres/transport-ownership.mjs: propriedade exclusiva do transporte por banco/schema via advisory lock em conexão dedicada com TLS, heartbeat e prova aleatória adicional. Pool de dados confere pid/chaves no pg_locks antes de operações sensíveis; perda da conexão/lock invalida o dono e encerra os sockets. Usa uma conexão adicional para todo o transporte, não uma por instância. No mesmo processo, o mesmo guard não pode ser usado por dois transportes ativos.
- O guard só coordena os novos processos PostgreSQL no MESMO banco/schema. NÃO impede um serviço antigo SQLite ou uma cópia em outro banco/schema de conectar as mesmas credenciais WhatsApp. A virada exige parar os sockets antigos; não iniciar sessões reais em rehearsal/copiar credenciais para duas aplicações ativas.
- postgres/schema.sql recebeu índices de provider_id, contagem por status e fila pendente/prioridade. Não há coluna/tabela nova na origem SQLite; a importação final em schema novo cria esses índices. Schema PostgreSQL já existente exige revisar aplicação dos índices com usuário de migração; runtime não executa DDL.

### Inicialização/composição futura obrigatória
1. Abrir store PostgreSQL com chave original/usuário restrito e adquirir ownership com URL/schema/TLS do mesmo destino. Não restaurar sockets antes disso.
2. Criar activity/alerts/transport com onConnectionState=alerts.stateChanged e onConnectionEvent=activity.connectionState; appName pode ser assíncrono. Na perda de ownership, parar também alerts e recusar novas mutações/integrações, não apenas encerrar os sockets.
3. Antes de aceitar requisições/restaurar sockets, await transport.recoverInterrupted() e await alerts.recoverInterrupted(). A recuperação do transporte rejeita chamada com instâncias/comandos ativos; a de alertas continua exigindo exclusividade do chamador.
4. Restaurar conexões, iniciar monitoramento com transport.state e só então disponibilizar o servidor completo. Chamadores de connect/disconnect/etc. precisam usar await. POST de envio deve confirmar entrada na fila sem aguardar entrega; tratar a Promise de flush em segundo plano com erro redigido.
5. No encerramento/pausa, bloquear novas requisições mutáveis e drenar requisições em andamento; aguardar transport.close() e alerts.close(), depois ownership.release() e por último store.close(). Não forçar um snapshot final enquanto ainda existem escritores. Hooks/requisições de rede podem demorar; abortar a virada se a drenagem não concluir com segurança.
6. A restrição global de dono não habilita múltiplas réplicas nem comprova capacidade de 100+ sessões. Distribuição futura exige coordenação por instância e ensaio de carga próprio.

### Validação
66 testes PostgreSQL locais aprovados; 64 testes SQLite atuais aprovados. Os 23 testes adicionais cobrem fila/claim/ACK/unknown, prioridade/expiração, bloqueio de proprietário, recuperação segmentada e volátil, propriedade/heartbeat/catálogo PostgreSQL, lifecycle/QR/chaves/reinício, callbacks antigos, mídias, LID/grupos, retries, shutdown e integração com os alertas de 60s.
SQL do guard foi validado no catálogo do motor PGlite; exclusão entre conexões/heartbeat usa cliente simulado. Todos os sockets, webhooks e provedores externos são simulados; fixtures PGlite têm uma conexão serializada. Ainda faltam conexões PostgreSQL reais, WhatsApp real, entrega SMTP, teste de processo/partição de rede e carga 100+.

### Próximo passo concreto
Adaptar a API compatível (token, envio/listagem/filas/settings/mídias/contatos/grupos/chats) e ligar rotas HTTP de mensagens, QR, connect/disconnect e lifecycle ao novo transporte. Depois compor o servidor completo, health/readiness, startup/shutdown e pausa/drenagem, atualizar build e rodar ponta a ponta. server.mjs e transport.mjs operacionais continuam inalterados; definir DATABASE_URL ainda não troca o backend e não autoriza deploy.


## API e comandos do painel — 19/11/2026, sexta etapa
Preparação na mesma branch isolada. Servidor operacional, npm start e Dockerfile continuam apontando ao SQLite; nenhum deploy, importação real ou variável de produção foi alterado.

### Implementado
- postgres/compatibility-api.mjs mantém endpoints de integração, token Bearer/body/query, formulários/JSON/multipart, IDs públicos numéricos e consulta por ID legado, filtros/paginação, settings, QR, contatos/chats/grupos e operações delegadas ao transporte assíncrono.
- Envio aceita texto/link/contatos/localização/vcard e anexos temporários; mídia por URL permanece criptografada. Upload/reuso fica restrito à própria instância. Leitura BLOB legada continua disponível sem persistir anexos novos.
- Após preparar mídia, a transação revalida token, instância ativa e proprietário ativo. Capacidade de fila, limpeza e reenvio usam trava transacional por instância; limpeza não remove mensagens em envio nem recebidas. Reenvio de unknown exige comando explícito, nunca automático.
- Auditoria de sucesso das mutações de fila/settings fica na mesma transação que a mudança. Operações remotas são aguardadas e auditadas separadamente, sem transação SQL aberta durante a rede. Não se gravam token, corpo da conversa nem URL secreta do webhook na auditoria.
- HTTP confirma entrada na fila sem aguardar entrega. Não existe idempotência automática de requisição: repetir um POST após perder a resposta pode criar outra mensagem; referenceId não é único. Integração deve confirmar situação antes de repetir.
- postgres/control-api.mjs agora liga mensagens, QR, connect/disconnect e lifecycle ao transporte injetado. postgres/instances.mjs oferece desativação/reativação auditada, preservando token/chaves/histórico, interrompendo socket e cancelando suspeita de queda. Reativação exige Conectar explícito.
- Visitas comuns continuam sem registro. Aba Mensagens registra messages_viewed com usuário real e mantém busca literal/paginação/autorização. postgres/panel-messages.mjs evita consulta por mensagem para mídias e preserva formatos do painel legado; sent_at do painel mantém o timestamp de criação legado, enquanto a integração usa sent_at efetivo.
- postgres/http.mjs compartilha parsing de corpo/limite e resposta. api-fixture.mjs é somente fixture HTTP de testes, NÃO é servidor operacional.

### Validação
77 testes PostgreSQL locais aprovados e 64 testes SQLite aprovados. Os 11 novos testes exercitam HTTP real em loopback, autenticação e rotação, instância/proprietário bloqueado, desativação durante preparo de anexo, quota concorrente, filtros/IDs/ACK, upload/multipart/reuso, QR PNG/JSON, payloads e autoria dos comandos/acessos. Dados e credenciais sintéticos, PGlite serializado e WhatsApp/SMTP/webhooks simulados. Não comprova conexão TCP/TLS real, exclusão em múltiplas conexões nem capacidade de 100+ sessões.

### Próximo passo concreto
Compor servidor PostgreSQL completo: mídia temporária e estáticos, health/readiness, aquisição/perda de ownership, recuperação/restauração explícita, tratamento de falhas, startup/shutdown e pausa/drenagem HTTP/SMTP/transporte. Depois preparar entrada/build sem ativação automática, ensaiar ponta a ponta e validar PostgreSQL real/TLS/privilégios/backup/restauração/carga. Ainda não está pronto para virada. Parar o serviço SQLite antigo antes de restaurar sessões reais continua obrigatório.


## Composição do servidor — 23/11/2026, sétima etapa
- Criado postgres/server.mjs com createPostgresApp explícito, sem executar ao importar. Liga store, ownership, alertas, transporte, API compatível, painel, estáticos e mídia temporária. Não cria schema/admin nem altera dados da origem SQLite. Requer PUBLIC_URL/origem explícita; configuração de store/ownership usa mesmo URL/schema/TLS.
- Ordem: validar store/chave e privilégios; adquirir ownership e conferir no pool; recuperar transporte e notificações interrompidas; construir roteadores; restaurar conexões quando solicitado; iniciar monitoramento; conferir ownership antes de retornar servidor pronto. Erro de startup fecha recursos em ordem e não devolve servidor utilizável.
- /api/health e /api/ready devolvem somente {ok}, com 503 ao pausar/perder dono. Readiness verifica ownership no banco; Host de infraestrutura é permitido exclusivamente para essas sondas. Não é uma prova de que todos os números estão autenticados ou que SMTP está entregando.
- Host, caminhos codificados/traversal/symlinks, métodos e estáticos são validados; mantidos CSP/no-store/nosniff/referrer e proteção CSRF do painel. Mídia temporária exige chave aleatória, instância e dono ativos; nenhum token aparece na URL do relay.
- server.pause() é uma pausa terminal dessa composição: recusa novas requisições comuns, aguarda handlers admitidos, encerra transporte sem logout e depois alertas, limpa mídia volátil. Mantém banco e ownership abertos até shutdown. Não existe resume HTTP ou endpoint público de pausa; para retomar é necessário novo processo/composição após shutdown.
- server.shutdown() aguarda pause, fecha listener/conexões ociosas, leitura S3 legada, ownership e finalmente store. Chamadas repetidas não repetem limpeza. Se drenagem/fechamento falhar, não libera dono/banco às cegas. Não há timeout que force abandonar escritor; a manutenção deve abortar se não drenar.
- Perda de ownership torna readiness falsa imediatamente, recusa novas operações e inicia fechamento de alertas/transporte. Handlers já admitidos podem concluir/retornar erro; operação remota já iniciada não pode ser desfeita. O guard continua protegendo operações sensíveis da fila. O supervisor futuro deve chamar shutdown e encerrar processo; esta fábrica não instala sinais nem faz process.exit.
- Reativação de conta volta a acionar flush das instâncias informadas pelo repositório. Limite por proprietário é configurável na fábrica (padrão legado 50); preparar 100+ exige definir distribuição/limites e testar recursos, não apenas aumentar número.

### Validação
A suíte PostgreSQL passou a limitar dois arquivos de teste simultâneos, para reduzir o consumo dos motores PGlite embarcados. Uma execução irrestrita encerrou dois processos de teste sem diagnóstico de assertion; a aprovação abaixo corresponde à execução completa com concorrência limitada.
85 testes PostgreSQL locais e 64 SQLite aprovados. Oito novos testes cobrem composição/ordem, HTTP estático/Host/CSRF/caminhos/readiness, pausa com requisição admitida e transporte retido, falha de recuperação, perda de dono no startup/runtime, mídia segregada/bloqueio e composição dos controladores reais com credenciais e socket sintéticos. PostgreSQL PGlite serializado e owner simulado; nenhum banco Railway, número, conversa ou e-mail real acessado.

### Próximo passo concreto
Preparar entrada executável e build específicos sem ativar por DATABASE_URL sozinho; adicionar supervisão de sinais/erro no listen e ensaio de processo completo. npm start, server.mjs e Dockerfile operacionais continuam inalterados e usando SQLite. Depois ensaiar destino PostgreSQL real com TLS/usuário restrito, backup/restore e carga, e planejar a janela de virada. Não fazer merge/main/deploy/importação final antes do aviso do Arroba. Não executar a fábrica contra credenciais reais enquanto serviço SQLite antigo possuir sockets.


## Entrada e build — 24/11/2026, oitava etapa
Preparação somente na branch; main, Dockerfile operacional, npm start e Railway não foram alterados.

### Implementado
- postgres/runtime.mjs valida configuração e supervisiona createPostgresApp; scripts/start-postgres.mjs e npm run start:postgres são a entrada explícita. Importar runtime não abre banco nem inicia serviço.
- PG_RUNTIME_ENABLED=true é obrigatório; DATABASE_URL isolada não ativa a entrada nova. PG_RESTORE_CONNECTIONS aceita somente true/false e tem padrão false. Não existe fallback silencioso para SQLite nem criação de chave/schema/admin.
- Valida origem PUBLIC_URL, porta, schema permitido, pool 1–30, limite por proprietário e TLS com certificado verificado. PG_CA_FILE opcional carrega CA adicional; chave original via DATA_DIR/master.key ou PERSISTENCE_KEY_BASE64, com validação existente. Erros de partida/listen/CA usam mensagens genéricas, sem URL, senha, caminho ou payload nos logs.
- SIGINT/SIGTERM registrados antes do startup: se chegar enquanto compõe, aguarda os recursos, fecha sem abrir listener; se chegar durante listen, aguarda sucesso/falha antes de drenar. Sinais repetidos não forçam process.exit ou abandonam gravações. Erro de bind/listen fecha recursos e define exitCode=1.
- Após listen, erros do servidor e perda de readiness iniciam shutdown com exitCode=1. Monitor a cada 1s usa estado local; ownership mantém heartbeat/verificação PostgreSQL. Se limpeza falhar, sinaliza erro e não força liberar banco/dono; supervisor externo precisa tratar falha/hang e respeitar drenagem.
- Dockerfile.postgres é separado e escolhe entrada PostgreSQL, usa usuário node, CA/ffmpeg e healthcheck existentes. Copia módulos de runtime/manifest/public explicitamente, sem fixtures de PGlite nem ferramenta de transferência. Instala dependências production com lockfile; imagem não contém chave, banco ou sessão.

### Configuração futura (não aplicar em produção agora)
| Variável | Finalidade |
| --- | --- |
| PG_RUNTIME_ENABLED | true para executar entrada PostgreSQL |
| PUBLIC_URL | Origem pública sem caminho |
| DATABASE_URL | Banco de destino, usuário runtime restrito; TLS verificado |
| PG_SCHEMA | wa_app ou wa_rehearsal_* permitido; padrão wa_app |
| DATA_DIR / PERSISTENCE_KEY_BASE64 | Chave original; nunca gerar outra na virada |
| PG_CA_FILE | CA PEM para destino, se necessária |
| PG_RESTORE_CONNECTIONS | true restaura sessões; padrão false |
| PG_POOL_MAX | 1–30, padrão 10, mais conexão dedicada do owner |
| PG_INSTANCE_LIMIT | 1–10000 por proprietário, padrão 50; não comprova capacidade |
| HOST / PORT | Bind, padrões 127.0.0.1 e 3210; imagem usa 0.0.0.0 |

A receita futura de imagem é docker build -f Dockerfile.postgres; a escolha no Railway só deve ocorrer na janela autorizada. Não usar esse comando como evidência de build realizado. Sem PG_RUNTIME_ENABLED, a imagem recusa startup. Mesmo com restauração false, esse runtime NÃO é modo somente leitura: recupera filas/notificações e aceita comandos manuais, podendo enviar e-mails. Ensaiar somente com dados sintéticos isolados e SMTP/socket simulados até autorização específica.

### Validação
94 testes PostgreSQL locais e 64 SQLite aprovados. Nove testes novos cobrem config, opt-in, TLS/limites, sinal antes/durante listen, falha de bind TCP real, readiness, executable em subprocesso sem opt-in, processo filho com listener real/SIGTERM/drenagem e fechamento natural, além da cobertura dos imports relativos na receita Docker. Banco/WhatsApp/SMTP continuam simulados. Não há Docker disponível neste ambiente: receita conferida, mas imagem NÃO foi construída/executada nem dependências npm ci de imagem homologadas.

### Próximo passo concreto
Construir/executar Dockerfile.postgres em ambiente com Docker e dados sintéticos; depois ensaiar PostgreSQL real isolado com TCP/TLS, usuário restrito, importação/cópia autorizada, backup/restauração e múltiplas conexões. Verificar limites/memória/CPU para 100+ instâncias e plano de janela/drenagem/reversão. Testar WhatsApp/SMTP reais somente quando autorizado. Não fazer merge/main/deploy/importação final nem mudar variáveis de produção. A virada exige parar os sockets antigos SQLite antes de restaurar sessões no novo processo.


## Ensaio automatizado isolado — 24/11/2026, nona etapa
- Adicionado .github/workflows/postgres-rehearsal.yml, executado por push em preparacao/postgresql ou manualmente. Permissão contents:read, sem secrets Railway/SES, sem deploy, registro de imagem ou alteração de main. Usa runner efêmero ubuntu, Node e PostgreSQL 17 local em container com certificado TLS sintético de um dia.
- Etapas: npm ci e suítes existentes; construir Dockerfile.postgres; conferir que imagem recusa ativação implícita; iniciar PostgreSQL TLS; executar postgres/real.test.mjs; remover containers ao concluir ou falhar. Teste é limitado a 20min pelo workflow, sem forçar drenagem do serviço de produção (nenhum é iniciado).
- real.test.mjs exige PG_REHEARSAL_ALLOW_CREATE=synthetic-only, URL loopback para banco wa_rehearsal_ci, CA explícita e nome de container wa-pg-ci-*. Não fornecer credenciais Railway ou dados reais. Cria origem SQLite/chave/dados sintéticos temporários, snapshot e schema aleatório; importa com verificações existentes.
- Abre runtime com role aleatória NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS e grants de dados, sem CREATE schema e sem UPDATE/DELETE na auditoria. Confere TLS efetivo no pg_stat_ssl, rejeição sem CA, proteção de Master/DDL, exclusão entre owners em conexões reais, três claims simultâneos em pool e ACK sem regressão.
- Inicia a imagem construída contra esse schema sintético, sem restaurar sessões nem configurar SMTP. Confere readiness/autorização HTTP e docker stop com exit0; retoma ownership após saída. Faz pg_dump/pg_restore reais em segundo banco temporário e compara todas as colunas/linhas das 17 tabelas. Remove somente recursos que criou; nenhum dump/arquivo de chave é publicado como artefato.

### Estado da validação
Local: 95 testes encontrados na suíte PostgreSQL, 94 aprovados e 1 ignorado intencionalmente por ausência do PostgreSQL/Docker isolados; 64 testes SQLite aprovados. YAML e sintaxe do teste conferidos. O skip NÃO é aprovação do ensaio TCP/TLS/imagem/restore.
O workflow foi preparado para execução no GitHub; conferir a execução do commit na aba Actions antes de marcar build/ensaio real como aprovados. Este ambiente ainda não tem Docker/PostgreSQL. Nenhum resultado de CI ou de banco real deve ser presumido a partir dos testes locais. Link: https://github.com/arrobajunior/WA-Arroba/actions/workflows/postgres-rehearsal.yml

### Próximo passo concreto
Acompanhar Actions e corrigir qualquer falha do build/ensaio antes de prosseguir. Depois testar carga/distribuição de 100+ instâncias e validar particularidades de TLS/rede/usuário do destino Railway em ambiente isolado autorizado. Ensaios sintéticos NÃO homologam WhatsApp/SMTP reais, capacidade de 100 sessões ou virada sem interrupção. Main/deploy/variáveis/importação final permanecem bloqueados até aviso do Arroba; preservar sessões/volume e parar sockets SQLite antigos na janela de virada.

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
