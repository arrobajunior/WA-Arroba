# Administração Geral — alertas de conexão

## Uso
1. Entre como ADMIN ou Admin Master e abra **Administração Geral** no menu lateral.
2. Informe um único e-mail (pode ser um grupo de distribuição) e clique em **Salvar e-mail de alerta**.
3. Com SMTP configurado, use **Enviar e-mail de teste**. O teste usa o endereço salvo e fica no log; limitado a um por minuto.
4. Veja **Histórico de alterações** (últimos 100 registros de configuração) e o card separado **Histórico de quedas** (todas as ocorrências por paginação). Atualizar histórico recarrega a tela e mantém os filtros das quedas.
5. No dashboard e na listagem, uma ocorrência aberta aparece em vermelho, com link para gerenciar a instância. A atualização é automática a cada 10s; não acontece enquanto um diálogo de criação está aberto.

## Acesso e auditoria
- Todos os admins veem e alteram a mesma configuração, inclusive quem não é Master.
- USER não acessa configuração/log; só vê os avisos das instâncias às quais já tem acesso.
- Alterações são transacionais e registram ID, nome e e-mail do admin, horário e e-mail anterior/novo. O log não contém credenciais SMTP.
- Não existe API para apagar/editar esse log. Triggers impedem alterações pelas operações comuns do banco; acesso direto administrativo ao arquivo continua fora da proteção da aplicação.

## Quando há alerta
- Só após uma conexão confirmada. Registros existentes são identificados por telefone conhecido, credenciais registradas ou mensagens recebidas/com ACK de servidor/dispositivo/leitura.
- A primeira interrupção recuperável inicia uma espera de 60s; antes de confirmar, não abre ocorrência, não envia e-mail e não acende vermelho. Novas tentativas mantêm o prazo original. Se recuperar a tempo, a suspeita é descartada.
- Se continuar indisponível ao final da tolerância, abre uma ocorrência e inicia o envio. Novas tentativas mantêm essa ocorrência, sem outro e-mail do mesmo episódio.
- Desconexão explícita pelo painel/API, logout/401, sessão substituída/440, tentativas automáticas esgotadas ou novo QR exigido numa instância já conectada geram ocorrência imediata.
- Uma conexão confirmada resolve a ocorrência. Outra queda abre uma nova.
- Logout explícito pelo painel/API também conta como desconexão; encerramento normal do servidor não gera um alerta artificial.
- Um minuto após iniciar, o servidor verifica as instâncias previamente conectadas e abre alerta para as que não restabeleceram conexão.
- Uma instância apagada/resetada antes da implantação, sem nenhum vestígio histórico, não pode ter sua conexão anterior inferida com certeza.

## Envio
Remetente contato@mfrural.com.br; SMTP email-smtp.us-east-1.amazonaws.com:587 com STARTTLS obrigatório, conforme guia fornecido pelo usuário e [documentação Nodemailer](https://nodemailer.com/smtp).
Variáveis de ambiente: SES_SMTP_USER e SES_SMTP_PASS. Nunca gravar valores no GitHub ou usar fallback de credenciais no código.
Email inclui nome/ID/número/responsável da instância, motivo, horário de Brasília e link para abrir o painel. HTML escapa campos dinâmicos; texto alternativo está disponível.

- Sem destino/SMTP: ocorrência permanece visível e aguarda configuração.
- Falha confirmada de SMTP: até 5 tentativas com espera crescente; histórico mostra código resumido, sem resposta bruta contendo dados sensíveis.
- Após 5 falhas: fica marcada para intervenção. Salvar o destinatário novamente reinicia a fila de ocorrências abertas com falha; e-mails já enviados não são repetidos.
- Envio interrompido por reinício fica **sem confirmação**, sem repetição automática para evitar duplicidade; confira a caixa do destinatário e o log.
- Recuperação antes do início de um envio cancela o e-mail pendente. Uma transmissão já iniciada pode terminar após a recuperação.
- SMTP aceito é confirmação de aceitação pelo provedor, não prova de entrega na caixa de entrada. Verifique spam/rejeições.

## Estado no fim desta implementação
Código e testes completos; implantação da Administração Geral (a88ef44) confirmada como SUCCESS. Após autorização explícita do usuário em 18/11/2026, SES_SMTP_USER e SES_SMTP_PASS foram cadastradas no serviço Railway WA-Arroba/production, sem publicar valores. Esta atualização documental dispara implantação para aplicar as variáveis. Destinatário será escolhido/conferido no painel pelo admin e o botão de teste deve homologar o envio real. Não foi desconectada uma instância real para testar.

## Arquivos e validação
alert-email.mjs: template e SMTP. connection-alerts.mjs: fila/ocorrências/log. store.mjs: migrações aditivas. transport.mjs: eventos de conexão. server.mjs: endpoints com autenticação/CSRF. public/: painel.
Endpoints: GET/PATCH /api/general-admin e POST /api/general-admin/test-email, com sessão ADMIN e proteção CSRF para gravações.
npm test: 42 testes com SMTP/WhatsApp simulados, incluindo isolamento USER, compartilhamento ADMIN, log, repetição, reinício, falhas, recuperação e não duplicação.

## Histórico de quedas e investigação de padrões
Todos os ADMINs podem consultar, inclusive quem não é Master. USER não acessa esses endpoints. Não há ação para apagar ocorrências ou sua linha do tempo.

| Informação | Registro |
|---|---|
| Instância | Nome, número, ID e responsável capturados na abertura |
| Tempos | Início, recuperação, duração sem conexão, última confirmação de conexão, último evento |
| Contexto técnico | Origem (WhatsApp, ação painel/API, verificação após reinício, falha de inicialização), código numérico quando fornecido, tentativas automáticas |
| Implantação | ID de deployment/commit quando as variáveis correspondentes estiverem disponíveis; nunca captura o ambiente completo |
| E-mail | Estado real, destinatário usado, horário de aceitação, ID SMTP, tentativas no ciclo atual e código resumido da última falha |
| Linha do tempo | Abertura, mudanças, reconexão, tentativa de e-mail, aceitação/falha, cancelamento e reentrada na fila |

Filtros: classificação (quedas confirmadas por padrão; reconexões breves anteriores; todos), instância, datas inclusivas de início/fim da queda em horário de Brasília, conexão em aberto/resolvida e estado do e-mail. A consulta retorna 25 ocorrências por página na interface. **Ver detalhes** abre a linha do tempo, com opção de carregar mais eventos. O histórico persiste após reconectar e reiniciar.
Os resumos de quedas/recuperações/e-mails e as recorrências por instância, motivo e hora consideram todo o conjunto filtrado, incluindo páginas não exibidas. Um padrão de horário não comprova a causa. Tentativas de reconectar pertencem à mesma ocorrência e não geram novos e-mails até recuperação e nova queda.
As tentativas de e-mail mostradas no resumo da ocorrência são do ciclo atual (podem reiniciar ao salvar novamente o destinatário); a linha do tempo preserva as tentativas registradas dos ciclos anteriores.
As novas capturas não reconstroem o passado: ocorrências antigas são marcadas como **registro anterior ao histórico detalhado**, não recebem horário de envio/código fictícios e podem ter identificação reconstituída do cadastro existente na migração.

Endpoints ADMIN autenticados:
- GET /api/general-admin/incidents?instance_id=&from=AAAA-MM-DD&to=AAAA-MM-DD&status=all|open|resolved&email_status=all|sent|...&page=1&limit=25
- GET /api/general-admin/incidents/{id}?page=1&limit=100

Limite máximo por página de API: 100. Os eventos são paginados em ordem de registro. A aplicação não grava stack traces, tokens ou respostas brutas de autenticação no histórico. O registro **enviado ao SES** indica aceitação SMTP, não confirmação de chegada na caixa do destinatário.
Validação da expansão: 46 testes automatizados, incluindo mais de 100 ocorrências, paginação de eventos, fronteiras de dia de Brasília, preservação histórica, snapshots após renomear, permissões e não duplicação; teste DOM cobre navegação de filtros/detalhes/páginas.

## Correção de reconexões breves (19/11/2026)
A espera de 60s é implementada antes da criação da ocorrência, não apenas como atraso do SMTP. connection_candidates guarda horário inicial, vencimento, metadados permitidos, identidade da instância e tentativas durante a espera; nunca guarda o contexto completo de credenciais/autenticação. O timer confirma interrupções persistentes mesmo sem novo evento do socket. Tentativas não renovam o vencimento.
Se recuperar antes do prazo, a suspeita é removida e nenhuma ocorrência/e-mail é gerada. Se a recuperação chegar após o limite antes que o timer rode, a interrupção prolongada é registrada e resolvida, mas um e-mail ainda não iniciado é cancelado. Envios SMTP já iniciados não podem ser desfeitos.
O serviço aguarda a restauração das sessões na inicialização antes de promover suspeitas antigas; a primeira detecção permanece registrada. A auditoria recebe apenas eventos de conexão relevantes/confirmados; ações humanas e mudanças de número permanecem rastreadas.

### Registros anteriores e classificação
outage_kind distingue confirmed e transient. Na primeira migração desta versão, ocorrências já resolvidas em menos de 60s, com fonte whatsapp e códigos recuperáveis 408/428/500/503/515, são classificadas como reconexões breves anteriores. Usa limite em milissegundos para não classificar 60s exatos como breve. Não modifica autoria, datas ou e-mails enviados; não remove eventos imutáveis da auditoria. Registros não identificáveis com segurança continuam confirmados.
O filtro padrão usa kind=confirmed; kind=transient mostra os registros breves anteriores com aviso; kind=all reúne ambos. Resumos e recorrências respeitam a classificação. A migração não repete/reenvia os e-mails antigos. Instâncias manualmente desconectadas e sessões encerradas continuam em alerta.
Verificação: 61 testes aprovados, incluindo reconexões de 3s/10s, alerta após 60s, prazo que não reinicia, persistência após recriar o processo, timer autônomo, desconexões terminais, separação conservadora de registros anteriores e manutenção da auditoria de troca de número.

## Instâncias desativadas — 19/11/2026
Instâncias inativas não são reconciliadas nem promovem suspeitas de queda ou novos alertas. Desativar encerra ocorrência aberta com resolution_reason=deactivated, preserva e-mails e histórico e não registra recuperação falsa. Reativação exige conexão explícita. Veja INSTANCIAS.md.
