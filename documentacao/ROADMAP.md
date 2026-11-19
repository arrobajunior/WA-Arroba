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
