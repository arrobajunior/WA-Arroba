# Continuidade — WA-Arroba

Atualização: 18/11/2026. Repositório: arrobajunior/WA-Arroba.

## Objetivo e arquitetura
Gateway WhatsApp próprio usando Baileys, com interface compatível com comandos UltraMsg para os sistemas clientes do MF Rural. Node >=24.15; SQLite operacional; credenciais criptografadas; painel USER/ADMIN/Master; mídia nova retransmitida temporariamente em memória e arquivada pelo sistema cliente.
Código: transport.mjs (WhatsApp/webhooks), compatibility-api.mjs (comandos), instance-settings.mjs (normalização/configurações), store.mjs (persistência), server.mjs (HTTP/painel).
Leia também README.md, COMPATIBILITY.md e DEPLOYMENT.md. O ambiente descrito em DEPLOYMENT.md é Railway, serviço WA-Arroba, branch main, volume /app/data. A implantação da correção de LID (e2cece3) foi confirmada como SUCCESS no Railway em 18/11/2026; a homologação de telefone real com a TI não foi informada.

## Situação informada pelo usuário
A TI confirmou envio funcionando e recebimento do webhook. O bloqueio é data.from conter um identificador @lid, impedindo localizar o cliente por telefone.
Uma URL de outro projeto tem /webhook/vendedor/3. Esse segmento é um parâmetro de rota definido pelo receptor; não resolve o telefone do remetente e sua função exata deve ser confirmada no código do receptor.
A API por instância do gateway e a URL receptora de webhook são endereços diferentes.

## Correção de LID
O transporte agora procura o telefone associado ao LID usando metadados da mensagem, contatos sincronizados, chats.phoneNumberShare, associação criptografada por instância e lidMapping.getPNForLID quando disponível.
Baileys instalado: 6.7.24. Não supor que APIs de versões futuras estejam disponíveis; consulta ao lidMapping é opcional.
Em conversa individual resolvida, data.from (ou data.to em mensagem enviada) usa telefone@c.us.
Para conversas endereçadas por LID, data.remoteJid preserva o identificador original e data.phoneResolved indica sucesso.
Sem associação conhecida, mantém @lid e phoneResolved=false. Nunca fabricar telefone trocando o sufixo.
data.id mantém o identificador composto original para preservar ações/referências de mensagem.
Grupos continuam @g.us; author é resolvido separadamente quando há associação.
O histórico operacional e consultas de conversas ainda preservam o JID original: esta correção é do webhook, não uma migração geral de identidade.
Associações são criptografadas em wa_keys, categoria webhook-lid-phone, isoladas por instância; seguem o ciclo de limpeza das chaves de sessão.

## Como continuar em outro chat/IA
Peça: “Abra arrobajunior/WA-Arroba, leia AGENTS.md e documentacao/README.md, HISTORICO.md e ROADMAP.md. Confirme a versão implantada e continue a homologação de LID com a TI.”
Não é necessário levar todo o chat. Os arquivos descrevem o estado conhecido; registre novos resultados operacionais aqui.

## Fontes
- Código do próprio repositório, especialmente transport.mjs e DEPLOYMENT.md.
- Baileys 6.7.24 instalado: lib/Utils/decode-wa-message.js (senderPn/participantPn), lib/Types/Contact.d.ts (id/lid/jid) e lib/Socket/messages-recv.js (chats.phoneNumberShare).
- Documentação upstream: https://baileys.wiki/docs/migration/to-v7.0.0/ (conceitos de identidade; não aplicar migração automaticamente).

## Administração Geral e alertas de conexão
Veja [ALERTAS.md](ALERTAS.md). Todos os ADMINs podem configurar o destinatário; USER não pode acessar essa área. Alterações e testes são auditados. A página principal destaca quedas em vermelho e atualiza a cada 10 segundos.
O código de envio SES está implementado, mas as variáveis SES_SMTP_USER e SES_SMTP_PASS ainda não foram gravadas no Railway: a revisão automática exigiu autorização explícita para enviar as credenciais do guia ao serviço WA-Arroba/production. Não contornar esse bloqueio. O próximo passo é obter essa autorização, configurar o SMTP e homologar um envio para o destinatário cadastrado pelo admin.
