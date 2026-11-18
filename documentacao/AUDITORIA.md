# Auditoria de atividades e segurança

## Onde consultar
- Na instância: **Gerenciar → Histórico e segurança**.
- No menu **Administração Geral**: card **Log de atividades e segurança**.
- Eventos paginados, com filtros por pessoa, ação, resultado, origem da autoria e período (Brasília). O log central também filtra instância.
- ADMIN consulta todas as instâncias; USER consulta apenas instâncias próprias. Opções de filtros da consulta individual também são limitadas àquela instância.
- Cada registro tem horário, executor, e-mail/perfil na época, instância/nome na época, ação, resultado e detalhes. **Ver registro** expande antes/depois/contexto.

## Eventos cobertos
| Área | Eventos |
|---|---|
| Instância | Criação e consulta de mensagens; simples abertura da instância não gera log |
| Configuração | Nome/webhook pelo painel; configurações de webhook/fila pela API compatível |
| Credenciais | Pedido de mostrar/copiar token e renovação; nenhum valor do token é salvo |
| Conexão | Solicitação de conexão/desconexão, QR disponível, queda, tentativa automática e confirmação |
| Número | Número anterior/novo quando a conexão efetivamente confirma uma troca |
| Integrações | Comandos POST autenticados suportados, incluindo reset/restart/logout, envio/reenvio/exclusão e ações de contato/chat; QR GET que inicia conexão |
| Geral | Mudança do e-mail de alerta e solicitação/resultado de teste, além do log anterior de configuração |
| Permissão | Tentativa autenticada de acessar instância de outra pessoa, negada pelo servidor |

Consultas automáticas de status/QR pelo painel não geram um registro a cada polling. A leitura do histórico não se autorregistra em loop. Por preferência explícita do usuário, abrir/consultar os dados gerais da instância não gera mais registro. A consulta de Mensagens (inclusive filtros/atualização manual) gera messages_viewed. Mostrar/Copiar token continuam registrados como solicitações. Registros instance_viewed anteriores são preservados, mas não são mais gerados pela visita normal. Uma solicitação de cópia não é prova de sucesso do clipboard do navegador.

## Autoria e confirmação
- **Usuário autenticado:** ID/nome/e-mail/perfil vêm da sessão no servidor; não de campos enviados pelo navegador.
- **Integração (token):** identificada por instância. Quem possui o token não pode ser identificado como um usuário humano só por isso; não se atribui ao dono da instância.
- **Sistema automático:** eventos do WhatsApp, reconexões e verificações sem contexto de pedido humano.
- **Registro anterior:** importação de criação/quedas sem autoria histórica conhecida.

Operações mutáveis registram solicitação e resultado com um ID comum de correlação. Falhas guardam código resumido e status, não a mensagem bruta do erro. Em operações de conexão, aceitação do pedido e confirmação do WhatsApp são eventos distintos. Uma solicitação registrada sem resultado permanece evidência da tentativa, não prova de conclusão.
Quando um pedido inicia o pareamento no processo atual, o contexto acompanha as tentativas até a primeira confirmação. A interface indica **Vinculado à solicitação deste usuário**; isso não identifica quem fisicamente escaneou o QR. O contexto é descartado após confirmar para não atribuir reconexões futuras ao mesmo admin. Após reinício do processo, sem contexto comprovável, a confirmação é do sistema; o pedido original continua no histórico.
O número anterior confirmado persiste em last_connected_phone mesmo após logout/reset, permitindo observar a próxima troca.

## Dados sensíveis e retenção
- Senhas, tokens antigos/novos, QR Codes, conteúdo de mensagens e corpos arbitrários de requisição não são gravados na auditoria.
- Webhook guarda somente a origem (protocolo/domínio) e impressão digital SHA-256 da URL completa, permitindo comprovar mudança sem expor senha, rota ou query. Antes/depois do webhook não permitem reconstruir o endereço; a configuração atual continua na tela de webhook.
- IP é req.socket.remoteAddress, sem confiar em X-Forwarded-For enviado pelo cliente; pode identificar um proxy, não o IP final do operador.
- Não há endpoint/botão para editar/apagar logs. Triggers rejeitam UPDATE/DELETE; reset e limpeza de mensagens não removem a tabela. A proteção é da aplicação/SQLite, não contra um operador com controle total do host/arquivo que remova as proteções.
- Migrações são aditivas; volume, usuários, tokens e sessões existentes são preservados. Backups do banco incluem o histórico.

## Histórico anterior
Migração única importa a data de criação original das instâncias, quedas/recuperações já armazenadas e registros anteriores de alteração/teste de e-mail. A criação anterior não tem executor conhecido; não se usa o responsável atual como autor. Nome de instância importado pode ser o disponível na migração; o registro recebe marca histórica. Ações antigas que nunca foram coletadas não podem ser recuperadas.

## Implementação e endpoints
- instance-activity.mjs: registro, snapshots seguros, correlação, eventos de conexão e consulta.
- store.mjs: instance_activity, índices/triggers, schema_migrations e migração histórica única.
- server.mjs: rotas de painel, permissões e eventos com sessão autenticada.
- compatibility-api.mjs: operações de integração, com token válido, registradas como API; grava apenas comando/resultado e snapshots permitidos de configuração.
- transport.mjs: contexto explícito do pedido de conexão e número confirmado; contexto removido após primeira confirmação.
- public/app.js e style.css: aba e card central.

GET /api/instances/{id}/activity — exige proprietário ou ADMIN; ignorar outro instance_id na query é intencional para manter o escopo fixo.
GET /api/general-admin/activity — exige ADMIN.
POST /api/instances/{id}/credential-access — action reveal|copy; exige proprietário/ADMIN e proteção CSRF; registra solicitação sem devolver/gravar o token.
Consultas aceitam page (padrão 1), limit (padrão 25, máximo 100), actor_id, action, outcome, actor_kind, from e to. O central aceita instance_id. Datas são inclusivas no horário de Brasília. Não existe remoção de registros pela API.

## Verificação
npm test: 52 testes aprovados. Cobrem autoria de admins e usuários, histórico restrito, filtros, integração separada, falhas/negações, antes/depois, troca real de número confirmada em socket simulado, correlação que não vaza para reconexões, ausência de segredos, paginação, migração única, triggers e preservação em reset/reinício.
DOM local verificou aba, mostrar/renovar token, log central, filtros, paginação e regressão do histórico de quedas. WhatsApp/SMTP foram simulados. A homologação de ações no painel real é o próximo passo; esta mudança não desconectou nenhum canal real para teste.
