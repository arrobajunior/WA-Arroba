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
