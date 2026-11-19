# Preparação para PostgreSQL — NÃO IMPLANTAR AINDA

Data: 19/11/2026. Base: ccc85f1237567c08fba5df4f506e8c09ae44645f.
Autorização atual: adiantar código e testes em branch separada. Não alterar main, iniciar deploy, importar dados de produção nem mudar variáveis do serviço antes de novo aviso do Arroba.

## Estado real
Esta etapa prepara a transferência e sua validação. **A aplicação continua usando SQLite. A fundação assíncrona e os repositórios de auditoria/quedas foram implementados nesta branch, mas ainda não estão ligados ao servidor operacional. Não basta fazer merge nem definir DATABASE_URL.**
Não houve acesso a conversas reais, leitura de segredos, conexão ao PostgreSQL da Railway ou migração de produção nesta preparação.

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
npm run test:postgres: 43 testes (6 de transferência + 11 da camada assíncrona/repositórios + 10 de controle/HTTP + 10 de alertas + 6 de credenciais/ordenação). Usam PostgreSQL embarcado PGlite com dados sintéticos; concorrência entre conexões também tem teste de isolamento com pool simulado. Cobrem backup/WAL, chaves, blobs, Unicode, IDs, rollback, privilégios, auditoria, horários e erros sem conteúdo sensível.
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
