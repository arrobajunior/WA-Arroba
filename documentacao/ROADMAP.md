# Roadmap e ponto de retomada

## Implementado
- [x] Gateway e comandos de integração descritos em COMPATIBILITY.md.
- [x] Diagnosticar @lid no from do webhook.
- [x] Resolver associações de telefone conhecidas e persistir por instância.
- [x] Preservar identidade original e indicar ausência de resolução.
- [x] Documentar continuidade na raiz e nesta pasta.

## Próximo passo — homologação com TI
1. Confirmar que Railway implantou o commit que contém esta documentação e a resolução de LID; verificar saúde e conexão WhatsApp.
2. Solicitar mensagem de teste de um telefone conhecido e comparar data.from com o telefone real. Não reutilizar a mensagem antiga esperando que seja reenviada automaticamente.
3. Se chegar phoneResolved=false, verificar se a sessão recebeu senderPn, contatos com lid/jid ou chats.phoneNumberShare. O payload antigo sozinho não permite descobrir o telefone.
4. Validar resposta do sistema cliente, anexos, ACKs e reconexão.
5. Registrar aqui resultado, data e próximo passo. Sem payloads pessoais nem tokens.

## Critérios de aceite
- Conversa individual com associação comprovada: from contém telefone@c.us.
- Sem associação: mantém LID e phoneResolved=false; receptor não usa os dígitos do LID como telefone.
- Grupos preservam @g.us; identidade de participante é independente.
- Associações persistem no reinício e não vazam entre instâncias.
- Sem regressão no envio e nas referências de mensagens.

## Verificação local
node --test transport.test.mjs: 13 testes aprovados, incluindo regressão de LID; sockets e webhooks simulados, sem WhatsApp real.
Não foi feita atualização da biblioteca Baileys.

## Evoluções pendentes
- Avaliar tratamento do cliente quando telefone não estiver disponível (fila/reprocessamento após aprender associação).
- Avaliar cobertura e necessidade de atualizar Baileys em trabalho separado, com validação de sessões.
- Avaliar unificação de identidade em histórico/consultas e ações; fora desta correção de payload.
- Manter limites de compatibilidade, operação e armazenamento documentados.

## Administração Geral — ponto de retomada
- [x] Configuração compartilhada, acesso ADMIN, log imutável pela aplicação.
- [x] Histórico persistente, deduplicação, recuperação e retentativas de e-mail.
- [x] E-mail HTML de alerta, texto alternativo e botão de teste auditado.
- [x] Destaque vermelho no dashboard/listagem e atualização automática.
- [x] 42 testes automatizados aprovados.
- [x] Autorização explícita recebida para cadastrar as credenciais SES no serviço Railway WA-Arroba/production.
- [x] SES_SMTP_USER e SES_SMTP_PASS cadastradas no serviço, sem publicar valores.
- [ ] Admin cadastrar e-mail em Administração Geral e usar Enviar e-mail de teste.
- [ ] Homologar queda/recuperação com uma instância de teste já pareada, sem desconectar canais reais apenas para testar.
- [x] Implantação da Administração Geral (a88ef44) confirmada como SUCCESS.
- [ ] Confirmar implantação que aplica as novas variáveis SMTP e registrar resultado do envio real. Variáveis cadastradas não comprovam autenticação SMTP nem entrega de e-mail.

## Histórico detalhado — ponto de retomada
- [x] Card independente com todas as quedas paginadas e filtros.
- [x] Detalhes com duração, recuperação, código/origem e identidade capturada na queda.
- [x] Linha do tempo de conexão e envio de e-mails, também paginada.
- [x] Resumos e frequências no conjunto completo filtrado.
- [x] Migração preserva registros antigos e informa os limites de dados não coletados.
- [x] 46 testes aprovados e navegação/filtros/detalhes verificados em DOM local.
- [x] Implantação SMTP 0333f587 confirmada como SUCCESS antes desta alteração.
- [ ] Confirmar implantação desta expansão no Railway e homologar com ocorrências reais futuras; os novos detalhes técnicos só existem a partir desta versão.
- [ ] Homologar autenticação SMTP/entrega usando o destinatário configurado, sem inventar confirmação a partir do cadastro de variáveis.

## Auditoria de atividades — ponto de retomada
- [x] Aba por instância e log central paginados, com filtros por pessoa/ação/resultado/data/origem da autoria.
- [x] Criação/acesso/configuração/token e solicitações de conexão/desconexão auditados no servidor.
- [x] Integrações autenticadas e eventos automáticos identificados separadamente de usuários.
- [x] Confirmação de número e troca do número conectado, com anterior/novo e correlação explícita com a solicitação quando disponível.
- [x] Logs não incluem valores de tokens, senhas, QR, mensagens ou URL completa de webhook.
- [x] Registros protegidos contra edição/exclusão pela aplicação e preservados em reset/reinício.
- [x] Migração histórica sem inventar autoria, permissões e isolamento de filtros USER verificados.
- [x] 52 testes aprovados e interface verificada em DOM local.
- [x] Implantação anterior 6c791cf do histórico de quedas confirmada como SUCCESS.
- [ ] Confirmar implantação desta auditoria no Railway e validar no painel com ações reais autorizadas. Não desconectar instâncias de produção apenas para testar.
- [ ] Homologação SMTP/entrega real continua dependendo do destinatário e botão de teste já existentes; cadastro de variáveis não comprova entrega.

## Preferência atual de registro de acessos
- [x] Simples visita à instância não gera novo log; não reintroduzir instance_viewed.
- [x] Acesso à aba/consulta de Mensagens continua gerando messages_viewed.
- [x] Manter auditoria de ações e preservar registros antigos.

## Tolerância de reconexão — regra prioritária atual
- [x] Recuperação automática em menos de 60s não gera e-mail/queda/vermelho nem par redundante na auditoria.
- [x] Prazo persistido; retries não reiniciam a contagem; confirma queda persistente sem depender de novo evento de socket.
- [x] Desconexão explícita, sessão encerrada/substituída, QR exigido e tentativas esgotadas continuam imediatos.
- [x] Classificação conservadora de ocorrências breves anteriores, preservando histórico/e-mails e sessão intencionalmente desconectada.
- [x] Filtro padrão de quedas confirmadas e opção para consultar reconexões breves anteriores.
- [x] 61 testes aprovados; limites de tempo, persistência, auditoria e regressões de interface verificados.
- [ ] Confirmar implantação e observar ocorrências reais futuras: a estação intencionalmente desconectada deve permanecer em alerta; reconexões de poucos segundos não devem disparar novos e-mails.
- [ ] Não remover a tolerância nem voltar a enviar no primeiro close. Não apagar registros/e-mails antigos para esconder falsos positivos.

## Nome e desativação — ponto atual de retomada
- [x] Nome editável com identidade técnica preservada.
- [x] Desativação/reativação auditada e abas separadas.
- [x] Bloqueio de API e reconexões, preservando dados/chaves/fila.
- [x] Quedas encerradas por desativação separadas de reconexão.
- [x] 64 testes automatizados aprovados.
- [ ] Conferir implantação deste recurso e homologar com instância de teste autorizada; reativar não conecta sozinho.
- [ ] Registrar resultados operacionais futuros sem tokens nem dados pessoais.

## PostgreSQL — prioridade atual, sem implantação autorizada
- [x] Preparação em branch separada, sem main/deploy.
- [x] Schema de 17 tabelas, importação transacional, backup consistente e verificação de todas as tabelas/chaves/IDs.
- [x] 6 testes da transferência em motor PostgreSQL embarcado com dados sintéticos.
- [ ] Portar acesso síncrono SQLite para PostgreSQL assíncrono, sem bloquear o event loop.
- [ ] Suíte operacional completa no PostgreSQL, pausa/drenagem, fila e retomada sem duplicidade.
- [ ] Validar banco privado Railway/usuário restrito, chave e backup/restauração reais.
- [ ] Aguardar aviso do Arroba antes de publicar main ou executar qualquer virada.
- [ ] Segurança de conversas (MFA/permissão própria/criptografia/retenção) e capacidade de 100+ sessões: ainda não implementadas nem homologadas.
- [ ] Seguir o roteiro e os bloqueios de POSTGRESQL.md; variáveis sozinhas não mudam o backend.

## Adaptação PostgreSQL — segunda etapa iniciada
- [x] Cliente assíncrono, pool limitado, transação por conexão, erros sem conteúdo/URL, limites de tempo e inteiros seguros.
- [x] Leitura da chave original sem regeneração e store com validação de privilégio/schema/triggers/credenciais.
- [x] Auditoria e histórico de quedas portados para repositórios PostgreSQL assíncronos.
- [x] 17 testes PostgreSQL locais e 64 testes SQLite aprovados.
- [ ] Próximo imediato: autenticação/usuários, instâncias, branding e rotas HTTP usando await.
- [ ] Portar alertas e transporte/fila/wa_keys, preservando ordenação e proprietário único da sessão.
- [ ] Seleção explícita do backend, pausa/drenagem, teste completo em PostgreSQL real, backup e restauração.
- [ ] Publicação/virada SOMENTE após aviso do Arroba; até lá continuar na branch preparacao/postgresql.

## PostgreSQL — cadastro e controle preparados
- [x] Login/sessões/usuários assíncronos, proteção Master e revogação de sessões.
- [x] Cadastro/lista/detalhes/nome/webhook/token de instância com autoria e quota atômica.
- [x] Listagem/dashboard com contagens e alertas em lote; identidade visual assíncrona.
- [x] Roteador HTTP preparatório e 26 testes PostgreSQL locais; 64 testes SQLite preservados.
- [ ] Próximo: alertas de 60s e transporte/fila/wa_keys com ordenação e proprietário único por sessão.
- [ ] API de integração e rotas de mensagens/QR/conexão/lifecycle; composição de servidor completo.
- [ ] Banco Railway real, HTTPS/TLS, pausa/drenagem, recuperação e capacidade 100+ continuam sem homologação.
- [ ] Não publicar main/deploy nem importar dados reais antes de concluir as validações e receber o aviso de virada.

## PostgreSQL — alertas e credenciais preparados
- [x] Alertas assíncronos com tolerância contínua de 60s, persistência e retomada.
- [x] Claim de e-mail, retry limitado, envio ambíguo sem duplicação automática e desativação sem recuperação falsa.
- [x] Configuração/teste de e-mail geral via roteador preparatório, com autoria real e permissão ADMIN.
- [x] Adapter Baileys/wa_keys criptografado, lote atômico, snapshots e invalidação de gravações obsoletas.
- [x] 43 testes PostgreSQL locais e 64 testes SQLite aprovados.
- [ ] Próximo: transporte completo e dono exclusivo da sessão; fila de mensagens/ACK/webhooks sem duplicidade.
- [ ] API compatível e rotas de mensagens/QR/conexão/lifecycle, startup/shutdown e pausa/drenagem.
- [ ] recoverInterrupted somente após adquirir propriedade exclusiva; nunca executá-lo em paralelo com SMTP ativo.
- [ ] Ensaiar múltiplas conexões reais, Railway/TLS, restauração e carga; não fazer merge/deploy ou virada ainda.

## PostgreSQL — transporte/fila preparados
- [x] Transporte Baileys assíncrono com auth-state, lifecycle interno, QR, retry, LID, ACK, mídia e operações de cache.
- [x] Fila com claim atômico, prioridade/expiração, recuperação segmentada, envio ambíguo sem reenvio e rechecagem de acesso.
- [x] Propriedade exclusiva por banco/schema com conexão dedicada e fechamento em perda do lock.
- [x] 66 testes PostgreSQL locais e 64 testes SQLite aprovados; serviços externos/sockets simulados.
- [ ] Próximo: API compatível (token/envio/mídias/settings/chats/grupos/contatos) e rotas HTTP de mensagens/QR/conexão/lifecycle.
- [ ] Compor servidor completo, readiness, startup/shutdown/pausa, build e ensaio ponta a ponta.
- [ ] Na perda do guard, parar alerts e HTTP mutável; antes de liberar guard, drenar transporte/SMTP.
- [ ] Parar serviço SQLite antigo antes de restaurar sessões PostgreSQL; guard não protege contra ele ou cópias em schemas diferentes.
- [ ] Não fazer merge/deploy/virada ainda. Banco/TLS/WhatsApp reais, teste de carga e restauração continuam pendentes.

## PostgreSQL — API e lifecycle HTTP preparados
- [x] API compatível assíncrona, tokens/IDs/filtros/settings, anexos e operações do transporte.
- [x] Revalidação de acesso após mídia, quota/limpeza/reenvio e auditoria transacional.
- [x] Rotas do painel de mensagens/QR/connect/disconnect/desativar/reativar; visita comum sem log, aba Mensagens auditada.
- [x] 77 testes PostgreSQL locais e 64 SQLite aprovados com dados sintéticos.
- [ ] Próximo: servidor completo, estáticos/mídia, readiness, ownership, recuperação, startup/shutdown e pausa/drenagem HTTP/SMTP/transporte.
- [ ] Preparar entrada/build sem ativação automática e ensaiar composição ponta a ponta.
- [ ] Validar PostgreSQL TCP/TLS/privilégios/backup/restauração, WhatsApp real e carga 100+ antes da virada autorizada. Não fazer merge/deploy ainda.

## PostgreSQL — composição concluída em preparação
- [x] Fábrica de servidor com API/painel/estáticos/mídia e startup ordenado por ownership/recuperação/restauração.
- [x] Readiness, pausa terminal com drenagem HTTP/transporte/alertas e shutdown ordenado; bloqueio imediato em perda de dono.
- [x] 85 testes PostgreSQL locais e 64 SQLite aprovados; sem serviços reais.
- [ ] Próximo: entrada executável/build específicos, supervisão de sinais/erro de listen e ensaio de processo, sem ativação por DATABASE_URL isolada.
- [ ] Validar PostgreSQL real/TLS/privilégios/backup/restauração, limite/distribuição e carga 100+, WhatsApp/SMTP reais em janela autorizada.
- [ ] Não fazer merge/main/deploy/importação final antes do aviso do Arroba. Serviço SQLite antigo deve parar sockets antes de restaurar sessões reais no PostgreSQL.

## PostgreSQL — entrada e build separados preparados
- [x] start:postgres/runtime e Dockerfile.postgres com opt-in, config/TLS e restauração explícita.
- [x] Supervisão de sinais durante startup/listen, erros TCP/readiness e shutdown sem encerrar escritor à força.
- [x] 94 testes PostgreSQL e 64 SQLite locais aprovados; subprocesso TCP/SIGTERM e imports de build conferidos.
- [ ] Construir e executar imagem Docker isolada; Docker indisponível neste ambiente, build ainda não homologado.
- [ ] PostgreSQL real isolado: TLS/privilégios/importação autorizada/backup/restore/múltiplas conexões, depois carga 100+ e recursos.
- [ ] Planejar janela/reversão e testes reais autorizados. Não fazer merge/main/deploy/migração final ou alterar variáveis de produção ainda.

## PostgreSQL — ensaio automatizado preparado
- [x] Workflow sem secrets/deploy para construir imagem e testar PostgreSQL local TLS com dados sintéticos.
- [x] Ensaio de permissões/owner concorrente/claim/ACK, HTTP da imagem e dump/restore das 17 tabelas.
- [x] Local: 94 PG aprovados, 1 ensaio real ignorado, 64 SQLite aprovados; YAML/sintaxe conferidos.
- [ ] Conferir aprovação real do workflow Actions do commit; corrigir qualquer falha antes de considerar imagem/TCP/TLS/restore homologados.
- [ ] Carga100+ e validação do destino isolado autorizado; depois planejar janela/reversão e homologar WhatsApp/SMTP com autorização.
- [ ] Não fazer merge/deploy/importação final ou mudar variáveis de produção ainda.

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
