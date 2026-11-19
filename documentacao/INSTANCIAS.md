# Nome, desativação e reativação de instâncias

Implementado em 19/11/2026.

## Uso no painel
Em Gerenciar → Conexão e credenciais, o primeiro card permite salvar o nome. É um rótulo visual: ID, token e URL da API não mudam. Registros históricos mantêm o nome capturado na ocasião.

O botão Desativar instância pede confirmação e move a instância para Instâncias → Desativadas. A lista e o dashboard normais mostram apenas ativas. O proprietário e os administradores autorizados podem gerenciar o cadastro; o isolamento entre usuários continua aplicado.

Desativar interrompe o socket e novas operações da API, suspende reconexões automáticas e alertas. Preserva token, configurações, mensagens, histórico e chaves criptografadas da sessão. Não executa logout no WhatsApp. Envios já iniciados podem terminar. Mensagens em fila permanecem guardadas.

Reativar devolve à lista ativa, mas NÃO conecta automaticamente. Use Conectar para retomar; mensagens pendentes podem voltar a ser processadas quando conectar. Se a sessão tiver expirado no WhatsApp, será necessário novo QR.

## Monitoramento e segurança
Desativação cancela suspeita de queda pendente e encerra ocorrência aberta com resolution_reason=deactivated e evento monitoring_disabled, sem inventar reconexão. E-mails já enviados e registros anteriores permanecem; um envio SMTP já iniciado pode terminar. O histórico separa Reconectadas de Encerradas por desativação.

Renomear, desativar e reativar são auditados com autor autenticado, horário e valores anteriores/novos. Apenas visitar Gerenciar continua sem log; consultar Mensagens continua auditado.

## Contrato interno
GET /api/instances?state=active|disabled|all (padrão active) retorna também totals.active/disabled no escopo autorizado.
POST /api/instances/:id/lifecycle recebe {"active":true|false}, exige sessão, CSRF e autorização. Não altera token nem ID. Integração com token válido em instância desativada recebe HTTP 409, code instance_disabled; token inválido continua 401.
Migração aditiva: instances.active (padrão 1), disabled_at, disabled_by; connection_incidents.resolution_reason. As instâncias existentes ficam ativas.

## Validação e limites
64 testes automatizados aprovados, incluindo permissões, identidade, bloqueio da API, fila, chaves de sessão, restauração após reinício, alertas e auditoria. Sockets e SMTP simulados: não equivale a homologação real no WhatsApp.
Após implantação, conferir no painel com instância de teste autorizada. Não desativar canais reais apenas para testar. A tolerância de reconexão recuperável de 60 segundos permanece.
