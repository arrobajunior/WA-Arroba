# WhatsApp API — publicação no Railway

## O que esta versão faz

- Admin Master entra com e-mail e senha, cria/edita usuários, bloqueia acessos, redefine senhas e vê todas as instâncias.
- Admin Master personaliza nome, logos positiva/negativa e favicon em **Admin Master → Identidade visual**. Imagens PNG/JPG/WebP até 1 MB são convertidas para PNG estático e salvas no banco.
- O bloqueio revoga sessões do painel, recusa a API do usuário e pausa novos envios da fila. Envios já em andamento podem terminar; sessões WhatsApp e dados são preservados. Reativar retoma a fila quando a conexão está ativa.
- Usuários entram com e-mail e senha e só gerenciam suas próprias instâncias.
- Cada instância tem nome, URL da API, ID, token e conexão por QR Code.
- Baileys 6.7.24 conecta ao WhatsApp Web. Não depende da UltraMsg nem usa sua API. Não é a API oficial da Meta.
- Sessões e chaves do WhatsApp são armazenadas em SQLite, com criptografia AES-256-GCM. Senhas usam scrypt e sessões administrativas expiram em 12 horas.
- Conexões são retomadas ao reiniciar, com tentativas limitadas. Logout explícito exige novo pareamento.
- API para status, QR, envio de texto e consulta dos envios. Fila persistente; retorno 202 significa aceito, não entregue. O ACK indica confirmação de servidor/dispositivo/leitura.
- Em falhas de envio ambíguas, a mensagem fica `unknown` e não é reenviada automaticamente, evitando duplicação silenciosa.

Não inclui cobrança, plano comercial, bots, envio de mídia, webhooks, recuperação de senha por e-mail, exclusão de usuários ou paridade completa com a UltraMsg. O histórico cobre envios desta API. A validação de pareamento e entrega com um número real ainda depende do operador.

## Railway: configuração inicial

O repositório privado da aplicação é `arrobajunior/WA-Arroba`, com os arquivos na raiz. Não publique o checkout do REA, `node_modules`, `.data`, `.env`, backups ou credenciais. O Dockerfile deve estar na raiz desse novo repositório.

Destino consultado em 19/10/2026: projeto **Whatsapp-API**, ambiente **production**. Na consulta existia apenas um serviço vazio em criação pendente (`harmonious-encouragement`), sem deploy, volume ou bucket. Nenhuma mudança externa foi aplicada nesta entrega.

1. No Railway, abra esse serviço e conecte `arrobajunior/WA-Arroba` e a branch `main`. Use o **Dockerfile** da raiz. Se preferir manter o diretório `platform` no novo repositório, configure Root Directory como `/platform`.
2. Antes do primeiro deploy, anexe um **volume persistente** em `/app/data`. Não use o disco efêmero para os dados. Banco SQLite, identidade visual, credenciais e sessões ficam nesse volume; PostgreSQL, Redis e bucket não são necessários neste escopo.
3. Configure as variáveis do serviço:

| Variável | Valor |
| --- | --- |
| `PUBLIC_URL` | `https://SEU-DOMINIO`, sem caminho; deve coincidir com o domínio acessado |
| `ADMIN_EMAIL` | E-mail do primeiro Admin Master |
| `ADMIN_PASSWORD` | Senha inicial forte, com pelo menos 12 caracteres; configure como segredo no Railway |
| `DATA_DIR` | `/app/data` |
| `HOST` | `0.0.0.0` |
| `PORT` | `3210` (se alterar, use a mesma porta no domínio Railway) |
| `RAILWAY_RUN_UID` | `0`, necessário para escrever no volume montado pelo Railway com proprietário root |

A imagem usa o usuário `node` por padrão. O override `RAILWAY_RUN_UID=0` segue a orientação do Railway para permissões dos volumes; o processo nesse serviço executará como root no container. Fonte: [Volumes — caveats](https://docs.railway.com/volumes/reference#caveats).

4. Configure **uma réplica**, desligue **Serverless / sleep** e defina Healthcheck Path como `/api/health`, timeout de 60 segundos e reinício em falha. A aplicação precisa manter as conexões WhatsApp abertas. Ela respeita `PORT` e aceita o host do healthcheck do Railway nesse endpoint público.
5. Gere o domínio Railway (ou adicione seu domínio), porta de destino 3210, e ajuste `PUBLIC_URL` ao endereço HTTPS exato. HTTPS é terminado no Railway; Caddy não é necessário.
6. Revise as mudanças pendentes, publique e aguarde o healthcheck. Faça login, abra **Admin Master**, personalize a marca e crie os usuários. Cada usuário pode criar a instância e ler seu QR em WhatsApp → Dispositivos conectados → Conectar dispositivo.
7. Valide pareamento, envio e ACK com um número de teste antes de usar a integração real. Reinicie o serviço e confirme que dados e sessão persistiram.

Após a configuração inicial, pushes na branch conectada poderão disparar novos deploys. O volume precisa permanecer anexado ao mesmo serviço. Não use múltiplas réplicas: o banco e as conexões desta versão pertencem a um único processo. A capacidade por RAM/CPU ainda não foi medida. Limites iniciais: 50 instâncias por usuário, 1.000 mensagens pendentes por instância.

A senha de bootstrap só cria a conta quando não há administrador. Alterar `ADMIN_PASSWORD` depois não muda uma senha existente: use **Admin Master → Gerenciar acesso**. Após validar o primeiro acesso, o segredo de bootstrap pode ser removido; preserve o banco. A instalação de um banco novo sem credenciais iniciais falha explicitamente.

Não foi adicionado `railway.json`: a documentação consultada informa que novos serviços devem usar configurações do painel/API ou IaC, e que Config as Code legado foi descontinuado. O Dockerfile permanece o contrato de build. [Documentação Railway](https://docs.railway.com/infrastructure-as-code).

## Docker Compose opcional

O `compose.yaml` permanece disponível para instalações fora do Railway. Copie `.env.example` para `.env`, defina `APP_DOMAIN` e `ADMIN_EMAIL` e crie a senha em `secrets/admin_password.txt`. O arquivo precisa ser legível pelo usuário `node` do container; mantenha o diretório `secrets` privado no host. Use `docker compose --profile gateway up -d --build` se precisar do Caddy, ou `docker compose up -d --build` com seu próprio proxy HTTPS. O Railway não executa esse Compose automaticamente.

## Integração

Prefixo: `https://SEU_APP_DOMAIN/instance{ID}/`.

| Método | Caminho | Resultado |
| --- | --- | --- |
| GET | `instance/status` | Estado da conexão |
| GET | `instance/qr` | Imagem PNG do QR atual |
| GET | `instance/qrCode` | QR textual em JSON |
| POST | `messages/chat` | Adiciona texto à fila de envio |
| GET | `messages` | Até 100 envios mais recentes, com status/ACK |

Use `Authorization: Bearer SEU_TOKEN`. Também são aceitos `token` no corpo de POST e `?token=` em GET para integrações existentes. Prefira o cabeçalho, pois URLs podem ser registradas por proxies.

Corpo do envio, JSON ou formulário:

```json
{"to":"5511999999999","body":"Olá!"}
```

`to` aceita telefone internacional, contato `@c.us`/`@s.whatsapp.net` ou grupo `@g.us`. Texto até 4.096 caracteres. A fila é processada com intervalo de um segundo por instância. Renovar um token revoga imediatamente o anterior. O painel não oferece botão de envio; o envio é realizado pelo sistema integrado.

## Persistência, atualização e backup

`/app/data` contém banco, WAL e `master.key`. O volume preserva dados ao recriar containers. Guarde banco e chave juntos em backups protegidos e fora do serviço; só o banco não basta para restaurar as credenciais criptografadas.

No Railway, configure backups do volume e teste uma restauração isolada preservando banco e chave. Não remova nem recrie o volume durante o deploy.

Em Docker Compose, atualização: depois de trazer o novo código, execute o mesmo `docker compose ... up -d --build` usado no deploy. **Não use `down -v`**, pois remove o volume.

Backup consistente com breve parada:

```sh
docker compose stop app
docker compose run --rm --no-deps --entrypoint tar app -C /app/data -czf - . > backup-wa.tgz
docker compose start app
```

Verifique o código de saída e o arquivo antes de enviá-lo ao armazenamento de backup. A restauração precisa ser ensaiada em um volume separado antes de substituir dados de produção. Este projeto ainda não automatiza backup nem atesta uma restauração de produção.

A chave está no mesmo volume para permitir reinstalação simples. Ela protege a leitura isolada do banco, mas não protege contra acesso a todo o volume/host.

## Validação

```sh
npm ci --ignore-scripts
npm test
node scripts/check-qr.mjs
```

O último comando faz um teste real de geração de QR com sessão temporária, sem parear telefone ou enviar mensagens. Os testes automáticos de isolamento, autenticação, persistência e ciclo de conexão usam transporte simulado e não provam entrega real pelo WhatsApp.

Docker não estava disponível no ambiente de desenvolvimento desta entrega. O build da imagem e sua execução com volume ainda precisam ser verificados no Railway; nenhum deploy foi executado.

## Desenvolvimento local

Node >=24.15. Defina `ADMIN_EMAIL` e `ADMIN_PASSWORD_FILE` com uma senha de 12+ caracteres; execute `npm start`. Por padrão, o servidor fica em `127.0.0.1:3210` e guarda dados em `.data/`. `DATA_DIR` permite escolher outra pasta. Para acesso externo, `HOST=0.0.0.0` exige `PUBLIC_URL`; em produção, use HTTPS no proxy.
