# API do painel de propostas

Cloudflare Worker (JavaScript) + banco D1 (SQLite). Sem dependências além do `wrangler`.

## Rotas

| Método e caminho | O que faz | Quem pode |
|---|---|---|
| `GET /` | Confere se a API está no ar | todos |
| `POST /login` | Entra com a senha do administrador ou como visitante; devolve um token de sessão | todos |
| `GET /p/:slug` | Conteúdo de uma proposta publicada (o que o cliente vê) e registra a abertura | todos |
| `GET /admin/propostas` · `POST /admin/propostas` | Lista e cria propostas | administrador (visitante só lista) |
| `GET/PUT/DELETE /admin/propostas/:id` | Lê, edita e exclui uma proposta | administrador |
| `POST /admin/propostas/:id/duplicar` | Duplica uma proposta | administrador |
| `PUT /admin/propostas/:id/etapa` | Muda a etapa (aberta, fechada, perdida) e registra o fechamento e os pagamentos | administrador |
| `GET /admin/p/:slug` | Prévia de uma proposta ainda não publicada | administrador e visitante |
| `GET/PUT /admin/modelo` | Proposta padrão (opções, valores e rótulos) | administrador (visitante só lê) |
| `GET /admin/resumo` | Números do mês, a receber e pagamentos da semana | administrador e visitante |
| `GET/POST /admin/contatos` · `PUT/DELETE /admin/contatos/:id` | Contatos de quem pediu preço | administrador (visitante só lista) |

Toda rota `/admin/` exige o token no cabeçalho `Authorization: Bearer <token>`. O visitante só lê e só enxerga as linhas de exemplo.

## Configuração (`wrangler.toml`)

- `ORIGENS`: endereços que podem chamar a API (CORS).
- `DEMO = "1"`: liga a demonstração (dados fictícios que se renovam e modo visitante). Numa versão de cliente, apague a linha.
- Segredos, nunca em arquivo: `ADMIN_SENHA` (senha do painel) e `SESSAO_CHAVE` (assina as sessões do visitante), gravados com `npx wrangler secret put`.

## Testes

```bash
node tests/gerar-dev-vars.mjs   # senhas de teste em .dev.vars (fora do git)
node tests/api.test.mjs         # 111 testes; sobe o wrangler dev local na porta 8793
```

## Publicar

```bash
npx wrangler d1 create <nome>                         # troque o database_id no wrangler.toml
npx wrangler d1 execute <nome> --remote --file=schema.sql
npx wrangler secret put ADMIN_SENHA
npx wrangler deploy
```
