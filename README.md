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
- Webhook por instância: notifica um sistema externo (URL configurável no painel) a cada mensagem recebida, enviada ou confirmação de entrega — formato compatível com o payload do UltraMsg. Entrega best-effort, sem fila/retentativa; mídia ainda não é incluída no payload.

Estado: implementação inicial, testes automatizados e geração real de QR verificados. Pareamento, envio/entrega em telefone real e execução da imagem Docker ainda precisam ser validados. Não é uma réplica completa da UltraMsg nem uma integração oficial da Meta.
