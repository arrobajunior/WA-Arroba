# Administração Geral — alertas de conexão

## Uso
1. Entre como ADMIN ou Admin Master e abra **Administração Geral** no menu lateral.
2. Informe um único e-mail (pode ser um grupo de distribuição) e clique em **Salvar e-mail de alerta**.
3. Com SMTP configurado, use **Enviar e-mail de teste**. O teste usa o endereço salvo e fica no log; limitado a um por minuto.
4. Veja **Histórico de alterações** e **Quedas e envio de alertas** na mesma página. Exibem os últimos 100 registros; os anteriores continuam no banco. Atualizar histórico recarrega a tela.
5. No dashboard e na listagem, uma ocorrência aberta aparece em vermelho, com link para gerenciar a instância. A atualização é automática a cada 10s; não acontece enquanto um diálogo de criação está aberto.

## Acesso e auditoria
- Todos os admins veem e alteram a mesma configuração, inclusive quem não é Master.
- USER não acessa configuração/log; só vê os avisos das instâncias às quais já tem acesso.
- Alterações são transacionais e registram ID, nome e e-mail do admin, horário e e-mail anterior/novo. O log não contém credenciais SMTP.
- Não existe API para apagar/editar esse log. Triggers impedem alterações pelas operações comuns do banco; acesso direto administrativo ao arquivo continua fora da proteção da aplicação.

## Quando há alerta
- Só após uma conexão confirmada. Registros existentes são identificados por telefone conhecido, credenciais registradas ou mensagens recebidas/com ACK de servidor/dispositivo/leitura.
- A primeira queda abre uma ocorrência. As tentativas de reconexão e QR subsequentes mantêm a mesma ocorrência.
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
Código e testes completos. O envio de credenciais ao serviço Railway foi bloqueado pela revisão automática até autorização explícita para WA-Arroba/production; nenhuma credencial foi publicada. Destinatário será escolhido no painel pelo admin. Não foi enviado e-mail real nem desconectada uma instância real para teste.

## Arquivos e validação
alert-email.mjs: template e SMTP. connection-alerts.mjs: fila/ocorrências/log. store.mjs: migrações aditivas. transport.mjs: eventos de conexão. server.mjs: endpoints com autenticação/CSRF. public/: painel.
Endpoints: GET/PATCH /api/general-admin e POST /api/general-admin/test-email, com sessão ADMIN e proteção CSRF para gravações.
npm test: 42 testes com SMTP/WhatsApp simulados, incluindo isolamento USER, compartilhamento ADMIN, log, repetição, reinício, falhas, recuperação e não duplicação.
