# WhatsApp API

Gateway WhatsApp com comandos compatíveis com a interface UltraMsg, painel USER/ADMIN/Master e retransmissão temporária de mídias. O sistema cliente é responsável pelo arquivamento definitivo dos arquivos.

- ADMINs veem e gerenciam todas as instâncias. USERs só acessam suas próprias instâncias.
- O Admin Master original não pode ser excluído, bloqueado ou rebaixado; só o próprio Master edita sua conta.
- Texto, imagem, áudio, voz, vídeo, documento, figurinha, localização, contato/vCard e reações.
- Fila por prioridade, IDs numéricos, consulta e ACK, webhooks e configuração nos caminhos UltraMsg.
- Arquivos novos passam por memória temporária; não são gravados em S3 ou SQLite.
- Credenciais de conexão persistem criptografadas para permitir reconexão.

Veja [comandos, diferenças e limites](COMPATIBILITY.md) e [implantação/configuração](DEPLOYMENT.md). Não há declaração de paridade integral com o serviço proprietário; screenshot não está disponível e o cache de histórico/contatos é limitado à sessão sincronizada.

## Desenvolvimento

Node >=24.15, FFmpeg e as dependências de package-lock.json. Execute `npm ci --ignore-scripts` e `npm test`. Para rodar, configure ADMIN_EMAIL, ADMIN_PASSWORD (primeira execução) e PUBLIC_URL no acesso externo, depois `npm start`.

Não é uma integração oficial da Meta. Pareamento e entrega com número real e homologação do cliente precisam de validação operacional.
