# Compatibilidade UltraMsg — auditoria em andamento

Referências públicas consultadas em 12/11/2026:
- https://docs.ultramsg.com/
- https://github.com/ultramsg/whatsapp-nodejs-sdk
- https://blog.ultramsg.com/send-whatsapp-message-by-whatsapp-api-c-sharp/
- https://blog.ultramsg.com/receive-whatsapp-api-messages-use-webhook-nodejs/

Não é uma declaração de paridade de 100%. Mesmo nome de endpoint não prova equivalência de resposta, efeitos, erros e eventos. O SDK público também não contém necessariamente todas as operações atuais da documentação. A validação de contrato com o MF Rural e uma instância UltraMsg ainda não foi feita. Não precisa fornecer senha para consultar essas referências públicas.

## Alterações desta proposta

| Área | Implementado nesta proposta | Pendência para equivalência integral |
|---|---|---|
| Autenticação | Campo token em formulário/JSON/query, Bearer adicional | Formato exato de todos os erros |
| POST messages/chat | body, to, priority, referenceId, HTTP 200 e sent="true", message="ok" | IDs ainda são strings locais, não números; payload completo de erros |
| POST messages/image | image URL/base64, caption, priority, referenceId; 16 MB | Validar GIF/BMP com dispositivo real, nocache aceito mas sem cache permanente |
| POST messages/audio | audio URL/base64; 16 MB | Confirmar codecs em dispositivo real |
| POST messages/voice | campo audio OGG/Opus, rota própria; 16 MB | Confirmar reprodução real |
| POST messages/video | video URL/base64, caption; 32 MB | Confirmar reprodução/codec real |
| POST messages/document | document URL/base64, filename, caption; 30 MB | Confirmar tipos Office/PDF em dispositivo real |
| GET messages | all, paginação, limit, sort; referenceId no registro | Filtros id/referenceId/from/to/ack, datas/campos/IDs e envelope exatos |
| Webhooks | event_type, instanceId, data, ack e referenceId quando conhecido; media link | Conferir formato de JIDs, IDs e datas com cliente e serviço real; flags configuráveis |
| instance/status, qr, qrCode | Rotas existentes preservadas | Conferir formatos/estados exatos e inicialização automática de QR |
| Outras operações de envio | Não implementadas | link, contact, location, vcard, sticker, reaction, etc. |
| Gestão da instância | Painel próprio existente | settings, me, restart, logout, takeover, clear, screenshot |
| Gestão de mensagens | Fila e status locais | statistics, resendById, resendByStatus, clear |
| Conversas/contatos/grupos | Não implementados | Rotas e formatos de chats, contacts e groups |
| media/upload | Não implementado | Semântica de upload temporário equivalente |

## Armazenamento e diferença deliberada

Nesta proposta, novas mídias não são gravadas no SQLite, disco ou S3. Arquivos passam por memória (até 128 MB por processo, arquivos de no máximo 32 MB) e são descartados após uma hora; mídia de saída é descartada após o envio. O cliente precisa baixar e arquivar o que receber. Links deixam de funcionar ao reiniciar. Filas de mídia com bytes perdidos no reinício são marcadas como unsent, sem reenvio silencioso. Isso tem limitações diferentes de uma fila persistente e precisa ser aceito no contrato do cliente.

A UltraMsg documenta retenção de logs/mídias por 60 dias: https://blog.ultramsg.com/whatsapp-api-by-ultramsg-faq/. Portanto, zero retenção permanente aqui é uma escolha específica solicitada pelo proprietário e não replica essa retenção do serviço de referência.

O banco operacional continua necessário para usuários, permissões, sessões WhatsApp, fila, histórico/status e textos. A proposta não apaga arquivos antigos nem dados existentes. Rotas de leitura legadas ainda podem acessar mídias já gravadas anteriormente. As variáveis S3 existentes não são removidas e nenhum objeto da bucket é apagado. A leitura legada não faz upload novo.

## Segurança de downloads por URL

URLs HTTP/HTTPS públicas são baixadas com DNS validado e fixado na conexão, sem cookies/tokens do cliente; cada redirecionamento é revalidado. Endereços privados, loopback, link-local e reservados são bloqueados. Downloads têm limite de tamanho e timeout. Não permite acessar URLs internas do ambiente Railway.
