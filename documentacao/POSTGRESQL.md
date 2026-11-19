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
npm run test:postgres: 17 testes (6 de transferência + 11 da camada assíncrona/repositórios). Usam PostgreSQL embarcado PGlite com dados sintéticos; concorrência entre conexões também tem teste de isolamento com pool simulado. Cobrem backup/WAL, chaves, blobs, Unicode, IDs, rollback, privilégios, auditoria, horários e erros sem conteúdo sensível.
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
