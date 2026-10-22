# WhatsApp API

Plataforma independente para criar usuários, gerenciar instâncias e conectar WhatsApp por QR. Executa no Railway com Docker e um volume persistente.

Este repositório contém somente a aplicação. A raiz é o contexto Docker e contém o Dockerfile. O REA foi usado para investigar a referência UltraMsg; não é dependência de execução desta aplicação.

Consulte [publicação no Railway e contratos da API](DEPLOYMENT.md).

- Admin Master: criação/edição de usuários, bloqueio de acesso e redefinição de senha.
- Nome, logos positiva/negativa e favicon configuráveis no painel.
- Isolamento de instâncias por proprietário.
- QR e credenciais: URL, ID e token.
- Reconexão com credenciais persistentes.
- API de texto, status, QR e histórico dos envios.
- Webhook por instância: notifica um sistema externo (URL configurável no painel) a cada mensagem recebida, enviada ou confirmação de entrega — formato compatível com o payload do UltraMsg. Até 3 tentativas com espaçamento curto em caso de falha de rede; sem fila persistente (se todas as tentativas falharem, o evento é perdido).
- Mídia recebida (imagem, áudio, vídeo, documento, figurinha) é baixada e hospedada temporariamente (24h) em uma URL própria, incluída no payload do webhook — o suficiente para outro sistema consumir e rehospedar. Envio de mídia pela API ainda não está implementado (somente texto).

Estado: implementação inicial, testes automatizados e geração real de QR verificados. Pareamento, envio/entrega em telefone real e execução da imagem Docker ainda precisam ser validados. Não é uma réplica completa da UltraMsg nem uma integração oficial da Meta.
