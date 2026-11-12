# Implantação e operação

## Serviço existente no Railway

Repositório `arrobajunior/WA-Arroba`, branch `main`, projeto Whatsapp-API, serviço WA-Arroba, ambiente production. Use o Dockerfile da raiz e mantenha o volume existente em `/app/data`. Não remova nem recrie o volume.

| Variável | Uso |
|---|---|
| PUBLIC_URL | Origem HTTPS exata, sem caminho; necessária para acesso externo e links do webhook |
| ADMIN_EMAIL | E-mail do Master na primeira execução |
| ADMIN_PASSWORD ou ADMIN_PASSWORD_FILE | Senha inicial de pelo menos 12 caracteres; mudar variável não troca senha já cadastrada |
| DATA_DIR | `/app/data` |
| HOST | `0.0.0.0` no Railway |
| PORT | `3210` ou a porta configurada no domínio |
| RAILWAY_RUN_UID | A instalação existente usa 0 para acessar o volume; isso executa como root no container |

Configure uma réplica, sem serverless/sleep, healthcheck `/api/health`, timeout 60s. A aplicação mantém sessões WhatsApp abertas e um SQLite por processo. O Dockerfile instala FFmpeg para mídias/miniaturas e conversão BMP; usa node por padrão, antes do override de UID do serviço.

A implantação faz migrações aditivas: preserva usuários, perfis, instâncias, tokens e sessões. Adiciona IDs numéricos de mensagens, configurações de fila e referências de mídia. IDs de mensagens antigos continuam aceitos como filtro adicional; os IDs das instâncias não mudam. Arquivos antigos não são apagados. APIs administrativas continuam com autenticação de sessão e proteção CSRF; os comandos de integração usam token da instância.

## Integração do cliente

Base: `https://SEU_DOMINIO/instance{ID}/`. Use os mesmos caminhos/campos dos comandos UltraMsg listados em [COMPATIBILITY.md](COMPATIBILITY.md). Substitua domínio, instância e token. `token` é aceito em formulário/JSON/query GET; Bearer é adicional. A ausência de screenshot e as diferenças listadas devem ser consideradas na homologação, sem promessa de paridade de 100%.

Exemplo de envio por formulário:

```sh
curl -X POST 'https://SEU_DOMINIO/instanceSEU_ID/messages/document' \
  --data-urlencode 'token=SEU_TOKEN' \
  --data-urlencode 'to=5511999999999' \
  --data-urlencode 'filename=proposta.pdf' \
  --data-urlencode 'document=https://sistema-do-cliente.example/proposta.pdf' \
  --data-urlencode 'caption=Sua proposta' \
  --data-urlencode 'referenceId=pedido-123'
```

HTTP 200 com `{"sent":"true","message":"ok","id":123}` confirma aceitação pela fila. Confira ACK antes de tratar como entregue. A fila respeita priority, sendDelay/sendDelayMax e expiração de 24h. Envios ambíguos ficam unknown; não são reenviados automaticamente. As configurações e flags de webhook podem ser alteradas em instance/settings ou a URL no painel.

## Mídias e retenção

O cliente baixa os anexos de `data.media` e os salva no próprio armazenamento. Os links são temporários de uma hora, também invalidados ao reiniciar o processo. O cache total tem limite de 128 MB; uploads podem receber 503 quando a capacidade está esgotada. Arquivos base64/multipart ainda em fila se perdem no reinício e tornam-se unsent. URLs de origem criptografadas permitem baixar novamente do cliente; sua validade precisa cobrir a fila/reenvio.

Não há novos uploads para bucket ou blobs de mídia no SQLite. As variáveis S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY existentes são usadas **apenas para leitura legada sob demanda**. Nenhum objeto S3 é removido pela implantação. O banco operacional conserva usuários, sessões, textos e status/fila; não é zero retenção de todo tipo de dado.

Destinos de download HTTP/HTTPS devem ser públicos. DNS é validado/fixado por conexão e cada redirect é revalidado; rede privada, loopback e link-local são bloqueados. Credenciais S3 e tokens da instância não são enviados às URLs fornecidas pelo cliente.

## Backup e reinício

O volume contém platform.sqlite, WAL e master.key. Banco e chave precisam ser preservados e copiados juntos de forma consistente; só o banco não recupera as credenciais criptografadas. Configure backup do volume e ensaie restauração separada. Não use `docker compose down -v`.

Ao reiniciar, sessões WhatsApp são retomadas com tentativas limitadas. Sessões do painel expiram em 12h; alterações de senha/e-mail/perfil revogam sessões. Bloquear um proprietário recusa API/painel e pausa novos envios; um envio já em andamento pode terminar. Um reset explícito via instance/clear afeta somente a instância do token informado, limpa a fila/configurações/sessão e inicia novo pareamento.

## Validação

`npm ci --ignore-scripts`, `npm test`, verificações de sintaxe e healthcheck do deploy. Os testes usam sockets e serviços externos simulados, exceto a conversão local de imagem. A homologação deve incluir envio/recebimento de cada mídia, ACK e webhook do MF Rural, reinício, filas e expiração de links com destinatário de teste.
