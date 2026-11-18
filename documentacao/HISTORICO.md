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
