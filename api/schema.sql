-- Painel de propostas para prestadores de serviço (base RK) + semente do CRM (Cloudflare D1 / SQLite)
-- Cada proposta tem o próprio link: <site>/proposta/?p=<slug>

CREATE TABLE IF NOT EXISTS propostas (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'publicada')),
  etapa          TEXT NOT NULL DEFAULT 'aberta'   CHECK (etapa IN ('aberta', 'fechada', 'perdida')),
  cliente        TEXT NOT NULL DEFAULT '',
  data_evento    TEXT,                 -- AAAA-MM-DD (cópia de dados.data, pra agenda e pro resumo por ano)
  dados          TEXT NOT NULL,        -- JSON com o conteúdo editável (as 3 opções, adicionais, condições...)
  fechamento     TEXT,                 -- JSON do fechamento ou do motivo, quando etapa != 'aberta'
  valor_fechado  REAL,                 -- só quando etapa = 'fechada'
  fechado_em     TEXT,                 -- AAAA-MM-DD do fechamento (ou de quando marcou "não fechou")
  criado_em      TEXT NOT NULL,
  atualizado_em  TEXT NOT NULL,
  views          INTEGER NOT NULL DEFAULT 0,  -- aberturas pelo cliente (o dono logado não conta)
  primeira_vista TEXT,
  ultima_vista   TEXT
);
CREATE INDEX IF NOT EXISTS idx_propostas_etapa ON propostas (etapa, fechado_em);
CREATE INDEX IF NOT EXISTS idx_propostas_evento ON propostas (data_evento);

-- Modelo usado ao criar uma proposta nova (linha única)
CREATE TABLE IF NOT EXISTS modelo (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  dados         TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

-- Contatos: quem pediu preço (ESPEC §8.3). Telefone de terceiro fica só no painel, nunca na página pública,
-- e dá para excluir. Na demonstração, os contatos de exemplo têm id com o mesmo prefixo das propostas de exemplo.
CREATE TABLE IF NOT EXISTS contatos (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  whatsapp      TEXT NOT NULL DEFAULT '',   -- só números, com DDD (ex.: 11999990000)
  origem        TEXT NOT NULL DEFAULT '',   -- instagram | portal | indicacao | google | whatsapp | outro
  data_evento   TEXT,                       -- AAAA-MM-DD, se já souber
  obs           TEXT NOT NULL DEFAULT '',
  lembrete_em   TEXT,                       -- AAAA-MM-DD: dia de chamar de volta
  lembrete_txt  TEXT NOT NULL DEFAULT '',
  proposta_id   TEXT,                       -- a proposta feita para esse contato (se houver)
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contatos_lembrete ON contatos (lembrete_em);

-- Tentativas de senha erradas, pra frear força bruta no login do painel
CREATE TABLE IF NOT EXISTS login_falhas (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_falhas ON login_falhas (ip, ts);

-- Demonstração pública (só com DEMO = "1"): dia (Brasília, AAAA-MM-DD) em que os dados fictícios
-- foram gravados. Passando de 6 dias, a API grava de novo só as linhas da demo (ids 00000000-0000-4000-8000-…).
CREATE TABLE IF NOT EXISTS demo_meta (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  semeado_em TEXT
);

-- Modelo padrão genérico (exemplo: um estúdio de foto e vídeo de eventos). Cada cliente da RK troca pelas
-- opções, valores, rótulos dos pacotes e condições dele. As chaves internas dos dois valores continuam
-- "cerimonia" (pacote A) e "cerimonia_recepcao" (pacote B); o que muda é o rótulo em "rotulos".
INSERT OR IGNORE INTO modelo (id, dados, atualizado_em) VALUES (1, '{
  "tipo": "Casamento",
  "rotulos": { "pacote_a": "Evento", "pacote_b": "Evento + ensaio", "nota_b": "Inclui um ensaio fotográfico antes do evento, no lugar que vocês escolherem" },
  "opcoes": {
    "simples": {
      "on": true, "nome": "Essencial", "clima": "O essencial, bem feito",
      "itens": "1 fotógrafo\n6 horas de cobertura\n300 fotos editadas\nGaleria online",
      "cerimonia": 2400, "cerimonia_recepcao": 3100,
      "ver_cerimonia": true, "ver_recepcao": true
    },
    "media": {
      "on": true, "nome": "Completa", "clima": "Foto e vídeo do começo ao fim",
      "itens": "2 fotógrafos\n10 horas de cobertura\n600 fotos editadas\nVídeo resumo de 3 minutos",
      "cerimonia": 4200, "cerimonia_recepcao": 4900,
      "ver_cerimonia": true, "ver_recepcao": true
    },
    "completa": {
      "on": true, "nome": "Premium", "clima": "O dia inteiro, em foto e filme",
      "itens": "2 fotógrafos e 1 videomaker\nDia inteiro\n900 fotos editadas\nFilme de 10 minutos e teaser",
      "cerimonia": 6800, "cerimonia_recepcao": 7500,
      "ver_cerimonia": false, "ver_recepcao": true
    }
  },
  "ordem": ["completa", "media", "simples"],
  "sugestao": "",
  "inclui": "Galeria online com download em alta\nEdição de cor em todas as fotos\nReunião de alinhamento antes do evento",
  "adicionais": [
    { "nome": "Álbum impresso 30×30", "descricao": "40 páginas, capa em linho", "valor": 900 },
    { "nome": "Imagens de drone", "descricao": "", "valor": 600 },
    { "nome": "Segundo videomaker", "descricao": "", "valor": 1200 },
    { "nome": "Entrega expressa em 7 dias", "descricao": "", "valor": null }
  ],
  "condicoes": "30% na reserva da data\nRestante até 7 dias antes do evento\nPix ou cartão em até 10x",
  "validade_dias": 30,
  "observacoes": "",
  "secoes": { "videos": true, "depoimentos": true }
}', datetime('now'));
