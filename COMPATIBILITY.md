# Compatibilidade com UltraMsg

Referências consultadas em 12/11/2026: [documentação oficial](https://docs.ultramsg.com/), [SDK oficial](https://github.com/ultramsg/whatsapp-nodejs-sdk), [resposta de envio](https://blog.ultramsg.com/send-whatsapp-message-by-whatsapp-api-c-sharp/), [consulta/ACK](https://blog.ultramsg.com/whatsapp-message-delivery-read-status-ack/) e [webhook completo](https://github.com/ultramsg/whatsapp-webhook-csharp).

A aplicação preserva os nomes de comandos e campos nos fluxos abaixo. O domínio, a instância e o token são os deste serviço. A equivalência integral com todas as particularidades da UltraMsg não foi certificada por comparação com uma conta real ou com o cliente MF Rural. Não se deve anunciar paridade de 100% com base apenas nos testes simulados.

## Rotas implementadas

| Área | Rotas / comportamento |
|---|---|
| Envio | POST messages/chat, image, audio, voice, video, document, sticker, link, contact, location, vcard |
| Formulário | token no corpo; application/x-www-form-urlencoded e JSON; multipart adicional para mídias |
| Parâmetros | to, campo do tipo de mídia, caption, filename, priority, referenceId; voice usa audio OGG/Opus |
| Retorno de envio | HTTP 200, sent="true", message="ok", id numérico estável; aceitação pela fila, não confirmação de entrega |
| Consulta | GET messages: total/pages/limit/page/messages, IDs numéricos, datas epoch, from/to @c.us, priority, referenceId, status, ack, type, body e metadata |
| Filtros | id, referenceId, from, to, ack, status (incluindo all), page, limit, sort |
| Fila | GET messages/statistics; POST messages/resendById, resendByStatus, clear; prioridade crescente; expiração após 24h |
| Ações em mensagem | POST messages/reaction e messages/delete com msgId composto |
| Instância | GET instance/status, qr, qrCode, me, settings; POST instance/settings, restart, takeover, logout, clear |
| Settings | sendDelay/sendDelayMax; webhook_url e flags received/create/ack/download_media |
| Upload | POST media/upload retorna url temporária utilizável nos comandos de envio |
| Contatos | GET contacts, contacts/ids, contact, image, check, invalid, blocked; POST contacts/block, unblock |
| Conversas | GET chats, chats/ids, chats/messages; POST chats/read, archive, unarchive, delete, clearMessages |
| Grupos | GET groups, groups/ids, groups/group; envio e recebimento de mensagens em grupo |
| Webhooks | event_type, instanceId, id e referenceId; data com id composto, from/to/author normalizados, body, type, media, flags e contexto básico; ACKs não regridem |

## Limites e diferenças explícitas

- `instance/screenshot` retorna **501**. Baileys não mantém uma janela de WhatsApp Web: não há screenshot real para retornar. Uma imagem simulada não substitui essa operação.
- Contatos, conversas e últimas mensagens usam um cache limitado em memória e só incluem dados sincronizados na sessão. Não é uma cópia completa do histórico do telefone. Reiniciar descarta esse cache.
- Preview de links, campos de contexto/quotes avançados, respostas de erros e comportamentos específicos do provedor/WhatsApp não têm equivalência byte a byte certificada. Um link é enviado como texto contendo a URL, sem baixar páginas arbitrárias para gerar preview.
- `nocache` é aceito para compatibilidade; a aplicação não mantém cache permanente de mídia. URLs públicas são validadas e baixadas a cada solicitação, sem acesso a destinos privados.
- Imagens JPEG, PNG e WebP são aceitas; GIF/BMP são convertidos em memória (GIF usa o primeiro quadro). Figurinha é convertida para WebP. Vídeo aceita MP4/3GP/MOV; voz requer OGG/Opus. Não há conversão geral de codecs de vídeo/voz.
- Arquivos: imagem/áudio/voz/figurinha até 16 MB, documento até 30 MB, vídeo até 32 MB; base64 até 10.000.000 caracteres.
- Uma requisição aceita não comprova entrega. A confirmação vem de ACK device/read/played; falhas de envio ambíguas permanecem unknown para não duplicar silenciosamente. Reenvio é uma ação explícita do cliente.

## Armazenamento: o cliente arquiva as mídias

**Novos arquivos não são gravados em SQLite, disco persistente ou bucket S3.** Há apenas retransmissão temporária em memória, limitada a 128 MB por processo. Links de recebimento/upload usam capacidades aleatórias vinculadas à instância, sem o token geral da API. Expiram em uma hora ou ao reiniciar. O cliente deve baixar e armazenar imediatamente em seu próprio banco/bucket. O motor WhatsApp/FFmpeg pode usar arquivos de trabalho temporários durante transmissão/conversão, nunca como arquivo definitivo.

Envios por URL guardam apenas uma referência criptografada na fila operacional: o arquivo pode ser baixado novamente da origem ao retomar/repetir. URLs assinadas do cliente precisam continuar válidas. Envios base64/multipart perdem os bytes ao reiniciar e são marcados unsent; o cliente precisa enviar o arquivo novamente. Reenvio de mídia temporária expirada sem origem URL retorna 409. A memória permanece limitada também durante downloads recebidos.

Usuários, permissões, credenciais WhatsApp criptografadas, configurações, textos e status/fila continuam no banco operacional. Isso não é uma implementação sem banco nem sem histórico de texto. Não apagamos dados, credenciais ou objetos S3 existentes durante a implantação. Leitura legada continua disponível; nenhuma mídia nova vai para S3. `instance/clear` apaga apenas o estado operacional da instância explicitamente solicitada e volta ao pareamento, como documentado pelo provedor; não remove usuários ou o Admin Master e não apaga objetos antigos da bucket.

A própria UltraMsg [documenta retenção de logs/mídias por 60 dias](https://blog.ultramsg.com/whatsapp-api-by-ultramsg-faq/). A ausência de arquivamento permanente de novas mídias aqui é uma escolha solicitada para este serviço e difere dessa retenção.

## Verificação

Testes cobrem formulário HTTP, IDs e filtros, timestamps, ACK monotônico, prioridade/reenvio, settings/flags, upload/download temporário, ausência de bytes dos arquivos no SQLite, payloads de mídia, normalização de JIDs, grupos, ações de contato/chat, reset isolado, migração e proteção de Master/USER/ADMIN. Transporte WhatsApp e serviços externos são simulados. Conversão BMP/WebP usa FFmpeg/Sharp reais nos testes locais. O teste de envio a um telefone real e a homologação do MF Rural ainda são necessários.
