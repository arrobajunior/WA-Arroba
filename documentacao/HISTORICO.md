# Histórico

## Base anterior, verificada no GitHub em 18/11/2026
- Main em 87c4027fc458eee88936ede709e15eb351c4cbc6: merge da PR #3, compatibilidade UltraMsg e retransmissão temporária de mídias.
- README e documentação registram perfis USER/ADMIN/Master, fila e ACKs, comandos de mídia e webhooks. Isso descreve implementação, não certificação integral com o provedor.
- Usuário informou que TI confirmou envio e recebimento do webhook; identificação por telefone estava bloqueada por @lid.

## 18/11/2026 — resolução de identidade no webhook
- Diagnóstico: handleIncoming repassava remoteJid para data.from via publicJid, que preservava @lid sem buscar telefone.
- Implementada resolução por metadados, contatos e compartilhamento de telefone; persistência criptografada por instância e consulta opcional à associação do socket.
- Preservado LID original e adicionado phoneResolved. Mensagens sem associação não recebem números inventados.
- Mantidos ID composto, identificação de grupos e chaves originais do WhatsApp.
- Criados AGENTS.md e pasta documentacao para continuidade.
- Teste novo cobre senderPn, persistência após recriar conexão, contato sincronizado, compartilhamento de telefone, grupo, envio sem confundir telefone próprio, consulta opcional, falha de consulta e isolamento entre instâncias.
- Validação: node --test transport.test.mjs (resultado final registrado no roadmap).
- Pendente: confirmar deploy no Railway e testar remetente real com a TI. Não declarar solução homologada antes disso.

## 18/11/2026 — Administração Geral e alertas
- Criada área independente no menu, disponível para todos os ADMINs, com e-mail compartilhado e botão de teste.
- Alterações registram usuário, data e valores anterior/novo; testes registram solicitação, sucesso/falha. A aplicação não oferece edição/exclusão desse log; triggers impedem UPDATE/DELETE na tabela.
- Instâncias registram primeira/última conexão; migração usa telefone, credenciais registradas ou mensagens com confirmação como evidência histórica.
- Quedas geram ocorrências persistidas e um e-mail por ocorrência. Tentativas de reconexão não duplicam alertas; recuperação encerra a ocorrência; nova queda permite novo alerta. Logout solicitado pelo painel/API também é registrado.
- Quedas de instâncias nunca conectadas não geram alertas. Encerramento normal do processo não gera queda; 60s após iniciar, verifica se instâncias anteriores restabeleceram conexão.
- E-mail HTML/texto via SES SMTP STARTTLS, com credenciais somente em ambiente. Fila persistida, retentativas limitadas e status de falha visível.
- Visão geral e listagem destacam ocorrências abertas em vermelho e atualizam automaticamente a cada 10s, respeitando o escopo do usuário.
- npm test: 42 testes aprovados. Verificação DOM local cobre menu, configuração/log, botão de teste, alerta automático e recuperação. Navegador Chromium local não pôde iniciar por restrição do ambiente; não foi inspecionada captura visual.
- SMTP real não configurado/testado. Revisão automática bloqueou gravação das credenciais no serviço Railway até autorização explícita desse destino. Não copiar o guia com segredos para o repositório.

## 18/11/2026 — autorização e configuração do SMTP
- Usuário autorizou explicitamente gravar as credenciais SES do guia no serviço Railway WA-Arroba, ambiente production.
- SES_SMTP_USER e SES_SMTP_PASS foram cadastradas como variáveis desse serviço, sem incluir valores nos arquivos ou no GitHub.
- A implantação a88ef44 da Administração Geral foi confirmada como SUCCESS. Esta atualização documental dispara a implantação com as novas variáveis.
- Pendente: confirmar implantação com variáveis e homologar e-mail de teste no destinatário escolhido no painel. Não foi desconectada instância real para testar.
