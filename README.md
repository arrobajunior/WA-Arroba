# WhatsApp API

**Proposta em revisão:** novas mídias passam apenas por memória temporária; arquivamento definitivo pertence ao cliente. Consulte [matriz de compatibilidade e limitações](COMPATIBILITY.md). Não há declaração de paridade integral com UltraMsg.


Plataforma independente para criar usuários, gerenciar instâncias e conectar WhatsApp por QR. Executa no Railway com Docker e um volume persistente.

Este repositório contém somente a aplicação. A raiz é o contexto Docker e contém o Dockerfile. O REA foi usado para investigar a referência UltraMsg; não é dependência de execução desta aplicação.

Consulte [publicação no Railway e contratos da API](DEPLOYMENT.md).

- Admin Master: conta original protegida contra exclusão, bloqueio e rebaixamento; somente o próprio Master pode editar seus dados.
- ADMIN: vê e gerencia todas as instâncias; cria contas USER/ADMIN e altera perfis e acessos.
- USER: acessa apenas suas próprias instâncias.
- Cadastro e edição em Administração permitem escolher USER ou ADMIN; identidade visual é exclusiva do Master.
- Nome, logos positiva/negativa e favicon configuráveis no painel.
- Contas existentes continuam USER; o Master original é preservado automaticamente na migração.
- QR e credenciais: URL, ID e token.
- Reconexão com credenciais persistentes.
- API de texto, status, QR e histórico dos envios.
- Webhook por instância: notifica um sistema externo (URL configurável no painel) a cada mensagem recebida, enviada ou confirmação de entrega — formato compatível com o payload do UltraMsg. Até 3 tentativas com espaçamento curto em caso de falha de rede; sem fila persistente (se todas as tentativas falharem, o evento é perdido).
- Mídia recebida (imagem, áudio, vídeo, documento, figurinha) é salva no S3 quando configurado, com URL assinada de uma hora (armazenamento legado SQLite de 24h sem S3), incluída no payload do webhook — o suficiente para outro sistema consumir e rehospedar. Envio de áudio e imagens pela API implementado, com upload multipart/base64 e persistência privada em S3.

Estado: implementação inicial, testes automatizados e geração real de QR verificados. Pareamento, envio/entrega em telefone real e execução da imagem Docker ainda precisam ser validados. Não é uma réplica completa da UltraMsg nem uma integração oficial da Meta.
