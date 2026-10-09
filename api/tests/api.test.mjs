// Testes da API do painel de propostas para prestadores de serviço (base RK) — Node puro, sem dependências.
//
//   node tests/api.test.mjs
//
// Parte 1 — Worker de verdade, com a demo DESLIGADA (--var DEMO:0, como na cópia de um músico de verdade;
//           senão as 18 propostas fictícias entrariam nas contagens): aplica o schema num banco novo
//           (pasta temporária), sobe `wrangler dev --local` na porta 8793 e confere todas as rotas e
//           regras por HTTP, inclusive que, sem a demo, o modo visitante fica desligado (503 e 401).
// Parte 2 — o mesmo src/index.js rodando dentro do Node, com SQLite em memória e relógio
//           simulado, para o que depende de hora: fuso de Brasília, janela do rate-limit,
//           validade das sessões, os 503 sem secret, o gerador da demo (src/demo.js), a
//           renovação dos dados da demo (env.DEMO = '1') e o que o visitante enxerga.
// Parte 3 — Worker de verdade com o wrangler.toml como está (DEMO = "1"), banco novo: o primeiro
//           GET grava as 18 linhas num D1 de verdade, o segundo não duplica, o exemplo abre (sem
//           contar abertura), o modo visitante por HTTP (login, limite de tentativas, só leitura, só as
//           linhas da demo) e a regravação (forçada com o servidor parado) não toca nas propostas do
//           administrador.
//
// Variáveis opcionais: CRM_TEST_TMP (pasta temporária; os bancos ficam em <pasta>/db e <pasta>/db3),
// CRM_TEST_PORTA (padrão 8793), WRANGLER_JS (caminho do wrangler.js). Os segredos de teste (ADMIN_SENHA e
// SESSAO_CHAVE) são lidos de .dev.vars e nunca são impressos.
// O servidor é encerrado no finally; o script sai com código 1 se algum teste falhar.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------- configuração ----------

const WIN = process.platform === 'win32';
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = Number(process.env.CRM_TEST_PORTA) || 8793;
const TMP = path.resolve(process.env.CRM_TEST_TMP || path.join(os.tmpdir(), 'rk-painel-teste'));
// Nome curto de propósito: o workerd grava em <pasta>\v3\d1\miniflare-D1DatabaseObject\<64 hex>.sqlite-wal
// (mais 109 caracteres) e, passando de 259 no Windows, o D1 local responde só "internal error".
const PERSIST = path.join(TMP, 'db');
const PERSIST_DEMO = path.join(TMP, 'db3');   // parte 3 (demo ligada)
const WRANGLER = process.env.WRANGLER_JS
  || path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', 'd77349f55c2be1c0', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const BASE = `http://127.0.0.1:${PORTA}`;
const AMBIENTE = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' };
// as origens do wrangler.toml (produção). O site local de teste (http://localhost:8126) NÃO está aqui: ele entra
// só no wrangler dev dos testes ponta a ponta, com --var ORIGENS:http://localhost:8126.
const ORIGENS = ['https://painel.rkperformance.com.br', 'https://joaovitorrk.github.io'];
const SERVICO = 'painel de propostas RK';
const ERRO_VISITANTE = { erro: 'Modo visitante: nada é salvo nem publicado.' };

// ---------- mini harness ----------

let passou = 0;
const falhas = [];

function grupo(nome) { console.log(`\n${nome}`); }

async function teste(nome, fn) {
  try {
    await fn();
    passou++;
    console.log(`  ok      ${nome}`);
  } catch (e) {
    falhas.push(nome);
    const msg = String((e && e.message) || e).split('\n').slice(0, 30).join('\n          ');
    console.log(`  FALHOU  ${nome}\n          ${msg}`);
  }
}

const dormir = ms => new Promise(r => setTimeout(r, ms));
const mesmasChaves = (obj, chaves, onde = '') => assert.deepEqual(Object.keys(obj).sort(), [...chaves].sort(), `chaves ${onde}`);

// ---------- cliente HTTP (serve para o servidor de verdade e para o Worker dentro do Node) ----------

// `corpo` vai como JSON; `bruto` vai como está (também declarado como JSON, a não ser que `headers`
// diga outro content-type — a API recusa corpo fora de JSON com 415). `duplex: 'half'` para corpo em stream.
function clienteHttp(transporte) {
  return async (metodo, caminho, { token, corpo, bruto, headers, duplex } = {}) => {
    const h = { ...headers };
    if (token !== undefined && token !== null) h.authorization = `Bearer ${token}`;
    let body;
    if (bruto !== undefined) { body = bruto; if (!('content-type' in h)) h['content-type'] = 'application/json'; }
    else if (corpo !== undefined) { body = JSON.stringify(corpo); h['content-type'] = 'application/json'; }
    const res = await transporte(caminho, { method: metodo, headers: h, body, ...(duplex ? { duplex } : {}) });
    const texto = await res.text();
    let j = null;
    try { j = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
    return { status: res.status, json: j, texto, headers: res.headers };
  };
}

// ---------- dados de apoio ----------

const OP = ['simples', 'media', 'completa'];
const CHAVES_PAINEL = ['id', 'slug', 'status', 'etapa', 'dados', 'fechamento', 'valor_fechado', 'fechado_em', 'criado_em',
  'atualizado_em', 'views', 'primeira_vista', 'ultima_vista', 'publicada_alguma_vez'];
const CHAVES_DADOS = ['cliente', 'tipo', 'rotulos', 'data', 'hora', 'local', 'mensagem', 'opcoes', 'ordem', 'sugestao', 'inclui',
  'adicionais', 'condicoes', 'validade', 'observacoes', 'secoes'];
const CHAVES_OPCAO = ['on', 'nome', 'clima', 'itens', 'cerimonia', 'cerimonia_recepcao', 'ver_cerimonia', 'ver_recepcao'];
const ID_FALSO = '00000000-0000-4000-8000-000000000000';
const SUFIXO = '[a-hjkmnp-z2-9]{4}';   // 4 caracteres do alfabeto do link (sem i, l, o, 0, 1)
const ERRO_SESSAO = { erro: 'Sessão expirada. Entre de novo.' };

// rótulos dos dois valores de cada opção: os do modelo (Aurora Studio) e os que uma proposta sem rótulos (dado antigo) recebe
const ROTULOS_MODELO = { pacote_a: 'Evento', pacote_b: 'Evento + ensaio', nota_b: 'Inclui um ensaio fotográfico antes do evento, no lugar que vocês escolherem' };
const ROTULOS_PADRAO = { pacote_a: 'Cerimônia', pacote_b: 'Cerimônia + recepção', nota_b: '' };

// modelo padrão genérico — §7 da ESPEC (Aurora Studio, estúdio fictício de foto e vídeo de eventos)
const MODELO_PADRAO = {
  tipo: 'Casamento',
  rotulos: { ...ROTULOS_MODELO },
  opcoes: {
    simples: { on: true, nome: 'Essencial', clima: 'O essencial, bem feito', itens: '1 fotógrafo\n6 horas de cobertura\n300 fotos editadas\nGaleria online', cerimonia: 2400, cerimonia_recepcao: 3100, ver_cerimonia: true, ver_recepcao: true },
    media: { on: true, nome: 'Completa', clima: 'Foto e vídeo do começo ao fim', itens: '2 fotógrafos\n10 horas de cobertura\n600 fotos editadas\nVídeo resumo de 3 minutos', cerimonia: 4200, cerimonia_recepcao: 4900, ver_cerimonia: true, ver_recepcao: true },
    completa: { on: true, nome: 'Premium', clima: 'O dia inteiro, em foto e filme', itens: '2 fotógrafos e 1 videomaker\nDia inteiro\n900 fotos editadas\nFilme de 10 minutos e teaser', cerimonia: 6800, cerimonia_recepcao: 7500, ver_cerimonia: false, ver_recepcao: true },
  },
  ordem: ['completa', 'media', 'simples'],
  sugestao: '',
  inclui: 'Galeria online com download em alta\nEdição de cor em todas as fotos\nReunião de alinhamento antes do evento',
  adicionais: [
    { nome: 'Álbum impresso 30×30', descricao: '40 páginas, capa em linho', valor: 900 },
    { nome: 'Imagens de drone', descricao: '', valor: 600 },
    { nome: 'Segundo videomaker', descricao: '', valor: 1200 },
    { nome: 'Entrega expressa em 7 dias', descricao: '', valor: null },
  ],
  condicoes: '30% na reserva da data\nRestante até 7 dias antes do evento\nPix ou cartão em até 10x',
  validade_dias: 30,
  observacoes: '',
  secoes: { videos: true, depoimentos: true },
};

// as 3 opções com os dois valores à mostra (cada teste esconde o que precisa)
function tudoVisivel(ops) { for (const k of Object.keys(ops)) { ops[k].ver_cerimonia = true; ops[k].ver_recepcao = true; } return ops; }
const esconder = (d, campo) => { for (const k of OP) d.opcoes[k][campo] = false; };

// proposta completa e válida (cliente fictício de teste)
function dadosAna(extra = {}) {
  return {
    cliente: 'Ana & João', tipo: 'Casamento', rotulos: { ...ROTULOS_MODELO },
    data: '2027-05-15', hora: '', local: 'Igreja Matriz · Cidade de Teste', mensagem: '',
    opcoes: tudoVisivel(structuredClone(MODELO_PADRAO.opcoes)),
    ordem: ['simples', 'media', 'completa'], sugestao: '',
    inclui: MODELO_PADRAO.inclui,
    adicionais: structuredClone(MODELO_PADRAO.adicionais),
    condicoes: MODELO_PADRAO.condicoes,
    validade: '2027-01-31', observacoes: '',   // de propósito diferente de "hoje + 30 dias"
    secoes: { videos: true, depoimentos: true },
    ...extra,
  };
}

const hojeBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);   // UTC−3
const CENT = v => Math.round(v * 100) / 100;   // soma arredondada em centavos, como a API faz no resumo

// Corpo grande: o Worker responde 413 assim que passa do limite, antes de o cliente terminar de enviar.
// No `wrangler dev` o ProxyWorker local às vezes perde essa conexão, e quase sempre a seguinte também
// ("Error inside ProxyWorker … Network connection lost" → 500 em texto, resposta cortada sem corpo, ou
// ECONNRESET no cliente), mesmo com o Worker tendo respondido certo (o log mostra "413 Payload Too Large").
// Medido em 25 rodadas: a requisição seguinte cai 23 vezes e a próxima passa. Isso é do servidor local,
// não da API. `semProxy` repete só nesses casos: erro do próprio Worker é sempre JSON e nunca é tolerado.
async function semProxy(fazer, onde) {
  for (let i = 1; i <= 6; i++) {
    let r;
    try { r = await fazer(); } catch (e) {
      if (/ECONNRESET|EPIPE|socket|terminated|fetch failed/i.test(`${e && e.message} ${e && e.cause && (e.cause.code || e.cause.message)}`)) continue;
      throw e;
    }
    if (r.json === null && ((r.status === 500 && /Network connection lost/i.test(r.texto)) || r.texto === '')) continue;
    return r;
  }
  throw new Error(`${onde}: o proxy local derrubou todas as tentativas; não deu para ver a resposta do Worker`);
}
async function esperar413(fazer, onde) {
  const r = await semProxy(fazer, onde);
  assert.equal(r.status, 413, `${onde}: ${r.texto.slice(0, 200)}`);
  assert.deepEqual(r.json, { erro: 'Conteúdo grande demais.' }, onde);
  return r;
}
function maisDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- demo: a tabela da ESPEC §8, escrita aqui de novo (conferência independente do src/demo.js) ----------

// [NN, cliente, slug, etapa, status, n do sab(n) (ou de d(n), quando extra.dia), hora, local, extra]
//   extra.tipo = tipo do evento (sem ele, "Casamento") · extra.dia = true quando a data é d(n), em qualquer dia da semana
//   extra.fech = [opção, pacote, valor da opção, [[adicional, valor]…]] · extra.em = n do dia do fechamento / "não fechou"
//   extra.views = [quantas, n da primeira, n da última] · extra.validade = n do dia em que vence
//   extra.pag = o que foge da regra dos pagamentos (ESPEC §8.1): restanteVence, restantePago, sinalVence, sinalPendente
const TABELA_DEMO = [
  [1, 'Marina & Rafael', 'exemplo', 'aberta', 'publicada', 230, '16:00', 'Capela do Bosque · Campinas', { sugestao: 'media', views: [4, -3, -1], validade: 21 }],
  [2, 'Beatriz & Thiago', 'beatriz-e-thiago', 'fechada', 'publicada', 20, '16:00', 'Igreja Matriz · Niterói', { fech: ['completa', 'cerimonia_recepcao', 7500, [['Álbum impresso 30×30', 900]]], em: -140, pag: { restanteVence: -3 } }],
  [3, 'Formatura Medicina · Turma 48', 'formatura-medicina-turma-48', 'fechada', 'publicada', 20, '20:00', 'Clube Curitibano · Curitiba', { tipo: 'Formatura', fech: ['simples', 'cerimonia', 2400], em: -95, pag: { restantePago: -10 } }],
  [4, 'Helena · 15 anos', 'helena-15-anos', 'fechada', 'publicada', 48, '19:00', 'Espaço Villa · Florianópolis', { tipo: 'Aniversário de 15 anos', fech: ['media', 'cerimonia_recepcao', 4900], em: -60 }],
  [5, 'Lançamento Vértice Arquitetura', 'lancamento-vertice-arquitetura', 'fechada', 'publicada', 5, '19:30', 'Hotel Nacional · Belo Horizonte', { tipo: 'Evento corporativo', dia: true, fech: ['media', 'cerimonia', 4200], em: -33 }],
  [6, 'Fernanda & Caetano', 'fernanda-e-caetano', 'fechada', 'publicada', 120, '15:00', 'Paróquia Nossa Senhora · Londrina', { fech: ['completa', 'cerimonia_recepcao', 7500, [['Imagens de drone', 600], ['Segundo videomaker', 1200]]], em: -12 }],
  [7, 'Batizado do Miguel', 'batizado-do-miguel', 'fechada', 'publicada', 190, '10:00', 'Capela São Francisco · Campinas', { tipo: 'Batizado', fech: ['simples', 'cerimonia_recepcao', 3100], em: -5 }],
  [8, 'Aline & Bruno', 'aline-e-bruno', 'fechada', 'publicada', 260, '17:30', 'Igreja Matriz · São Paulo', { fech: ['completa', 'cerimonia', 6800], em: -2, pag: { sinalVence: 3, sinalPendente: true } }],
  [9, 'Bodas de prata · Lúcia & Antônio', 'bodas-de-prata-lucia-e-antonio', 'fechada', 'publicada', -30, '16:00', 'Capela do Bosque · Campinas', { tipo: 'Bodas', fech: ['media', 'cerimonia_recepcao', 4900], em: -200 }],
  [10, 'Formatura Direito · Turma 2026', 'formatura-direito-turma-2026', 'fechada', 'publicada', -75, '20:00', 'Teatro Municipal · Belo Horizonte', { tipo: 'Formatura', fech: ['simples', 'cerimonia', 2400], em: -230 }],
  [11, 'Isabela & Rodrigo', 'isabela-e-rodrigo', 'aberta', 'publicada', 13, '16:00', 'Igreja Matriz · São Paulo', { views: [2, -17, -6], validade: 12 }],
  [12, 'Cláudia · 50 anos', 'claudia-50-anos', 'aberta', 'publicada', 160, '17:00', 'Espaço Jardim · Campinas', { tipo: 'Aniversário', views: [0], validade: 27 }],
  [13, 'Vanessa & Leonardo', 'vanessa-e-leonardo', 'aberta', 'publicada', 48, '11:00', 'Capela Santa Luzia · Florianópolis', { views: [1, -25, -25], validade: 3 }],
  [14, 'Convenção Prisma 2027', 'convencao-prisma-2027', 'aberta', 'publicada', 100, '09:00', 'Centro de Eventos · Curitiba', { tipo: 'Evento corporativo', dia: true, views: [3, -33, -20], validade: -4 }],
  [15, 'Sofia & Daniel', 'sofia-e-daniel', 'aberta', 'rascunho', 400, '', '', { views: [0] }],
  [16, 'Carolina & Eduardo', 'carolina-e-eduardo', 'perdida', 'publicada', 140, '16:00', 'Igreja Matriz · Niterói', { motivo: 'Fechou com outro fornecedor', em: -20 }],
  [17, 'Formatura Engenharia · Turma 12', 'formatura-engenharia-turma-12', 'perdida', 'publicada', 210, '20:00', 'Clube Curitibano · Curitiba', { tipo: 'Formatura', motivo: 'Achou o valor alto', em: -45 }],
  [18, 'Priscila & Marcelo', 'priscila-e-marcelo', 'perdida', 'publicada', 90, '15:30', 'Espaço Jardim · Maringá', { motivo: 'Mudou os planos', em: -70 }],
];
const DEMO_ID = nn => `00000000-0000-4000-8000-0000000000${String(nn).padStart(2, '0')}`;
const COLUNAS_TABELA = ['id', 'slug', 'status', 'etapa', 'cliente', 'data_evento', 'dados', 'fechamento', 'valor_fechado',
  'fechado_em', 'criado_em', 'atualizado_em', 'views', 'primeira_vista', 'ultima_vista'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// sab(n): n ≥ 0 → o primeiro sábado em hoje + n ou depois; n < 0 → o último sábado em hoje + n ou antes
function sabEsperado(h, n) {
  const alvo = maisDias(h, n);
  for (let k = 0; k < 7; k++) {
    const d = maisDias(alvo, n >= 0 ? k : -k);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === 6) return d;
  }
  throw new Error('sem sábado na semana');
}

// confere as linhas do gerarDemo(h) contra a tabela acima
function conferirDemo(linhas, h) {
  assert.equal(linhas.length, 18);
  const { validade_dias, ...base } = MODELO_PADRAO;
  for (const [i, [nn, cliente, slug, etapa, status, n, hora, local, x]] of TABELA_DEMO.entries()) {
    const l = linhas[i], onde = `${h} #${nn} ${cliente}`;
    assert.deepEqual(Object.keys(l), COLUNAS_TABELA, onde);
    assert.equal(l.id, DEMO_ID(nn), onde);
    assert.equal(l.slug, slug, onde);
    assert.equal(l.cliente, cliente, onde);
    assert.equal(l.status, status, onde);
    assert.equal(l.etapa, etapa, onde);
    // casamentos e festas caem num sábado; eventos corporativos (extra.dia) em qualquer dia da semana
    const data = x.dia ? maisDias(h, n) : sabEsperado(h, n);
    assert.equal(l.data_evento, data, `${onde}: ${x.dia ? 'd' : 'sab'}(${n})`);
    if (!x.dia) {
      assert.equal(new Date(`${data}T12:00:00Z`).getUTCDay(), 6, `${onde}: é sábado`);
      if (n >= 0) assert.ok(data >= maisDias(h, n) && data <= maisDias(h, n + 6), onde);
      else assert.ok(data <= maisDias(h, n) && data >= maisDias(h, n - 6), onde);
    }
    // dados = modelo da §7 + cliente, tipo, data, hora, local, validade (e mensagem/sugestão só no exemplo)
    const dados = JSON.parse(l.dados);
    mesmasChaves(dados, status === 'publicada' ? [...CHAVES_DADOS, '_publicada_alguma_vez'] : CHAVES_DADOS, onde);
    if (status === 'publicada') assert.equal(dados._publicada_alguma_vez, true, onde);
    const { _publicada_alguma_vez, ...semMarca } = dados;
    assert.deepEqual(semMarca, {
      ...base, tipo: x.tipo || base.tipo, cliente, data, hora, local, sugestao: x.sugestao || '',
      mensagem: nn === 1 ? semMarca.mensagem : '',
      validade: x.validade !== undefined ? maisDias(h, x.validade) : semMarca.validade,
    }, onde);
    if (nn === 1) assert.ok(typeof dados.mensagem === 'string' && dados.mensagem.length > 20 && dados.mensagem.length <= 2000, 'mensagem do exemplo');
    assert.match(dados.validade, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(dados.validade > l.criado_em.slice(0, 10), `${onde}: vence depois de criada`);
    // carimbos: todos antes de hoje, criação antes da edição, aberturas depois da criação
    for (const k of ['criado_em', 'atualizado_em']) {
      assert.match(l[k], ISO, `${onde} ${k}`);
      assert.ok(l[k].slice(0, 10) < h, `${onde}: ${k} antes de hoje`);
    }
    assert.ok(l.criado_em <= l.atualizado_em, `${onde}: criado <= atualizado`);
    assert.ok(Number.isInteger(l.views) && l.views >= 0, onde);
    if (l.views === 0) {
      assert.equal(l.primeira_vista, null, onde);
      assert.equal(l.ultima_vista, null, onde);
    } else {
      for (const k of ['primeira_vista', 'ultima_vista']) {
        assert.match(l[k], ISO, `${onde} ${k}`);
        assert.ok(l[k].slice(0, 10) < h && l[k] > l.criado_em, `${onde} ${k}`);
      }
      assert.ok(l.primeira_vista <= l.ultima_vista, onde);
      if (l.views === 1) assert.equal(l.primeira_vista, l.ultima_vista, onde);
    }
    if (etapa === 'fechada') {
      const [opcao, pacote, valor, adic = []] = x.fech;
      const em = maisDias(h, x.em);
      const f = { opcao, pacote, valor, data: em, obs: '' };
      if (adic.length) f.adicionais = adic.map(([nome, v]) => ({ nome, valor: v }));
      // pagamentos: sinal de 10% recebido no dia em que fechou; restante 5 dias antes do evento, recebido se o evento passou
      const total = valor + adic.reduce((s, [, v]) => s + v, 0), pg = x.pag || {}, sinal = Math.round(total / 10);
      const venceR = pg.restanteVence !== undefined ? maisDias(h, pg.restanteVence) : maisDias(data, -5);
      f.pagamentos = [
        { tipo: 'sinal', valor: sinal, vence_em: pg.sinalVence !== undefined ? maisDias(h, pg.sinalVence) : em, pago_em: pg.sinalPendente ? '' : em },
        { tipo: 'restante', valor: total - sinal, vence_em: venceR, pago_em: pg.restantePago !== undefined ? maisDias(h, pg.restantePago) : (data < h ? venceR : '') },
      ];
      assert.deepEqual(JSON.parse(l.fechamento), f, onde);
      assert.equal(l.valor_fechado, valor + adic.reduce((s, [, v]) => s + v, 0), onde);
      assert.equal(l.fechado_em, em, onde);
      assert.equal(dados.opcoes[opcao][pacote], valor, `${onde}: o valor é o da opção no modelo`);
      assert.ok(l.criado_em.slice(0, 10) < em && l.atualizado_em.slice(0, 10) === em, `${onde}: criada antes de fechar`);
      assert.ok(l.views >= 1 && l.ultima_vista < l.atualizado_em, `${onde}: o cliente abriu antes de fechar`);
    } else if (etapa === 'perdida') {
      assert.deepEqual(JSON.parse(l.fechamento), { motivo: x.motivo }, onde);
      assert.equal(l.valor_fechado, null, onde);
      assert.equal(l.fechado_em, maisDias(h, x.em), onde);
      assert.ok(l.criado_em.slice(0, 10) < l.fechado_em && l.atualizado_em.slice(0, 10) === l.fechado_em, onde);
      if (l.views) assert.ok(l.ultima_vista < l.atualizado_em, onde);
    } else {
      assert.equal(l.fechamento, null, onde);
      assert.equal(l.valor_fechado, null, onde);
      assert.equal(l.fechado_em, null, onde);
      assert.equal(l.views, x.views[0], `${onde}: views`);
      if (x.views.length > 1) {
        assert.equal(l.primeira_vista.slice(0, 10), maisDias(h, x.views[1]), `${onde}: primeira abertura`);
        assert.equal(l.ultima_vista.slice(0, 10), maisDias(h, x.views[2]), `${onde}: última abertura`);
      }
    }
  }
  assert.equal(linhas[1].data_evento, linhas[2].data_evento, '02 e 03 no mesmo dia');
  assert.equal(linhas[3].data_evento, linhas[12].data_evento, '04 e 13 no mesmo dia');
  assert.equal(new Set(linhas.map(l => l.slug)).size, 18, 'slugs únicos');
}

// confere a lista do painel (GET /admin/propostas) contra as linhas da demo
function conferirNoPainel(lista, linhas, { ignorarViewsDe = [] } = {}) {
  assert.equal(lista.length, linhas.length, 'quantas propostas');
  for (const l of linhas) {
    const p = lista.find(x => x.id === l.id);
    assert.ok(p, `${l.slug} está no painel`);
    mesmasChaves(p, CHAVES_PAINEL, l.slug);
    mesmasChaves(p.dados, CHAVES_DADOS, l.slug);
    const { _publicada_alguma_vez, ...dados } = JSON.parse(l.dados);
    assert.deepEqual(p.dados, dados, l.slug);
    assert.equal(p.publicada_alguma_vez, l.status === 'publicada', l.slug);
    assert.deepEqual(p.fechamento, l.fechamento && JSON.parse(l.fechamento), l.slug);
    const pular = ignorarViewsDe.includes(l.slug) ? ['views', 'primeira_vista', 'ultima_vista'] : [];
    for (const k of ['slug', 'status', 'etapa', 'valor_fechado', 'fechado_em', 'criado_em', 'atualizado_em', 'views', 'primeira_vista', 'ultima_vista']) {
      if (!pular.includes(k)) assert.deepEqual(p[k], l[k], `${l.slug} ${k}`);
    }
  }
}

// token no mesmo formato da API: base64url({exp, papel}) + "." + HMAC-SHA256(chave, corpo), com a chave
// derivada do segredo do papel por PBKDF2 (SHA-256, 10 mil iterações, 32 bytes):
//   admin     → ADMIN_SENHA,  sal "rk-painel-sessao"
//   visitante → SESSAO_CHAVE, sal "rk-painel-visitante"
const SAL_ADMIN = 'rk-painel-sessao', SAL_VISITANTE = 'rk-painel-visitante';
const chaveDe = (segredo, sal) => nodeCrypto.pbkdf2Sync(segredo, sal, 10000, 32, 'sha256');
function forjar(senha, payload, chave = chaveDe(senha, SAL_ADMIN)) {
  const corpo = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)).toString('base64url');
  return `${corpo}.${nodeCrypto.createHmac('sha256', chave).update(corpo).digest('base64url')}`;
}
const forjarVisitante = (segredo, payload) => forjar(null, payload, chaveDe(segredo, SAL_VISITANTE));
// esquema antigo (chave = a senha crua), que não pode mais valer
const forjarCru = (senha, payload) => forjar(senha, payload, senha);
const corpoDoToken = t => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());
const agoraSeg = () => Math.floor(Date.now() / 1000);

function lerSegredos() {
  const arq = path.join(RAIZ, '.dev.vars');
  if (!fs.existsSync(arq)) throw new Error('Falta o .dev.vars. Rode antes: node tests/gerar-dev-vars.mjs');
  const texto = fs.readFileSync(arq, 'utf8');
  const ler = nome => {
    const m = texto.match(new RegExp(`^\\s*${nome}\\s*=\\s*(.+?)\\s*$`, 'm'));
    const v = m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : '';
    if (!v) throw new Error(`O .dev.vars não tem ${nome}. Rode: node tests/gerar-dev-vars.mjs`);
    return v;
  };
  return { senha: ler('ADMIN_SENHA'), chave: ler('SESSAO_CHAVE') };
}

// ---------- servidor (wrangler dev) ----------

let servidorPid = null;

function matarArvore(pid) {
  if (!pid) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch { /* já encerrou */ } }
}

function encerrarServidor() {
  if (servidorPid) matarArvore(servidorPid);
  servidorPid = null;
}
process.on('exit', encerrarServidor);
process.on('SIGINT', () => { encerrarServidor(); process.exit(130); });
process.on('SIGTERM', () => { encerrarServidor(); process.exit(143); });

function conecta(porta) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: porta });
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

// PIDs escutando na porta (netstat -ano), em qualquer endereço
function pidsNaPorta(porta) {
  if (!WIN) return [];
  const saida = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
  const pids = new Set();
  for (const linha of saida.split(/\r?\n/)) {
    const c = linha.trim().split(/\s+/);
    if (c[0] === 'TCP' && c.length >= 5 && c[1].endsWith(`:${porta}`) && /^(0\.0\.0\.0|\[::\]):0$/.test(c[2])) pids.add(c[4]);
  }
  return [...pids].filter(p => /^\d+$/.test(p) && p !== '0');
}

// nome, pai e linha de comando de um processo (Windows)
function infoProcesso(pid) {
  const comando = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.Name + '|' + $p.ParentProcessId + '|' + $p.CommandLine }`;
  const saida = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', comando], { encoding: 'utf8' }).stdout || '';
  const [nome = '', pai = '', ...cmd] = saida.trim().split('|');
  return { nome, pai: Number(pai) || 0, cmd: cmd.join('|') };
}

const portaOcupada = async porta => pidsNaPorta(porta).length > 0 || await conecta(porta);

// Se sobrou um wrangler de uma rodada anterior na porta, encerra (o wrangler inteiro, não só o
// workerd que escuta); se for outro programa, para e avisa.
async function liberarPorta(porta) {
  const ehWrangler = p => /^node(\.exe)?$/i.test(p.nome) && /wrangler/i.test(p.cmd);
  for (const pid of pidsNaPorta(porta)) {
    let p = infoProcesso(pid);
    if (!/^workerd(\.exe)?$/i.test(p.nome) && !ehWrangler(p)) {
      throw new Error(`A porta ${porta} está em uso por ${p.nome || 'outro programa'} (PID ${pid}). Feche esse programa e rode de novo.`);
    }
    // sobe até o "node …wrangler… dev" mais de cima: workerd ← cli.js ← wrangler.js
    let alvo = Number(pid);
    for (let i = 0; i < 4 && p.pai; i++) {
      const pai = infoProcesso(p.pai);
      if (!ehWrangler(pai)) break;
      alvo = p.pai;
      p = pai;
    }
    console.log(`  porta ${porta} ocupada por um wrangler que ficou aberto (PID ${alvo}): encerrando`);
    matarArvore(alvo);
  }
  for (let i = 0; i < 25; i++) {
    if (!(await portaOcupada(porta))) return;
    await dormir(200);
  }
  throw new Error(`Não consegui liberar a porta ${porta}.`);
}

// `--file=schema.sql` (banco novo) ou `--command=<sql>` no banco local da pasta indicada
function d1Local(persist, arg) {
  const r = spawnSync(process.execPath,
    [WRANGLER, 'd1', 'execute', 'rk-painel-demo', '--local', '--persist-to', persist, arg, '--yes'],
    { cwd: RAIZ, encoding: 'utf8', env: AMBIENTE });
  if (r.status !== 0) throw new Error(`O wrangler d1 execute falhou (${arg.slice(0, 60)}):\n${r.stdout || ''}${r.stderr || ''}`);
}
const aplicarSchema = persist => d1Local(persist, '--file=schema.sql');

// `extra`: argumentos a mais do wrangler dev (a parte 1 desliga a demo com --var DEMO:0)
function subirServidor(persist, extra = []) {
  const filho = spawn(process.execPath,
    [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORTA), '--persist-to', persist, ...extra],
    { cwd: RAIZ, env: AMBIENTE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  servidorPid = filho.pid;
  let log = '';
  const junta = b => { log = (log + b).slice(-6000); };
  filho.stdout.on('data', junta);
  filho.stderr.on('data', junta);
  return { filho, log: () => log };
}

async function esperarServidor(srv) {
  const limite = Date.now() + 90000;
  while (Date.now() < limite) {
    if (srv.filho.exitCode !== null) throw new Error(`O wrangler dev encerrou sozinho:\n${srv.log()}`);
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      const j = await r.json();
      if (j && j.servico === SERVICO) {
        if (!ehDoTeste(PORTA, srv.filho.pid)) throw new Error(`Quem responde na porta ${PORTA} não é o servidor que este teste subiu.`);
        return;
      }
    } catch (e) {
      if (/não é o servidor/.test(String(e && e.message))) throw e;   // o resto é só "ainda subindo"
    }
    await dormir(300);
  }
  throw new Error(`O wrangler dev não respondeu em 90 s:\n${srv.log()}`);
}

// Quem escuta na porta precisa ser filho (ou neto) do wrangler que este teste subiu:
// assim os testes nunca rodam, sem querer, contra o servidor (e o banco) de outra pessoa.
function ehDoTeste(porta, pidFilho) {
  if (!WIN) return true;
  const pids = pidsNaPorta(porta);
  return pids.length > 0 && pids.every(pid => {
    for (let p = Number(pid), i = 0; p && i < 6; i++) {
      if (p === pidFilho) return true;
      p = infoProcesso(p).pai;
    }
    return false;
  });
}

// ======================================================================================
// PARTE 1 — Worker de verdade
// ======================================================================================

async function parte1({ senha, chave }) {
  const api = clienteHttp((caminho, init) => fetch(BASE + caminho, init));
  let token = null;
  const admin = (metodo, caminho, corpo, extra) => api(metodo, caminho, { token, corpo, ...extra });
  const ver = async id => (await admin('GET', `/admin/propostas/${id}`)).json;
  const listar = async () => (await admin('GET', '/admin/propostas')).json;
  const criar = async (dados, status = 'publicada') => {
    const r = await admin('POST', '/admin/propostas', { dados, status });
    assert.equal(r.status, 201, `criar: ${r.texto}`);
    return r.json;
  };
  const etapa = (id, corpo) => admin('PUT', `/admin/propostas/${id}/etapa`, corpo);
  const apagar = id => admin('DELETE', `/admin/propostas/${id}`);

  // ---------------------------------------------------------------- básico
  grupo('Básico e CORS');

  await teste('GET / identifica o serviço', async () => {
    const r = await api('GET', '/');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, servico: SERVICO });
  });

  await teste('rota inexistente → 404 com { erro }', async () => {
    for (const [m, c] of [['GET', '/nada'], ['POST', '/'], ['DELETE', '/login'], ['GET', '/login'], ['POST', '/p/abc-1234'],
      ['GET', '/admin'], ['GET', '/p/AB'], ['GET', '/p/ab'], ['GET', '/p/abc-1234/extra'], ['PUT', '/p/abc-1234']]) {
      const r = await api(m, c);
      assert.equal(r.status, 404, `${m} ${c}`);
      mesmasChaves(r.json, ['erro'], `${m} ${c}`);
      assert.ok(typeof r.json.erro === 'string' && r.json.erro.length > 0);
      assert.match(r.headers.get('content-type') || '', /application\/json/);
    }
  });

  await teste('CORS: origens permitidas recebem os cabeçalhos', async () => {
    for (const origem of ORIGENS) {
      const r = await api('GET', '/', { headers: { origin: origem } });
      assert.equal(r.headers.get('access-control-allow-origin'), origem);
      for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.ok((r.headers.get('access-control-allow-methods') || '').includes(m), m);
      assert.match(r.headers.get('access-control-allow-headers') || '', /authorization/i);
      assert.match(r.headers.get('access-control-allow-headers') || '', /content-type/i);
      assert.match(r.headers.get('vary') || '', /origin/i);
    }
  });

  await teste('CORS: origem de fora não recebe permissão', async () => {
    for (const origem of ['https://evil.example', 'http://painel.rkperformance.com.br', 'https://painel.rkperformance.com.br.evil.example',
      'https://xpainel.rkperformance.com.br', 'https://rkperformance.com.br', 'https://joaovitorrk.github.io.evil.example',
      'https://outro.github.io', 'http://localhost:8124', 'http://localhost:8792', 'null',
      'http://localhost:8126']) {   // o site local de teste não vai para produção (wrangler.toml)
      const r = await api('GET', '/', { headers: { origin: origem } });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('access-control-allow-origin'), null, origem);
      assert.equal(r.headers.get('access-control-allow-methods'), null, origem);
    }
    const semOrigem = await api('GET', '/');
    assert.equal(semOrigem.headers.get('access-control-allow-origin'), null);
  });

  await teste('CORS: pré-voo (OPTIONS) responde 204, com permissão só para quem pode', async () => {
    const pre = { 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' };
    const ok = await api('OPTIONS', `/admin/propostas/${ID_FALSO}/etapa`, { headers: { origin: ORIGENS[0], ...pre } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGENS[0]);
    assert.ok((ok.headers.get('access-control-allow-methods') || '').includes('PUT'));
    const fora = await api('OPTIONS', '/admin/propostas', { headers: { origin: 'https://evil.example', ...pre } });
    assert.equal(fora.status, 204);
    assert.equal(fora.headers.get('access-control-allow-origin'), null);
  });

  await teste('CORS: resposta de erro também leva os cabeçalhos (o painel precisa ler a mensagem)', async () => {
    const r = await api('GET', '/admin/propostas', { headers: { origin: ORIGENS[0] } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGENS[0]);
  });

  // ---------------------------------------------------------------- login
  grupo('Login e sessão');

  await teste('login: sem senha ou com senha errada → 401', async () => {
    const tentativas = [{ corpo: {} }, { corpo: { senha: `${senha}x` } }, { corpo: { senha: 12345 } },
      { corpo: { senha: senha.slice(0, -1) } }, { bruto: '' }];   // 5 erros: ainda abaixo do limite de 8
    for (const t of tentativas) {
      const r = await api('POST', '/login', t);
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, { erro: 'Senha incorreta.' });
    }
  });

  await teste('login: JSON inválido → 400 (não conta como tentativa)', async () => {
    for (const bruto of ['{"senha":', 'senha=abc', '[1,2]', '"texto"', 'null', '42']) {
      const r = await api('POST', '/login', { bruto });
      assert.equal(r.status, 400, bruto);
      assert.deepEqual(r.json, { erro: 'JSON inválido.' });
    }
  });

  // Localmente o wrangler repassa o cf-connecting-ip que o cliente manda (na Cloudflare ele é sobrescrito
  // pelo IP real), então cada teste de login usa um "IP" próprio e não atrapalha os outros.
  await teste('login: corpo fora de JSON → 415 e não conta como tentativa (requisição "simples" de outro site)', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.10', origin: 'https://evil.example' };
    const corpo = JSON.stringify({ senha: 'x' });
    for (let i = 0; i < 3; i++) {
      for (const tipo of ['text/plain', 'text/plain;charset=UTF-8', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded']) {
        const r = await api('POST', '/login', { bruto: corpo, headers: { ...ip, 'content-type': tipo } });
        assert.equal(r.status, 415, tipo);
        assert.deepEqual(r.json, { erro: 'Envie o conteúdo em JSON.' });
        assert.equal(r.headers.get('access-control-allow-origin'), null, 'sem permissão de CORS para o site estranho');
      }
    }
    // POST vazio também é "simples" (fetch no-cors sem corpo): no login, sem content-type JSON é 415,
    // com ou sem content-type — senão uma página qualquer bloquearia o IP dela com 8 POSTs vazios
    for (let i = 0; i < 5; i++) {
      for (const headers of [{ ...ip }, { ...ip, 'content-type': 'text/plain' }, { ...ip, 'content-type': 'application/x-www-form-urlencoded' }]) {
        const r = await api('POST', '/login', { headers });
        assert.equal(r.status, 415, `sem corpo, content-type ${headers['content-type'] || '(nenhum)'}`);
        assert.deepEqual(r.json, { erro: 'Envie o conteúdo em JSON.' });
      }
    }
    // 27 recusadas: se tivessem contado, a próxima levaria 429
    const r = await api('POST', '/login', { corpo: { senha: 'errada' }, headers: ip });
    assert.equal(r.status, 401);
    // JSON com charset e em maiúsculas continua valendo
    for (const tipo of ['application/json; charset=utf-8', 'Application/JSON']) {
      assert.equal((await api('POST', '/login', { bruto: corpo, headers: { ...ip, 'content-type': tipo } })).status, 401, tipo);
    }
    // corpo vazio declarado como JSON (o painel manda o content-type em toda chamada) é tentativa comum
    assert.equal((await api('POST', '/login', { bruto: '', headers: ip })).status, 401, 'vazio em JSON');
    // 4 erros contados até aqui (1 + 2 + 1): ainda abaixo de 8, o IP continua livre
    assert.equal((await api('POST', '/login', { corpo: { senha }, headers: ip })).status, 200, 'senha certa entra');
    // o 415 vale nas rotas do painel também
    assert.equal((await api('PUT', '/admin/modelo', { bruto: corpo, token: 'x', headers: { 'content-type': 'text/plain' } })).status, 401, 'sessão primeiro');
  });

  await teste('login: senha certa → { token, exp, papel: "admin" } com sessão de 30 dias', async () => {
    const antes = agoraSeg();
    const r = await api('POST', '/login', { corpo: { senha } });
    assert.equal(r.status, 200);
    mesmasChaves(r.json, ['token', 'exp', 'papel']);
    assert.equal(r.json.papel, 'admin');
    assert.match(r.json.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(r.json.exp >= antes + 30 * 86400 - 5 && r.json.exp <= antes + 30 * 86400 + 60, 'exp = agora + 30 dias');
    assert.deepEqual(corpoDoToken(r.json.token), { exp: r.json.exp, papel: 'admin' });
    assert.ok(!r.texto.includes(senha), 'a resposta não devolve a senha');
    token = r.json.token;
  });
  if (!token) throw new Error('Sem login não dá para testar o painel.');

  await teste('esta instância roda com a demo desligada (--var DEMO:0): o painel começa vazio e /p/exemplo não existe', async () => {
    assert.deepEqual((await admin('GET', '/admin/propostas')).json, []);
    assert.equal((await api('GET', '/p/exemplo')).status, 404);
    assert.deepEqual((await admin('GET', '/admin/propostas')).json, []);
  });

  const ROTAS_ADMIN = [['GET', '/admin/propostas'], ['POST', '/admin/propostas'], ['GET', `/admin/propostas/${ID_FALSO}`],
    ['PUT', `/admin/propostas/${ID_FALSO}`], ['DELETE', `/admin/propostas/${ID_FALSO}`],
    ['POST', `/admin/propostas/${ID_FALSO}/duplicar`], ['PUT', `/admin/propostas/${ID_FALSO}/etapa`],
    ['GET', '/admin/p/abc-1234'], ['GET', '/admin/modelo'], ['PUT', '/admin/modelo'], ['GET', '/admin/resumo'],
    ['GET', '/admin/qualquer-coisa']];

  await teste('sessão: sem token → 401 em todas as rotas do painel', async () => {
    for (const [m, c] of ROTAS_ADMIN) {
      const r = await api(m, c);
      assert.equal(r.status, 401, `${m} ${c}`);
      assert.deepEqual(r.json, ERRO_SESSAO);
    }
  });

  await teste('sessão: token inválido, adulterado, de outra senha, de outro papel ou vencido → 401', async () => {
    const [c, s] = token.split('.');
    const agora = agoraSeg();
    const exp = agora + 3600;
    const ruins = {
      'lixo': 'abc',
      'vazio': '',
      'sem assinatura': `${c}.`,
      'sem corpo': `.${s}`,
      'assinatura adulterada': `${c}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`,
      'corpo trocado com a assinatura antiga': `${Buffer.from(JSON.stringify({ exp: agora + 999999999, papel: 'admin' })).toString('base64url')}.${s}`,
      'assinado com outra senha': forjar('outra-senha-qualquer', { exp, papel: 'admin' }),
      'assinado com a senha crua como chave (esquema antigo, sem PBKDF2)': forjarCru(senha, { exp, papel: 'admin' }),
      'vencido, mesmo bem assinado': forjar(senha, { exp: agora - 10, papel: 'admin' }),
      'três partes': `${token}.extra`,
      'sem exp': forjar(senha, { papel: 'admin' }),
      'exp em texto': forjar(senha, { exp: String(exp), papel: 'admin' }),
      'corpo que não é JSON': forjar(senha, 'isto não é json'),
      'corpo JSON que não é objeto': forjar(senha, '[1,2]'),
      'sem papel (formato antigo, só {exp})': forjar(senha, { exp }),
      'papel desconhecido': forjar(senha, { exp, papel: 'dono' }),
      'papel "Admin" (maiúscula)': forjar(senha, { exp, papel: 'Admin' }),
      'papel em lista': forjar(senha, { exp, papel: ['admin'] }),
      'papel "__proto__"': forjar(senha, { exp, papel: '__proto__' }),
      'papel "constructor"': forjar(senha, { exp, papel: 'constructor' }),
      '{papel:"admin"} assinado com a chave do visitante': forjarVisitante(chave, { exp, papel: 'admin' }),
      '{papel:"visitante"} assinado com a chave do admin': forjar(senha, { exp, papel: 'visitante' }),
      'visitante com a senha do admin no lugar da SESSAO_CHAVE': forjarVisitante(senha, { exp, papel: 'visitante' }),
      'admin com a SESSAO_CHAVE no lugar da senha': forjar(chave, { exp, papel: 'admin' }),
      'visitante vencido, mesmo bem assinado': forjarVisitante(chave, { exp: agora - 10, papel: 'visitante' }),
    };
    for (const [nome, t] of Object.entries(ruins)) {
      const r = await api('GET', '/admin/resumo', { token: t });
      assert.equal(r.status, 401, nome);
      assert.deepEqual(r.json, ERRO_SESSAO, nome);
    }
    for (const authorization of [token, `Basic ${token}`, `bearer ${token}`]) {
      const r = await api('GET', '/admin/resumo', { headers: { authorization } });
      assert.equal(r.status, 401, 'esquema diferente de "Bearer "');
    }
  });

  await teste('sessão: o token é um HMAC com a chave derivada do segredo do papel (bem assinado e no prazo, vale)', async () => {
    const r = await api('GET', '/admin/resumo', { token: forjar(senha, { exp: agoraSeg() + 600, papel: 'admin' }) });
    assert.equal(r.status, 200);
    // visitante bem assinado (chave derivada da SESSAO_CHAVE com o sal do visitante): sem a demo, não vale
    // (a parte 3, com DEMO = "1", prova que o mesmo token lê e não grava)
    const v = forjarVisitante(chave, { exp: agoraSeg() + 600, papel: 'visitante' });
    assert.deepEqual((await api('GET', '/admin/resumo', { token: v })).json, ERRO_SESSAO);
    const w = await api('PUT', '/admin/modelo', { token: v, corpo: { dados: MODELO_PADRAO } });
    assert.equal(w.status, 401);
    assert.deepEqual(w.json, ERRO_SESSAO);
    // o 415 das rotas do painel vem depois da sessão
    const t = await admin('PUT', '/admin/modelo', undefined, { bruto: '{"dados":{}}', headers: { 'content-type': 'text/plain' } });
    assert.equal(t.status, 415);
    assert.deepEqual(t.json, { erro: 'Envie o conteúdo em JSON.' });
  });

  await teste('painel: rota inexistente com sessão → 404', async () => {
    for (const [m, c] of [['GET', '/admin/qualquer-coisa'], ['GET', '/admin/propostas/xyz'], ['PATCH', `/admin/propostas/${ID_FALSO}`],
      ['DELETE', '/admin/modelo'], ['POST', '/admin/resumo'], ['GET', `/admin/propostas/${ID_FALSO}/etapa`]]) {
      const r = await admin(m, c);
      assert.equal(r.status, 404, `${m} ${c}`);
      assert.deepEqual(r.json, { erro: 'Não encontrado.' });
    }
  });

  // ---------------------------------------------------------------- modelo
  grupo('Modelo padrão');

  await teste('modelo: GET devolve o modelo padrão genérico (ESPEC §7)', async () => {
    const r = await admin('GET', '/admin/modelo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, MODELO_PADRAO);
    assert.deepEqual(Object.keys(r.json.opcoes), OP);
  });

  await teste('modelo: PUT limpa, tira os campos de cada cliente e guarda validade_dias', async () => {
    const r = await admin('PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, cliente: 'Não devia ficar', data: '2027-01-01',
      local: 'X', mensagem: 'Y', validade: '2027-01-01', validade_dias: 45, observacoes: 'Obs do modelo', hack: 1, etapa: 'fechada' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ...MODELO_PADRAO, validade_dias: 45, observacoes: 'Obs do modelo' });
    assert.deepEqual((await admin('GET', '/admin/modelo')).json, r.json);
  });

  await teste('modelo: validade_dias fica entre 1 e 365 (padrão 30)', async () => {
    for (const [entra, sai] of [[0, 30], [999, 365], [-5, 1], ['abc', 30], [12.6, 13], [undefined, 30], [null, 30], [365, 365], [1, 1]]) {
      const r = await admin('PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, validade_dias: entra } });
      assert.equal(r.json.validade_dias, sai, `validade_dias ${entra}`);
    }
  });

  await teste('modelo: PUT sem dados → 400 e o modelo continua como estava', async () => {
    const antes = (await admin('GET', '/admin/modelo')).json;
    for (const corpo of [{}, { dados: null }, { dados: 'texto' }, { dados: [1] }, { dados: 0 }]) {
      const r = await admin('PUT', '/admin/modelo', corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo));
      assert.deepEqual(r.json, { erro: 'Dados inválidos.' });
    }
    assert.deepEqual((await admin('GET', '/admin/modelo')).json, antes);
  });

  await teste('proposta nova: validade = hoje (Brasília) + validade_dias do modelo', async () => {
    await admin('PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, validade_dias: 45 } });
    const r = await admin('POST', '/admin/propostas');
    assert.equal(r.json.dados.validade, maisDias(hojeBr(), 45));
    assert.ok(!('validade_dias' in r.json.dados), 'validade_dias é só do modelo');
    await apagar(r.json.id);
    const volta = await admin('PUT', '/admin/modelo', { dados: MODELO_PADRAO });
    assert.deepEqual(volta.json, MODELO_PADRAO);
  });

  // ---------------------------------------------------------------- criar
  grupo('Criar e validar');
  let rascunho, ana;

  await teste('criar sem corpo → rascunho em aberto a partir do modelo', async () => {
    const r = await admin('POST', '/admin/propostas');
    assert.equal(r.status, 201);
    const p = r.json;
    mesmasChaves(p, CHAVES_PAINEL);
    mesmasChaves(p.dados, CHAVES_DADOS);
    assert.match(p.id, /^[a-f0-9-]{36}$/);
    assert.match(p.slug, new RegExp(`^proposta-${SUFIXO}$`));
    assert.equal(p.status, 'rascunho');
    assert.equal(p.etapa, 'aberta');
    assert.equal(p.fechamento, null);
    assert.equal(p.valor_fechado, null);
    assert.equal(p.fechado_em, null);
    assert.equal(p.views, 0);
    assert.equal(p.primeira_vista, null);
    assert.equal(p.ultima_vista, null);
    assert.equal(p.publicada_alguma_vez, false);
    assert.match(p.criado_em, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(p.atualizado_em, p.criado_em);
    const { validade_dias, ...resto } = MODELO_PADRAO;
    assert.deepEqual(p.dados, { ...resto, cliente: '', data: '', hora: '', local: '', mensagem: '', validade: maisDias(hojeBr(), validade_dias) });
    rascunho = p;
  });

  await teste('criar com corpo e status publicada → publicada, link pelo nome', async () => {
    const dados = dadosAna();
    const r = await admin('POST', '/admin/propostas', { dados, status: 'publicada' });
    assert.equal(r.status, 201);
    mesmasChaves(r.json, CHAVES_PAINEL);
    assert.match(r.json.slug, new RegExp(`^ana-e-joao-${SUFIXO}$`));
    assert.equal(r.json.status, 'publicada');
    assert.equal(r.json.etapa, 'aberta');
    assert.equal(r.json.publicada_alguma_vez, true);
    assert.deepEqual(r.json.dados, dados);                 // inclusive a validade enviada
    assert.deepEqual(Object.keys(r.json.dados.opcoes), OP);
    ana = r.json;
    assert.deepEqual(await ver(ana.id), ana);
  });

  await teste('publicar sem nome do cliente → 400 "Coloque o nome do cliente."', async () => {
    const antes = (await listar()).length;
    for (const cliente of ['', '   ', undefined, 42]) {
      const r = await admin('POST', '/admin/propostas', { dados: dadosAna({ cliente }), status: 'publicada' });
      assert.equal(r.status, 400, `cliente ${JSON.stringify(cliente)}`);
      assert.deepEqual(r.json, { erro: 'Coloque o nome do cliente.' });
    }
    assert.equal((await listar()).length, antes, 'nada foi gravado');
  });

  await teste('publicar sem opção ligada com valor → 400 "Marque pelo menos uma opção com valor."', async () => {
    const antes = (await listar()).length;
    const casos = {
      'todas desligadas': d => { for (const k of OP) d.opcoes[k].on = false; },
      'sem valor de cerimônia e com o pacote com recepção escondido': d => { for (const k of OP) d.opcoes[k].cerimonia = null; esconder(d, 'ver_recepcao'); },
      'cerimônia escondida e sem valor com recepção': d => { esconder(d, 'ver_cerimonia'); for (const k of OP) d.opcoes[k].cerimonia_recepcao = null; },
      'os dois valores escondidos em todas': d => { esconder(d, 'ver_cerimonia'); esconder(d, 'ver_recepcao'); },
      'valor só na opção desligada': d => { d.opcoes.simples.on = false; d.opcoes.media.cerimonia = null; d.opcoes.completa.cerimonia = null; esconder(d, 'ver_recepcao'); },
      'valor zero': d => { for (const k of OP) d.opcoes[k].cerimonia = 0; esconder(d, 'ver_recepcao'); },
      'valor em texto': d => { for (const k of OP) d.opcoes[k].cerimonia = '2500'; esconder(d, 'ver_recepcao'); },
      'valor negativo': d => { for (const k of OP) d.opcoes[k].cerimonia = -2500; esconder(d, 'ver_recepcao'); },
      'sem o campo opcoes': d => { delete d.opcoes; },
      'on que não é true': d => { for (const k of OP) d.opcoes[k].on = 'sim'; },
    };
    for (const [nome, mexe] of Object.entries(casos)) {
      const d = dadosAna();
      mexe(d);
      const r = await admin('POST', '/admin/propostas', { dados: d, status: 'publicada' });
      assert.equal(r.status, 400, nome);
      assert.deepEqual(r.json, { erro: 'Marque pelo menos uma opção com valor.' }, nome);
    }
    // basta uma opção ligada com valor
    const d = dadosAna({ cliente: 'Só uma opção' });
    d.opcoes.simples.on = false; d.opcoes.completa.on = false; d.opcoes.media.cerimonia_recepcao = null;
    const ok = await admin('POST', '/admin/propostas', { dados: d, status: 'publicada' });
    assert.equal(ok.status, 201);
    await apagar(ok.json.id);
    assert.equal((await listar()).length, antes, 'nada foi gravado');
  });

  await teste('só o pacote com recepção (valor da cerimônia escondido) pode ser publicado', async () => {
    const d = dadosAna({ cliente: 'Só recepção' });
    esconder(d, 'ver_cerimonia');
    const r = await admin('POST', '/admin/propostas', { dados: d, status: 'publicada' });
    assert.equal(r.status, 201);
    assert.equal(r.json.dados.opcoes.media.ver_cerimonia, false);
    // o valor da cerimônia continua guardado: é só não mostrar
    assert.equal(r.json.dados.opcoes.media.cerimonia, 4200);
    const pub = await api('GET', `/p/${r.json.slug}`);
    assert.equal(pub.json.dados.opcoes.media.ver_cerimonia, false);
    await apagar(r.json.id);
  });

  await teste('ordem: lista livre das 3 opções (sem repetir; o que faltar vai para o fim); dado antigo "cara" ordena pelo maior valor', async () => {
    const N = ['simples', 'media', 'completa'];
    for (const [entra, sai] of [
      [['completa', 'media', 'simples'], ['completa', 'media', 'simples']],
      [['media', 'completa', 'simples'], ['media', 'completa', 'simples']],
      [['media'], ['media', 'simples', 'completa']],
      [['x', 'media', 'media', 'completa'], ['media', 'completa', 'simples']],
      [undefined, N], ['simples', N], ['qualquer', N], [1, N], [[], N],
      ['cara', ['completa', 'media', 'simples']],
    ]) {
      const r = await admin('POST', '/admin/propostas', { dados: dadosAna({ ordem: entra }), status: 'rascunho' });
      assert.deepEqual(r.json.dados.ordem, sai, JSON.stringify(entra));
      await apagar(r.json.id);
    }
  });

  await teste('cada opção escolhe o que mostrar: junto, separado ou só cerimônia', async () => {
    const d = dadosAna({ cliente: 'Cada uma do seu jeito', ordem: ['completa', 'media', 'simples'] });
    d.opcoes.completa.ver_cerimonia = false;                                          // junto: só cerimônia + recepção
    d.opcoes.simples.ver_recepcao = false;                                            // só cerimônia
    const r = await admin('POST', '/admin/propostas', { dados: d, status: 'publicada' });
    assert.equal(r.status, 201);
    const o = r.json.dados.opcoes;
    assert.deepEqual([o.completa.ver_cerimonia, o.completa.ver_recepcao], [false, true]);
    assert.deepEqual([o.media.ver_cerimonia, o.media.ver_recepcao], [true, true]);   // separado: os dois valores
    assert.deepEqual([o.simples.ver_cerimonia, o.simples.ver_recepcao], [true, false]);
    assert.deepEqual(r.json.dados.ordem, ['completa', 'media', 'simples']);
    // a opção com os dois escondidos não conta como "com valor"
    const s = dadosAna({ cliente: 'Escondidas' });
    for (const k of OP) { s.opcoes[k].ver_cerimonia = false; s.opcoes[k].ver_recepcao = false; }
    s.opcoes.media.ver_recepcao = true; s.opcoes.media.cerimonia_recepcao = null;
    const x = await admin('POST', '/admin/propostas', { dados: s, status: 'publicada' });
    assert.equal(x.status, 400);
    await apagar(r.json.id);
  });

  await teste('dado antigo: as chaves globais viram a escolha de cada opção e não saem mais na resposta', async () => {
    const d = dadosAna({ cliente: 'Antiga', mostrar_cerimonia: false, mostrar_recepcao: true });
    for (const k of OP) { delete d.opcoes[k].ver_cerimonia; delete d.opcoes[k].ver_recepcao; }
    const r = await admin('POST', '/admin/propostas', { dados: d, status: 'rascunho' });
    for (const k of OP) assert.deepEqual([r.json.dados.opcoes[k].ver_cerimonia, r.json.dados.opcoes[k].ver_recepcao], [false, true], k);
    assert.equal(r.json.dados.mostrar_cerimonia, undefined);
    assert.equal(r.json.dados.mostrar_recepcao, undefined);
    await apagar(r.json.id);
  });

  await teste('horário do evento: HH:MM de 00:00 a 23:59; o resto vira vazio; o modelo não guarda horário', async () => {
    for (const [entra, sai] of [['16:30', '16:30'], ['00:00', '00:00'], ['23:59', '23:59'], ['9:30', ''], ['24:00', ''], ['16h30', ''], ['16:60', ''], [1630, ''], ['', '']]) {
      const r = await admin('POST', '/admin/propostas', { dados: dadosAna({ hora: entra }), status: 'rascunho' });
      assert.equal(r.status, 201);
      assert.equal(r.json.dados.hora, sai, JSON.stringify(entra));
      await apagar(r.json.id);
    }
    const m = await admin('PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, hora: '16:00' } });
    assert.equal(m.json.hora, undefined);
    await admin('PUT', '/admin/modelo', { dados: MODELO_PADRAO });
  });

  await teste('rascunho não exige nome nem valor; status desconhecido vira rascunho', async () => {
    const d = dadosAna({ cliente: '' });
    for (const k of OP) d.opcoes[k].on = false;
    const r = await admin('POST', '/admin/propostas', { dados: d, status: 'rascunho' });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'rascunho');
    const r2 = await admin('POST', '/admin/propostas', { dados: dadosAna(), status: 'qualquer' });
    assert.equal(r2.status, 201);
    assert.equal(r2.json.status, 'rascunho');
    assert.equal(r2.json.publicada_alguma_vez, false);
    await apagar(r.json.id);
    await apagar(r2.json.id);
  });

  await teste('criar com dados que não são um objeto → 400', async () => {
    const antes = (await listar()).length;
    for (const dados of ['texto', 42, [1, 2], true, 0, false, '']) {
      const r = await admin('POST', '/admin/propostas', { dados, status: 'rascunho' });
      assert.equal(r.status, 400, JSON.stringify(dados));
      assert.deepEqual(r.json, { erro: 'Dados inválidos.' });
    }
    assert.equal((await listar()).length, antes);
  });

  await teste('preço que estoura (1e307) ou passa do teto vira null: publicar exige valor de verdade', async () => {
    const antes = (await listar()).length;
    for (const v of [1e307, 1e308, 1e20, 1e10, 100000000, 99999999.995]) {
      const d = dadosAna(); esconder(d, 'ver_recepcao');
      for (const k of OP) d.opcoes[k].cerimonia = v;
      const r = await admin('POST', '/admin/propostas', { dados: d, status: 'publicada' });
      assert.equal(r.status, 400, `cerimonia ${v}`);
      assert.deepEqual(r.json, { erro: 'Marque pelo menos uma opção com valor.' });
    }
    assert.equal((await listar()).length, antes, 'nada foi gravado');
    // em rascunho o valor some (null), nunca vira Infinity/null "por acidente" no JSON
    const d = dadosAna({ adicionais: [{ nome: 'Caro', valor: 1e307 }, { nome: 'No teto', valor: 99999999.99 }, { nome: 'Acima', valor: 1e8 }] });
    d.opcoes.simples.cerimonia = 1e307; d.opcoes.simples.cerimonia_recepcao = 99999999.994;
    d.opcoes.media.cerimonia = 99999999.99; d.opcoes.completa.cerimonia = 1e20;
    const r = await admin('POST', '/admin/propostas', { dados: d, status: 'rascunho' });
    assert.equal(r.status, 201);
    assert.equal(r.json.dados.opcoes.simples.cerimonia, null);
    assert.equal(r.json.dados.opcoes.simples.cerimonia_recepcao, 99999999.99);
    assert.equal(r.json.dados.opcoes.media.cerimonia, 99999999.99);
    assert.equal(r.json.dados.opcoes.completa.cerimonia, null);
    assert.deepEqual(r.json.dados.adicionais.map(a => a.valor), [null, 99999999.99, null]);
    assert.ok(!r.texto.includes('Infinity') && !r.texto.includes('e+'), r.texto.slice(0, 200));
    await apagar(r.json.id);
  });

  // ---------------------------------------------------------------- limpar()
  grupo('limpar(): formato, limites e campos estranhos');

  await teste('descarta campos estranhos e respeita os limites', async () => {
    const sujo = {
      cliente: `   ${'A'.repeat(130)}   `,
      tipo: 'T'.repeat(100),
      rotulos: { pacote_a: 'R'.repeat(50), pacote_b: '   ', nota_b: 'N'.repeat(150), hack: 1 },
      data: '15/05/2027',
      local: 'L'.repeat(250),
      mensagem: 'M'.repeat(2100),
      opcoes: {
        completa: { on: 'sim', nome: 'N'.repeat(70), clima: 'C'.repeat(130), itens: 'I'.repeat(700), cerimonia: -1, cerimonia_recepcao: '6500', hack: 1 },
        extra: { on: true, nome: 'Quarta opção', cerimonia: 1 },
        simples: { on: true, nome: 'Duo', clima: 7, itens: 'Voz', cerimonia: 2500.129, cerimonia_recepcao: null, hack: '<script>' },
        // media não veio
      },
      hora: '25:99',
      ordem: 'qualquer',
      mostrar_cerimonia: 'nao',
      mostrar_recepcao: false,
      sugestao: 'extra',
      inclui: 'X'.repeat(700),
      adicionais: [
        null, 'texto', { nome: 5 }, {}, { nome: '', descricao: '', valor: null },              // somem
        { nome: 'N'.repeat(130), descricao: 'D'.repeat(310), valor: 99.999, extra: 'x' },
        { nome: 'Só nome' }, { descricao: 'Só descrição' }, { valor: 150 }, { nome: 'Negativo', valor: -5 }, { nome: 'Texto', valor: '300' },
        ...Array.from({ length: 25 }, (_, i) => ({ nome: `Extra ${i + 1}`, valor: i })),
      ],
      condicoes: 'K'.repeat(1600),
      validade: '2026-13-45',
      observacoes: 'O'.repeat(1600),
      secoes: { videos: false, depoimentos: 'x', formatos: true },
      // nada disto faz parte do formato
      etapa: 'fechada', fechamento: { valor: 1 }, valor_fechado: 999, fechado_em: '2026-01-01', views: 50,
      idioma: 'en', moeda: 'USD', total: 1, validade_dias: 99, _publicada_alguma_vez: true, hack: '<script>',
    };
    const r = await admin('POST', '/admin/propostas', { dados: sujo, status: 'rascunho', etapa: 'fechada', valor_fechado: 5,
      fechamento: { valor: 5 }, views: 99, slug: 'meu-slug', id: 'meu-id' });
    assert.equal(r.status, 201);
    const p = r.json, d = p.dados;
    mesmasChaves(p, CHAVES_PAINEL);
    mesmasChaves(d, CHAVES_DADOS);
    // o que é do sistema não vem do corpo
    assert.equal(p.etapa, 'aberta');
    assert.equal(p.valor_fechado, null);
    assert.equal(p.fechamento, null);
    assert.equal(p.fechado_em, null);
    assert.equal(p.views, 0);
    assert.equal(p.publicada_alguma_vez, false);
    assert.notEqual(p.slug, 'meu-slug');
    assert.notEqual(p.id, 'meu-id');
    // limites de texto
    assert.equal(d.cliente, 'A'.repeat(120));
    assert.equal(d.tipo, 'T'.repeat(80));
    // rótulos: 40/60/140 letras; rótulo em branco volta ao padrão, nota em branco fica vazia
    assert.deepEqual(d.rotulos, { pacote_a: 'R'.repeat(40), pacote_b: ROTULOS_PADRAO.pacote_b, nota_b: 'N'.repeat(140) });
    assert.equal(d.data, '');
    assert.equal(d.local, 'L'.repeat(200));
    assert.equal(d.mensagem, 'M'.repeat(2000));
    assert.equal(d.inclui, 'X'.repeat(600));
    assert.equal(d.condicoes, 'K'.repeat(1500));
    assert.equal(d.observacoes, 'O'.repeat(1500));
    // sempre as 3 opções, nesta ordem, só com os campos combinados
    assert.deepEqual(Object.keys(d.opcoes), OP);
    for (const k of OP) mesmasChaves(d.opcoes[k], CHAVES_OPCAO, k);
    assert.deepEqual(d.opcoes.simples, { on: true, nome: 'Duo', clima: '', itens: 'Voz', cerimonia: 2500.13, cerimonia_recepcao: null, ver_cerimonia: true, ver_recepcao: false });
    assert.deepEqual(d.opcoes.media, { on: false, nome: '', clima: '', itens: '', cerimonia: null, cerimonia_recepcao: null, ver_cerimonia: true, ver_recepcao: false });
    assert.deepEqual(d.opcoes.completa, { on: false, nome: 'N'.repeat(60), clima: 'C'.repeat(120), itens: 'I'.repeat(600), cerimonia: null, cerimonia_recepcao: null, ver_cerimonia: true, ver_recepcao: false });
    assert.equal(d.mostrar_recepcao, undefined);
    assert.equal(d.hora, '');
    assert.deepEqual(d.ordem, ['simples', 'media', 'completa']);
    assert.equal(d.mostrar_cerimonia, undefined);
    assert.equal(d.sugestao, '');
    // adicionais: no máximo 20, só nome/descricao/valor, vazios fora
    assert.equal(d.adicionais.length, 20);
    for (const a of d.adicionais) mesmasChaves(a, ['nome', 'descricao', 'valor']);
    assert.deepEqual(d.adicionais.slice(0, 7), [
      { nome: 'N'.repeat(120), descricao: 'D'.repeat(300), valor: 100 },
      { nome: 'Só nome', descricao: '', valor: null },
      { nome: '', descricao: 'Só descrição', valor: null },
      { nome: '', descricao: '', valor: 150 },
      { nome: 'Negativo', descricao: '', valor: null },
      { nome: 'Texto', descricao: '', valor: null },
      { nome: 'Extra 1', descricao: '', valor: 0 },
    ]);
    assert.equal(d.adicionais[19].nome, 'Extra 14');
    // data inválida é descartada; como é proposta nova, ganha a validade do modelo
    assert.equal(d.validade, maisDias(hojeBr(), 30));
    assert.deepEqual(d.secoes, { videos: false, depoimentos: true });
    for (const proibido of ['hack', 'idioma', 'moeda', 'validade_dias', '_publicada', '<script>', 'Quarta opção', 'formatos', '"total"']) {
      assert.ok(!r.texto.includes(proibido), `sobrou "${proibido}"`);
    }
    await apagar(p.id);
  });

  await teste('valores padrão quando o campo não vem', async () => {
    const r = await admin('POST', '/admin/propostas', { dados: { cliente: 'Mínimo' }, status: 'rascunho' });
    assert.equal(r.status, 201);
    const vazia = { on: false, nome: '', clima: '', itens: '', cerimonia: null, cerimonia_recepcao: null, ver_cerimonia: true, ver_recepcao: true };
    assert.deepEqual(r.json.dados, {
      cliente: 'Mínimo', tipo: '', rotulos: { ...ROTULOS_PADRAO }, data: '', hora: '', local: '', mensagem: '',
      opcoes: { simples: vazia, media: vazia, completa: vazia },
      ordem: ['simples', 'media', 'completa'], sugestao: '', inclui: '', adicionais: [], condicoes: '',
      validade: maisDias(hojeBr(), 30), observacoes: '', secoes: { videos: true, depoimentos: true },
    });
    await apagar(r.json.id);
  });

  await teste('corte no limite não deixa meio emoji; aspas e SQL no texto ficam como texto', async () => {
    const r = await admin('POST', '/admin/propostas', { dados: { cliente: `${'A'.repeat(119)}😀` }, status: 'rascunho' });
    assert.equal(r.json.dados.cliente, 'A'.repeat(119));
    await apagar(r.json.id);
    const nome = `Robert'); DROP TABLE propostas;-- "aspas" <b>`;
    const s = await admin('POST', '/admin/propostas', { dados: { cliente: nome }, status: 'rascunho' });
    assert.equal(s.status, 201);
    assert.equal(s.json.dados.cliente, nome);
    assert.match(s.json.slug, /^[a-z0-9-]{3,80}$/);
    assert.ok(Array.isArray(await listar()), 'a tabela continua lá');
    await apagar(s.json.id);
  });

  await teste('datas: só AAAA-MM-DD e só dia que existe', async () => {
    for (const [entra, sai] of [['2027-05-15', '2027-05-15'], ['2028-02-29', '2028-02-29'], ['2027-02-29', ''], ['2027-13-01', ''],
      ['2027-00-10', ''], ['2027-04-31', ''], ['15/05/2027', ''], ['2027-5-15', ''], ['2027-05-15T10:00', ''], [20270515, ''], [null, '']]) {
      const r = await admin('PUT', `/admin/propostas/${rascunho.id}`, { dados: { ...rascunho.dados, data: entra, validade: entra }, status: 'rascunho' });
      assert.equal(r.status, 200);
      assert.equal(r.json.dados.data, sai, `data ${entra}`);
      assert.equal(r.json.dados.validade, sai, `validade ${entra}`);
    }
    rascunho = (await admin('PUT', `/admin/propostas/${rascunho.id}`, { dados: rascunho.dados, status: 'rascunho' })).json;
  });

  await teste('sugestão que aponta para opção desligada vira ""', async () => {
    const put = async dados => (await admin('PUT', `/admin/propostas/${ana.id}`, { dados, status: 'publicada' })).json;
    const d = dadosAna({ sugestao: 'media' });
    d.opcoes.media.on = false;
    assert.equal((await put(d)).dados.sugestao, '');
    assert.equal((await put(dadosAna({ sugestao: 'completa' }))).dados.sugestao, 'completa');   // ligada: fica
    for (const s of ['outro', 'Simples', 1, null, ['media'], 'toString']) {
      assert.equal((await put(dadosAna({ sugestao: s }))).dados.sugestao, '', `sugestão ${JSON.stringify(s)}`);
    }
    // no modelo vale a mesma regra
    const opcoes = structuredClone(MODELO_PADRAO.opcoes);
    opcoes.simples.on = false;
    const m = await admin('PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, opcoes, sugestao: 'simples' } });
    assert.equal(m.json.sugestao, '');
    assert.deepEqual((await admin('PUT', '/admin/modelo', { dados: MODELO_PADRAO })).json, MODELO_PADRAO);
    ana = await put(dadosAna());
    assert.deepEqual(ana.dados, dadosAna());
  });

  // ---------------------------------------------------------------- slug
  grupo('Link (slug)');

  await teste('acompanha o nome enquanto é rascunho nunca publicado; depois fica fixo', async () => {
    const nova = (await admin('POST', '/admin/propostas')).json;
    const put = async corpo => {
      const r = await admin('PUT', `/admin/propostas/${nova.id}`, corpo);
      assert.equal(r.status, 200, r.texto);
      return r.json;
    };
    let p = await put({ dados: dadosAna({ cliente: 'Maria & José' }), status: 'rascunho' });
    assert.match(p.slug, new RegExp(`^maria-e-jose-${SUFIXO}$`));
    assert.notEqual(p.slug, nova.slug);
    const deRascunho = p.slug;
    p = await put({ dados: dadosAna({ cliente: 'Maria & José', local: 'Outro local' }), status: 'rascunho' });
    assert.equal(p.slug, deRascunho, 'mesmo nome: mesmo link');
    assert.equal(p.publicada_alguma_vez, false);
    // publicar trocando o nome na mesma chamada: o link ainda não saiu, então acompanha
    p = await put({ dados: dadosAna({ cliente: 'Maria Clara & José' }), status: 'publicada' });
    assert.match(p.slug, new RegExp(`^maria-clara-e-jose-${SUFIXO}$`));
    const fixo = p.slug;
    assert.equal(p.publicada_alguma_vez, true);
    // publicado: o link não muda mais
    p = await put({ dados: dadosAna({ cliente: 'Outro Nome' }), status: 'publicada' });
    assert.equal(p.slug, fixo);
    assert.equal(p.dados.cliente, 'Outro Nome');
    // voltou a rascunho: continua fixo, e o público deixa de ver
    p = await put({ dados: dadosAna({ cliente: 'Mais Um Nome' }), status: 'rascunho' });
    assert.equal(p.slug, fixo);
    assert.equal(p.status, 'rascunho');
    assert.equal(p.publicada_alguma_vez, true);
    assert.equal((await api('GET', `/p/${fixo}`)).status, 404);
    // o painel não escolhe o link
    p = await put({ dados: dadosAna({ cliente: 'Mais Um Nome' }), status: 'publicada', slug: 'link-escolhido' });
    assert.equal(p.slug, fixo);
    assert.equal((await api('GET', `/p/${fixo}`)).status, 200);
    assert.equal((await api('GET', '/p/link-escolhido')).status, 404);
    await apagar(nova.id);
  });

  await teste('sem acento, sem símbolo, tamanho limitado e sempre único', async () => {
    const casos = [['Érica & Luís Antônio', `^erica-e-luis-antonio-${SUFIXO}$`], ['  Çã!!  ', `^ca-${SUFIXO}$`],
      ['@#$%', `^proposta-${SUFIXO}$`], ['A'.repeat(100), `^a{40}-${SUFIXO}$`], ['Ana & João', `^ana-e-joao-${SUFIXO}$`]];
    const vistos = new Set([ana.slug]);
    for (const [cliente, padrao] of casos) {
      const p = await criar(dadosAna({ cliente }), 'rascunho');
      assert.match(p.slug, new RegExp(padrao), cliente);
      assert.match(p.slug, /^[a-z0-9-]{3,80}$/);
      assert.ok(!vistos.has(p.slug), 'link repetido');
      vistos.add(p.slug);
      await apagar(p.id);
    }
  });

  // ---------------------------------------------------------------- público
  grupo('Página pública e prévia');

  await teste('público: rascunho e link inexistente → 404', async () => {
    for (const slug of [rascunho.slug, 'nao-existe-zzzz']) {
      const r = await api('GET', `/p/${slug}`);
      assert.equal(r.status, 404);
      assert.deepEqual(r.json, { erro: 'Proposta não encontrada.' });
    }
    const comToken = await admin('GET', `/p/${rascunho.slug}`);
    assert.equal(comToken.status, 404, 'a rota pública é sempre a visão do cliente');
    assert.equal((await ver(rascunho.id)).views, 0);
  });

  await teste('público: devolve só { slug, dados } e conta cada abertura', async () => {
    const r1 = await api('GET', `/p/${ana.slug}`);
    assert.equal(r1.status, 200);
    mesmasChaves(r1.json, ['slug', 'dados']);
    mesmasChaves(r1.json.dados, CHAVES_DADOS);
    assert.equal(r1.json.slug, ana.slug);
    assert.deepEqual(r1.json.dados, ana.dados);
    assert.match(r1.headers.get('cache-control') || '', /no-store/);
    let p = await ver(ana.id);
    assert.equal(p.views, 1);
    assert.match(p.primeira_vista, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(p.ultima_vista, p.primeira_vista);
    const primeira = p.primeira_vista;
    await dormir(30);
    assert.equal((await api('GET', `/p/${ana.slug}`)).status, 200);
    assert.equal((await api('GET', `/p/${ana.slug}/`)).status, 200);   // com barra no fim também
    p = await ver(ana.id);
    assert.equal(p.views, 3);
    assert.equal(p.primeira_vista, primeira);
    assert.ok(p.ultima_vista > primeira, 'ultima_vista anda');
    assert.equal(p.atualizado_em, ana.atualizado_em, 'abrir não conta como edição');
    ana = p;
  });

  await teste('prévia do painel: não conta abertura e mostra rascunho', async () => {
    for (let i = 0; i < 2; i++) {
      const r = await admin('GET', `/admin/p/${ana.slug}`);
      assert.equal(r.status, 200);
      mesmasChaves(r.json, CHAVES_PAINEL);
      assert.deepEqual(r.json, ana);
    }
    assert.equal((await ver(ana.id)).views, 3);
    const r = await admin('GET', `/admin/p/${rascunho.slug}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'rascunho');
    assert.equal(r.json.views, 0);
    assert.equal((await api('GET', `/admin/p/${ana.slug}`)).status, 401);
    assert.equal((await admin('GET', '/admin/p/nao-existe-zzzz')).status, 404);
  });

  // ---------------------------------------------------------------- visitante (demo desligada)
  // Esta instância roda como a cópia de um músico de verdade (DEMO:0) e com a SESSAO_CHAVE do .dev.vars.
  // A palavra "visitante" é pública: aqui ela não pode abrir nada. O modo visitante por HTTP, com a demo
  // ligada, é testado na parte 3.
  grupo('Modo visitante com a demo desligada (cópia de um músico de verdade)');
  const loginComo = (s, ip) => api('POST', '/login', { corpo: { senha: s }, headers: { 'cf-connecting-ip': ip } });

  await teste('sem DEMO = "1": "visitante" → 503 "O modo visitante está desligado.", mesmo com a SESSAO_CHAVE gravada, e não conta tentativa', async () => {
    const ip = '203.0.113.43';
    for (const s of ['visitante', ' Visitante ', 'VISITANTE', '\tvisitante\n', 'ViSiTaNtE']) {
      for (let i = 0; i < 3; i++) {
        const r = await loginComo(s, ip);
        assert.equal(r.status, 503, JSON.stringify(s));
        assert.deepEqual(r.json, { erro: 'O modo visitante está desligado.' });
      }
    }
    // os 15 "visitante" não contaram: ainda cabem 8 erros e só a 9ª leva 429
    for (let i = 1; i <= 8; i++) assert.equal((await loginComo(`errada-${i}`, ip)).status, 401, `tentativa ${i}`);
    assert.equal((await loginComo('errada-9', ip)).status, 429);
    // parecido não é "visitante": vira tentativa de senha comum
    for (const s of ['visitantes', 'visit ante', 'vísitante', 'visitante.', 'visitante visitante']) {
      const r = await loginComo(s, '203.0.113.39');
      assert.equal(r.status, 401, JSON.stringify(s));
      assert.deepEqual(r.json, { erro: 'Senha incorreta.' });
    }
    // corpo fora de JSON continua 415, mesmo com "visitante"
    const r = await api('POST', '/login', { bruto: '{"senha":"visitante"}', headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
  });

  await teste('sem DEMO = "1": token de visitante bem assinado com a SESSAO_CHAVE → 401 em toda rota (não lê as propostas nem grava)', async () => {
    const v = forjarVisitante(chave, { exp: agoraSeg() + 3600, papel: 'visitante' });
    const antes = await listar();
    for (const [m, c] of [...ROTAS_ADMIN, ['GET', `/admin/propostas/${ana.id}`], ['GET', `/admin/p/${ana.slug}`], ['GET', `/admin/p/${rascunho.slug}`]]) {
      const r = await api(m, c, { token: v, corpo: m === 'GET' ? undefined : { dados: dadosAna() } });
      assert.equal(r.status, 401, `${m} ${c}`);
      assert.deepEqual(r.json, ERRO_SESSAO, `${m} ${c}`);
    }
    assert.deepEqual(await listar(), antes, 'nada mudou');
    assert.deepEqual(await ver(ana.id), ana, 'nenhuma abertura contada');
  });

  // ---------------------------------------------------------------- etapa
  grupo('Fechamento (etapa)');
  let bia, caio;

  await teste('fechada: grava valor, data e o fechamento limpo', async () => {
    const r = await etapa(ana.id, { etapa: 'fechada', motivo: 'ignorado', valor_fechado: 1, fechado_em: '2020-01-01',
      fechamento: { opcao: 'media', pacote: 'cerimonia_recepcao', valor: 4321.094, data: '2026-09-20', obs: 'segredo-obs', hack: 1, motivo: 'x' } });
    assert.equal(r.status, 200);
    mesmasChaves(r.json, CHAVES_PAINEL);
    assert.equal(r.json.etapa, 'fechada');
    assert.equal(r.json.valor_fechado, 4321.09);
    assert.equal(r.json.fechado_em, '2026-09-20');
    assert.deepEqual(r.json.fechamento, { opcao: 'media', pacote: 'cerimonia_recepcao', valor: 4321.09, data: '2026-09-20', obs: 'segredo-obs' });
    // o resto da proposta fica como estava
    for (const k of ['id', 'slug', 'status', 'dados', 'criado_em', 'views', 'primeira_vista', 'ultima_vista', 'publicada_alguma_vez']) {
      assert.deepEqual(r.json[k], ana[k], k);
    }
    ana = r.json;
    assert.deepEqual(await ver(ana.id), ana);
  });

  await teste('público continua sem etapa, fechamento nem valor fechado', async () => {
    const r = await api('GET', `/p/${ana.slug}`);
    assert.equal(r.status, 200);
    mesmasChaves(r.json, ['slug', 'dados']);
    mesmasChaves(r.json.dados, CHAVES_DADOS);
    assert.deepEqual(r.json.dados, ana.dados);
    for (const proibido of ['etapa', 'fechamento', 'valor_fechado', 'fechado_em', '4321.09', 'segredo-obs', '_publicada', 'views', 'vista']) {
      assert.ok(!r.texto.includes(proibido), `vazou "${proibido}"`);
    }
    ana = await ver(ana.id);
    assert.equal(ana.views, 4);
  });

  await teste('fechada sem data (ou com data inválida) usa hoje no fuso de Brasília', async () => {
    bia = await criar(dadosAna({ cliente: 'Bia & Caio', data: '2027-08-08' }));
    for (const data of [undefined, '31/12/2026', '2026-02-30', '']) {
      const r = await etapa(bia.id, { etapa: 'fechada', fechamento: { opcao: 'simples', pacote: 'cerimonia', valor: 2500, data } });
      assert.equal(r.status, 200);
      assert.equal(r.json.fechado_em, hojeBr(), `data ${data}`);
      assert.deepEqual(r.json.fechamento, { opcao: 'simples', pacote: 'cerimonia', valor: 2500, data: hojeBr(), obs: '' });
    }
    bia = await ver(bia.id);
  });

  await teste('fechada sem valor válido → 400 "Coloque o valor fechado." e nada muda', async () => {
    caio = await criar(dadosAna({ cliente: 'Caio & Duda', data: '2027-10-10' }));
    for (const fechamento of [undefined, null, {}, { valor: 0 }, { valor: -100 }, { valor: '4000' }, { valor: null }, { valor: 0.004 }, 'texto', [4000], 4000]) {
      for (const alvo of [bia, caio]) {   // uma já fechada, outra em aberto
        const r = await etapa(alvo.id, { etapa: 'fechada', fechamento });
        assert.equal(r.status, 400, JSON.stringify(fechamento));
        assert.deepEqual(r.json, { erro: 'Coloque o valor fechado.' });
      }
    }
    assert.deepEqual(await ver(bia.id), bia);
    assert.deepEqual(await ver(caio.id), caio);
    assert.equal(caio.etapa, 'aberta');
  });

  await teste('fechada com valor que estoura (1e307) ou passa do teto → 400; o teto (R$ 99.999.999,99) entra', async () => {
    for (const valor of [1e307, Number.MAX_VALUE, 1e20, 1e10, 100000000, 99999999.995]) {
      const r = await etapa(caio.id, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor } });
      assert.equal(r.status, 400, `valor ${valor}`);
      assert.deepEqual(r.json, { erro: 'Coloque o valor fechado.' });
    }
    assert.deepEqual(await ver(caio.id), caio);
    const resumoAntes = (await admin('GET', '/admin/resumo')).json;
    const ok = await etapa(caio.id, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 99999999.99 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.valor_fechado, 99999999.99);
    assert.equal(ok.json.fechamento.valor, 99999999.99);
    const resumo = (await admin('GET', '/admin/resumo')).json;
    assert.equal(resumo.total_fechado, CENT(resumoAntes.total_fechado + 99999999.99));
    assert.ok(Number.isFinite(resumo.total_fechado));
    caio = (await etapa(caio.id, { etapa: 'aberta' })).json;
    assert.equal((await admin('GET', '/admin/resumo')).json.total_fechado, resumoAntes.total_fechado);
  });

  await teste('fechada: opção e pacote fora da lista viram "outro"; obs até 500', async () => {
    const fechar = async fechamento => (await etapa(caio.id, { etapa: 'fechada', fechamento })).json.fechamento;
    for (const opcao of ['simples', 'media', 'completa', 'outro']) {
      for (const pacote of ['cerimonia', 'cerimonia_recepcao', 'outro']) {
        const f = await fechar({ opcao, pacote, valor: 1000 });
        assert.equal(f.opcao, opcao);
        assert.equal(f.pacote, pacote);
      }
    }
    for (const [opcao, pacote] of [['quarteto', 'festa'], [undefined, undefined], [1, null], ['Simples', 'Cerimonia']]) {
      const f = await fechar({ opcao, pacote, valor: 1000 });
      assert.equal(f.opcao, 'outro');
      assert.equal(f.pacote, 'outro');
    }
    const f = await fechar({ opcao: 'outro', pacote: 'outro', valor: 1234.5, obs: 'o'.repeat(600) });
    assert.equal(f.obs, 'o'.repeat(500));
    assert.equal((await fechar({ valor: 10, obs: 99 })).obs, '');
    caio = await ver(caio.id);
    assert.equal(caio.valor_fechado, 10);
  });

  await teste('fechada com pagamentos: sinal e restante com vencimento e data em que recebeu; marcar recebido não muda o resto', async () => {
    caio = (await etapa(caio.id, { etapa: 'aberta' })).json;
    const base = { opcao: 'media', pacote: 'cerimonia_recepcao', valor: 4000, data: '2026-10-06', adicionais: [{ nome: 'Drone', valor: 500 }] };
    const r = await etapa(caio.id, { etapa: 'fechada', fechamento: { ...base, pagamentos: [
      { tipo: 'sinal', valor: 450, vence_em: '2026-10-06', pago_em: '2026-10-06', hack: 1 },
      { tipo: 'restante', valor: 4050, vence_em: '2027-05-10', pago_em: '' },
      { tipo: 'outra coisa', valor: 10, vence_em: '10/05/2027', pago_em: 'ontem' },
      { tipo: 'sinal', valor: 0 }, { tipo: 'sinal', valor: -5 }, { tipo: 'sinal', valor: '300' }, null, 'texto', {},
    ] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.fechamento.pagamentos, [
      { tipo: 'sinal', valor: 450, vence_em: '2026-10-06', pago_em: '2026-10-06' },
      { tipo: 'restante', valor: 4050, vence_em: '2027-05-10', pago_em: '' },
      { tipo: 'parcela', valor: 10, vence_em: '', pago_em: '' },
    ]);
    assert.equal(r.json.valor_fechado, 4500);
    assert.equal(r.json.fechado_em, '2026-10-06');
    const f = structuredClone(r.json.fechamento);
    f.pagamentos[1].pago_em = '2027-05-02';
    const r2 = await etapa(caio.id, { etapa: 'fechada', fechamento: f });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.fechamento.pagamentos[1].pago_em, '2027-05-02');
    for (const k of ['opcao', 'pacote', 'valor', 'data', 'obs', 'adicionais']) assert.deepEqual(r2.json.fechamento[k], r.json.fechamento[k], k);
    assert.equal(r2.json.valor_fechado, 4500);
    const muitos = await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 100, pagamentos: Array.from({ length: 30 }, () => ({ tipo: 'parcela', valor: 1 })) } });
    assert.equal(muitos.json.fechamento.pagamentos.length, 24);
    for (const pagamentos of [undefined, [], 'sinal', { tipo: 'sinal', valor: 1 }]) {
      const s = await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 10, pagamentos } });
      assert.equal(s.json.fechamento.pagamentos, undefined, JSON.stringify(pagamentos));
    }
    caio = (await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 10 } })).json;
  });

  await teste('fechada com adicionais: nome + valor opcional, no máximo 10, e entram no total fechado', async () => {
    caio = (await etapa(caio.id, { etapa: 'aberta' })).json;
    const antes = (await admin('GET', '/admin/resumo')).json;
    const r = await etapa(caio.id, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 2000, data: '2026-10-06',
      adicionais: [{ nome: '  Trompetes  ', valor: 800, hack: 1 }, { nome: 'Sax' }, null, 'texto', {}, { nome: '', valor: null },
        { nome: 'N'.repeat(130), valor: 150.555 }, { nome: 'Negativo', valor: -5 }, { nome: 'Texto', valor: '300' }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.fechamento, { opcao: 'media', pacote: 'cerimonia', valor: 2000, data: '2026-10-06', obs: '',
      adicionais: [{ nome: 'Trompetes', valor: 800 }, { nome: 'Sax', valor: null }, { nome: 'N'.repeat(120), valor: 150.56 },
        { nome: 'Negativo', valor: null }, { nome: 'Texto', valor: null }] });
    assert.equal(r.json.valor_fechado, 2950.56);   // opção + adicionais
    assert.equal((await admin('GET', '/admin/resumo')).json.total_fechado, CENT(antes.total_fechado + 2950.56));
    // no máximo 10
    const muitos = await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 100, adicionais: Array.from({ length: 14 }, (_, i) => ({ nome: 'A' + i, valor: 1 })) } });
    assert.equal(muitos.json.fechamento.adicionais.length, 10);
    assert.equal(muitos.json.valor_fechado, 110);
    // adicional com valor e sem nome → 400 e nada muda
    const antesErro = await ver(caio.id);
    for (const adicionais of [[{ valor: 300 }], [{ nome: '   ', valor: 300 }], [{ nome: 'Ok', valor: 1 }, { nome: '', valor: 2 }]]) {
      const x = await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 1000, adicionais } });
      assert.equal(x.status, 400, JSON.stringify(adicionais));
      assert.deepEqual(x.json, { erro: 'Coloque o nome do adicional.' });
    }
    assert.deepEqual(await ver(caio.id), antesErro);
    // sem adicionais (ou lista vazia / que não é lista): o fechamento fica como antes, sem a chave
    for (const adicionais of [undefined, [], 'trompetes', { nome: 'x' }]) {
      const s = await etapa(caio.id, { etapa: 'fechada', fechamento: { valor: 10, adicionais } });
      assert.equal(s.json.fechamento.adicionais, undefined, JSON.stringify(adicionais));
      assert.equal(s.json.valor_fechado, 10);
    }
    caio = await ver(caio.id);
  });

  await teste('perdida: guarda o motivo, limpa o valor e usa a data de hoje', async () => {
    assert.equal(bia.etapa, 'fechada');
    let r = await etapa(bia.id, { etapa: 'perdida', motivo: 'motivo-secreto: fechou com outro fornecedor', fechamento: { valor: 9, opcao: 'media' }, valor_fechado: 9 });
    assert.equal(r.status, 200);
    mesmasChaves(r.json, CHAVES_PAINEL);
    assert.equal(r.json.etapa, 'perdida');
    assert.equal(r.json.valor_fechado, null);
    assert.equal(r.json.fechado_em, hojeBr());
    assert.deepEqual(r.json.fechamento, { motivo: 'motivo-secreto: fechou com outro fornecedor' });
    const pub = await api('GET', `/p/${bia.slug}`);
    assert.equal(pub.status, 200, 'perdida continua abrindo para o cliente');
    assert.ok(!pub.texto.includes('motivo'), 'o motivo não vaza');
    for (const [motivo, sai] of [[undefined, ''], ['m'.repeat(400), 'm'.repeat(300)], [123, ''], [null, '']]) {
      r = await etapa(bia.id, { etapa: 'perdida', motivo });
      assert.deepEqual(r.json.fechamento, { motivo: sai });
      assert.equal(r.json.valor_fechado, null);
    }
    bia = r.json;
  });

  await teste('aberta: reabre e limpa fechamento, valor e data', async () => {
    for (const alvo of [bia, caio]) {   // uma perdida, outra fechada
      const r = await etapa(alvo.id, { etapa: 'aberta', fechamento: { valor: 5 }, motivo: 'x', valor_fechado: 5 });
      assert.equal(r.status, 200);
      assert.equal(r.json.etapa, 'aberta');
      assert.equal(r.json.fechamento, null);
      assert.equal(r.json.valor_fechado, null);
      assert.equal(r.json.fechado_em, null);
      assert.deepEqual(r.json.dados, alvo.dados);
    }
    bia = await ver(bia.id);
    caio = await ver(caio.id);
  });

  await teste('etapa desconhecida → 400; proposta inexistente → 404; sem sessão → 401; JSON ruim → 400', async () => {
    for (const e of [undefined, '', 'ganha', 'FECHADA', 1, null, ['aberta']]) {
      const r = await etapa(caio.id, { etapa: e, fechamento: { valor: 1000 } });
      assert.equal(r.status, 400, JSON.stringify(e));
      assert.deepEqual(r.json, { erro: 'Etapa inválida.' });
    }
    assert.equal((await etapa(caio.id, undefined)).status, 400, 'sem corpo');
    assert.deepEqual(await ver(caio.id), caio);
    const fora = await etapa(ID_FALSO, { etapa: 'aberta' });
    assert.equal(fora.status, 404);
    assert.deepEqual(fora.json, { erro: 'Proposta não encontrada.' });
    assert.equal((await api('PUT', `/admin/propostas/${caio.id}/etapa`, { corpo: { etapa: 'perdida' } })).status, 401);
    assert.equal((await admin('PUT', `/admin/propostas/${caio.id}/etapa`, undefined, { bruto: '{"etapa":' })).status, 400);
    for (const m of ['GET', 'POST', 'DELETE']) assert.equal((await admin(m, `/admin/propostas/${caio.id}/etapa`)).status, 404, m);
    assert.deepEqual(await ver(caio.id), caio);
  });

  await teste('rascunho também pode ser marcado como fechado (acerto fora do sistema)', async () => {
    const r = await etapa(rascunho.id, { etapa: 'fechada', fechamento: { opcao: 'outro', pacote: 'outro', valor: 800 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'rascunho');
    assert.equal(r.json.etapa, 'fechada');
    rascunho = (await etapa(rascunho.id, { etapa: 'aberta' })).json;
  });

  // ---------------------------------------------------------------- PUT comum
  grupo('Editar (PUT) e duplicar');

  await teste('PUT da proposta nunca mexe em etapa nem no fechamento', async () => {
    assert.equal(ana.etapa, 'fechada');
    const intruso = { etapa: 'aberta', fechamento: null, valor_fechado: 1, fechado_em: '2020-01-01', views: 0 };
    let r = await admin('PUT', `/admin/propostas/${ana.id}`, { dados: { ...dadosAna({ local: 'Novo local' }), ...intruso }, status: 'publicada', ...intruso });
    assert.equal(r.status, 200);
    mesmasChaves(r.json, CHAVES_PAINEL);
    assert.equal(r.json.dados.local, 'Novo local');
    mesmasChaves(r.json.dados, CHAVES_DADOS);
    for (const k of ['etapa', 'fechamento', 'valor_fechado', 'fechado_em', 'views', 'slug', 'criado_em']) assert.deepEqual(r.json[k], ana[k], k);
    assert.ok(r.json.atualizado_em >= ana.atualizado_em);
    ana = r.json;
    // em aberto: PUT não fecha
    const fechaPorFora = { etapa: 'fechada', valor_fechado: 999, fechado_em: '2026-10-01', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 999 } };
    r = await admin('PUT', `/admin/propostas/${caio.id}`, { dados: { ...caio.dados, ...fechaPorFora }, status: 'publicada', ...fechaPorFora });
    assert.equal(r.status, 200);
    assert.equal(r.json.etapa, 'aberta');
    assert.equal(r.json.valor_fechado, null);
    assert.equal(r.json.fechamento, null);
    assert.equal(r.json.fechado_em, null);
    // perdida: editar não reabre
    await etapa(bia.id, { etapa: 'perdida', motivo: 'sem resposta' });
    r = await admin('PUT', `/admin/propostas/${bia.id}`, { dados: bia.dados, status: 'publicada', etapa: 'aberta' });
    assert.equal(r.json.etapa, 'perdida');
    assert.deepEqual(r.json.fechamento, { motivo: 'sem resposta' });
    bia = r.json;
    assert.equal((await admin('GET', '/admin/resumo')).json.total_fechado, 4321.09, 'só a fechada de verdade soma');
  });

  await teste('PUT: sem status mantém o status; sem dados mantém os dados', async () => {
    let r = await admin('PUT', `/admin/propostas/${caio.id}`, { dados: { ...caio.dados, local: 'Só dados' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'publicada');
    assert.equal(r.json.dados.local, 'Só dados');
    r = await admin('PUT', `/admin/propostas/${caio.id}`, { status: 'rascunho' });
    assert.equal(r.json.status, 'rascunho');
    assert.equal(r.json.dados.local, 'Só dados');
    r = await admin('PUT', `/admin/propostas/${caio.id}`, { dados: { ...caio.dados, local: 'Ainda rascunho' } });
    assert.equal(r.json.status, 'rascunho');
    r = await admin('PUT', `/admin/propostas/${caio.id}`, { dados: caio.dados, status: 'publicada' });
    assert.equal(r.json.status, 'publicada');
    assert.deepEqual(r.json.dados, caio.dados);
    assert.equal(r.json.slug, caio.slug);
    caio = r.json;
  });

  await teste('PUT: publicar inválido → 400 e nada muda; inexistente → 404; dados que não são objeto → 400', async () => {
    const semValor = dadosAna({ cliente: 'Caio & Duda' });
    for (const k of OP) semValor.opcoes[k].cerimonia = null;
    esconder(semValor, 'ver_recepcao');
    const casos = [
      [{ dados: dadosAna({ cliente: '' }), status: 'publicada' }, 'Coloque o nome do cliente.'],
      [{ dados: dadosAna({ cliente: '  ' }) }, 'Coloque o nome do cliente.'],          // sem status: continua publicada, então valida
      [{ dados: semValor, status: 'publicada' }, 'Marque pelo menos uma opção com valor.'],
      [{ dados: semValor }, 'Marque pelo menos uma opção com valor.'],
    ];
    for (const [corpo, erro] of casos) {
      const r = await admin('PUT', `/admin/propostas/${caio.id}`, corpo);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { erro });
    }
    // rascunho sem nome não publica
    const r = await admin('PUT', `/admin/propostas/${rascunho.id}`, { status: 'publicada' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { erro: 'Coloque o nome do cliente.' });
    assert.deepEqual(await ver(rascunho.id), rascunho);
    for (const dados of ['texto', [1], 7]) {
      assert.equal((await admin('PUT', `/admin/propostas/${caio.id}`, { dados, status: 'publicada' })).status, 400);
    }
    assert.deepEqual(await ver(caio.id), caio);
    const fora = await admin('PUT', `/admin/propostas/${ID_FALSO}`, { dados: dadosAna(), status: 'publicada' });
    assert.equal(fora.status, 404);
    assert.deepEqual(fora.json, { erro: 'Proposta não encontrada.' });
    assert.equal((await admin('GET', `/admin/propostas/${ID_FALSO}`)).status, 404);
  });

  await teste('duplicar: proposta nova, rascunho, em aberto, sem fechamento e sem aberturas', async () => {
    // original com validade já vencida: a cópia não pode herdar
    ana = (await admin('PUT', `/admin/propostas/${ana.id}`, { dados: { ...ana.dados, validade: '2025-01-31' } })).json;
    assert.equal(ana.dados.validade, '2025-01-31');
    assert.equal(ana.etapa, 'fechada');
    assert.ok(ana.views > 0);
    const antes = (await listar()).length;
    const r = await admin('POST', `/admin/propostas/${ana.id}/duplicar`);
    assert.equal(r.status, 201);
    const c = r.json;
    mesmasChaves(c, CHAVES_PAINEL);
    assert.notEqual(c.id, ana.id);
    assert.match(c.slug, new RegExp(`^ana-e-joao-copia-${SUFIXO}$`));
    assert.equal(c.status, 'rascunho');
    assert.equal(c.etapa, 'aberta');
    assert.equal(c.fechamento, null);
    assert.equal(c.valor_fechado, null);
    assert.equal(c.fechado_em, null);
    assert.equal(c.views, 0);
    assert.equal(c.primeira_vista, null);
    assert.equal(c.ultima_vista, null);
    assert.equal(c.publicada_alguma_vez, false);
    assert.deepEqual(c.dados, { ...ana.dados, cliente: 'Ana & João (cópia)', validade: maisDias(hojeBr(), 30) });
    assert.equal((await api('GET', `/p/${c.slug}`)).status, 404, 'cópia nasce invisível');
    assert.deepEqual(await ver(ana.id), ana, 'o original não muda');
    assert.equal((await listar()).length, antes + 1);
    // cópia de proposta sem nome continua sem nome
    const semNome = (await admin('POST', `/admin/propostas/${rascunho.id}/duplicar`)).json;
    assert.equal(semNome.dados.cliente, '');
    assert.match(semNome.slug, /^proposta-/);
    // nome no limite não perde o "(cópia)"
    const longo = await criar(dadosAna({ cliente: 'B'.repeat(120) }), 'rascunho');
    const copiaLonga = (await admin('POST', `/admin/propostas/${longo.id}/duplicar`)).json;
    assert.equal(copiaLonga.dados.cliente, `${'B'.repeat(112)} (cópia)`);
    for (const p of [c, semNome, longo, copiaLonga]) await apagar(p.id);
    assert.equal((await admin('POST', `/admin/propostas/${ID_FALSO}/duplicar`)).status, 404);
    assert.equal((await api('POST', `/admin/propostas/${ana.id}/duplicar`)).status, 401);
    assert.equal((await listar()).length, antes);
  });

  // ---------------------------------------------------------------- corpo
  grupo('Contatos (quem pediu preço)');
  const CHAVES_CONTATO = ['id', 'nome', 'whatsapp', 'origem', 'data_evento', 'obs', 'lembrete_em', 'lembrete_txt', 'proposta_id', 'criado_em', 'atualizado_em'];

  await teste('contatos: criar, listar, editar e excluir; WhatsApp só com DDD; origem, datas e textos limpos', async () => {
    const r = await admin('POST', '/admin/contatos', { nome: '  Ana & João  ', whatsapp: '+55 (11) 99999-0000', origem: 'instagram', data_evento: '2027-05-15',
      obs: 'Pediu preço pelo direct', lembrete_em: '2026-10-20', lembrete_txt: 'Mandar a proposta', hack: '<script>', proposta_id: 'x' });
    assert.equal(r.status, 201);
    mesmasChaves(r.json, CHAVES_CONTATO);
    const c = r.json;
    assert.deepEqual([c.nome, c.whatsapp, c.origem, c.data_evento, c.obs, c.lembrete_em, c.lembrete_txt, c.proposta_id],
      ['Ana & João', '11999990000', 'instagram', '2027-05-15', 'Pediu preço pelo direct', '2026-10-20', 'Mandar a proposta', null]);
    assert.ok(!r.texto.includes('<script>'));
    assert.match(c.criado_em, ISO);
    // normalização do número
    for (const [entra, sai] of [['11 9999-0000', '1199990000'], ['(11) 99999-0000', '11999990000'], ['5511999990000', '11999990000'], ['', ''], [11999990000, '']]) {
      const x = await admin('PUT', `/admin/contatos/${c.id}`, { nome: 'Ana', whatsapp: entra });
      assert.equal(x.status, 200, String(entra));
      assert.equal(x.json.whatsapp, sai, String(entra));
    }
    for (const w of ['123', '1199999000012345', 'abc 1']) {
      const x = await admin('PUT', `/admin/contatos/${c.id}`, { nome: 'Ana', whatsapp: w });
      assert.equal(x.status, 400, w);
      assert.deepEqual(x.json, { erro: 'WhatsApp inválido: coloque com DDD, só os números.' });
    }
    // nome obrigatório; origem desconhecida e datas ruins viram vazio; textos cortados
    for (const nome of ['', '   ', undefined, 5]) {
      const x = await admin('POST', '/admin/contatos', { nome });
      assert.equal(x.status, 400);
      assert.deepEqual(x.json, { erro: 'Coloque o nome.' });
    }
    const y = await admin('PUT', `/admin/contatos/${c.id}`, { nome: 'N'.repeat(130), origem: 'tiktok', data_evento: '15/05/2027', lembrete_em: '2026-02-30', obs: 'o'.repeat(600), lembrete_txt: 'l'.repeat(200) });
    assert.deepEqual([y.json.nome, y.json.origem, y.json.data_evento, y.json.lembrete_em, y.json.obs.length, y.json.lembrete_txt.length], ['N'.repeat(120), '', null, null, 500, 140]);
    for (const o of ['instagram', 'portal', 'indicacao', 'google', 'whatsapp', 'outro']) {
      assert.equal((await admin('PUT', `/admin/contatos/${c.id}`, { nome: 'Ana', origem: o })).json.origem, o);
    }
    // na base genérica a origem padrão é "portal"
    assert.equal((await admin('PUT', `/admin/contatos/${c.id}`, { nome: 'Ana', origem: 'casamentos' })).json.origem, '');
    // corpo que não é objeto, contato inexistente
    assert.equal((await admin('PUT', `/admin/contatos/${c.id}`, ['x'])).status, 400);
    assert.equal((await admin('PUT', `/admin/contatos/${ID_FALSO}`, { nome: 'X' })).status, 404);
    // lista: mais recente primeiro
    await dormir(5);
    const d2 = (await admin('POST', '/admin/contatos', { nome: 'Bia' })).json;
    const lista = (await admin('GET', '/admin/contatos')).json;
    assert.deepEqual(lista.slice(0, 2).map(x => x.id), [d2.id, c.id]);
    lista.forEach(x => mesmasChaves(x, CHAVES_CONTATO));
    // excluir
    assert.equal((await admin('DELETE', `/admin/contatos/${d2.id}`)).status, 200);
    assert.ok(!(await admin('GET', '/admin/contatos')).json.some(x => x.id === d2.id));
    await admin('DELETE', `/admin/contatos/${c.id}`);
    assert.deepEqual((await admin('GET', '/admin/contatos')).json, [], 'com a demo desligada não há contato de exemplo');
  });

  await teste('contatos: vínculo com a proposta (só proposta que existe; excluir a proposta solta o vínculo)', async () => {
    const p = await criar(dadosAna({ cliente: 'Contato vinculado' }));
    const c = (await admin('POST', '/admin/contatos', { nome: 'Contato vinculado', whatsapp: '11988887777', proposta_id: p.id })).json;
    assert.equal(c.proposta_id, p.id);
    assert.equal((await admin('PUT', `/admin/contatos/${c.id}`, { ...c, proposta_id: ID_FALSO })).json.proposta_id, null);
    await admin('PUT', `/admin/contatos/${c.id}`, { ...c, proposta_id: p.id });
    // a página pública da proposta não traz nada do contato
    const pub = await api('GET', `/p/${p.slug}`);
    assert.ok(!pub.texto.includes('11988887777'));
    await apagar(p.id);
    const depois = (await admin('GET', '/admin/contatos')).json.find(x => x.id === c.id);
    assert.equal(depois.proposta_id, null);
    assert.equal(depois.whatsapp, '11988887777');
    await admin('DELETE', `/admin/contatos/${c.id}`);
  });

  await teste('contatos: sem sessão → 401 em todas as rotas', async () => {
    for (const [m, c] of [['GET', '/admin/contatos'], ['POST', '/admin/contatos'], ['PUT', `/admin/contatos/${ID_FALSO}`], ['DELETE', `/admin/contatos/${ID_FALSO}`]]) {
      const r = await api(m, c, m === 'GET' ? {} : { corpo: { nome: 'X' } });
      assert.equal(r.status, 401, m + ' ' + c);
    }
  });

  grupo('Corpo da requisição');

  await teste('corpo grande demais → 413 (limite de 200 KB, contado em bytes)', async () => {
    const LIMITE = 200 * 1024;
    const antes = (await listar()).length;
    const corpoDe = n => {
      const ini = '{"dados":{"cliente":"Grande"},"lixo":"', fim = '"}';
      return ini + 'x'.repeat(n - ini.length - fim.length) + fim;
    };
    const noLimite = await admin('POST', '/admin/propostas', undefined, { bruto: corpoDe(LIMITE) });
    assert.equal(noLimite.status, 201, 'exatamente 200 KB passa');
    await apagar(noLimite.json.id);
    await esperar413(() => admin('POST', '/admin/propostas', undefined, { bruto: corpoDe(LIMITE + 1) }), '200 KB + 1');
    const acentos = `{"dados":{"cliente":"${'ã'.repeat(110000)}"}}`;   // 110 mil caracteres, 220 KB
    assert.ok(acentos.length < LIMITE && Buffer.byteLength(acentos) > LIMITE);
    await esperar413(() => admin('POST', '/admin/propostas', undefined, { bruto: acentos }), 'acentos');
    const grande = corpoDe(LIMITE + 5000);
    for (const [m, c] of [['PUT', `/admin/propostas/${caio.id}`], ['PUT', `/admin/propostas/${caio.id}/etapa`], ['PUT', '/admin/modelo'], ['POST', '/login']]) {
      await esperar413(() => admin(m, c, undefined, { bruto: grande }), `${m} ${c}`);
    }
    assert.equal((await semProxy(() => admin('GET', '/admin/propostas'), 'listar')).json.length, antes);
    assert.deepEqual(await ver(caio.id), caio);
    assert.deepEqual((await admin('GET', '/admin/modelo')).json, MODELO_PADRAO);
  });

  await teste('corpo em stream (sem content-length) é cortado no limite, sem ser carregado inteiro; 2 MB no login → 413', async () => {
    const pedaco = new Uint8Array(64 * 1024).fill(120);   // 64 KB de "x"
    const fluxo = total => {
      let enviados = 0;
      return new ReadableStream({ pull(ctrl) { if (enviados >= total) return ctrl.close(); enviados++; ctrl.enqueue(pedaco); } });
    };
    // (a prova de que o corpo não é lido inteiro está na parte 2, que conta os pedaços lidos)
    for (const [m, c, token] of [['POST', '/login', null], ['POST', '/admin/propostas', undefined], ['PUT', '/admin/modelo', undefined]]) {
      await esperar413(() => admin(m, c, undefined, { bruto: fluxo(8), duplex: 'half', ...(token === null ? { token: null } : {}) }), `${m} ${c}`);   // 512 KB
    }
    // exatamente 192 KB em stream passa (chega ao JSON.parse e falha lá, não no tamanho)
    const noLimite = await semProxy(() => admin('POST', '/admin/propostas', undefined, { bruto: fluxo(3), duplex: 'half' }), '192 KB');
    assert.equal(noLimite.status, 400, noLimite.texto.slice(0, 200));
    assert.deepEqual(noLimite.json, { erro: 'JSON inválido.' });
    // 2 MB de uma vez no login (IP limpo): 413 pelo content-length, antes de ler
    const ipGrande = { 'cf-connecting-ip': '203.0.113.11' };
    await esperar413(() => api('POST', '/login', { bruto: `{"senha":"${'x'.repeat(2 * 1024 * 1024)}"}`, headers: ipGrande }), 'login 2 MB');
    const depois = await semProxy(() => api('POST', '/login', { corpo: { senha: 'errada' }, headers: ipGrande }), 'login depois dos 2 MB');
    assert.equal(depois.status, 401, 'não contou');
    assert.deepEqual((await semProxy(() => admin('GET', `/admin/propostas/${caio.id}`), 'ver')).json, caio);
    assert.deepEqual((await admin('GET', '/admin/modelo')).json, MODELO_PADRAO);
  });

  await teste('JSON inválido → 400 em todas as rotas que recebem corpo', async () => {
    const antes = (await listar()).length;
    for (const [m, c] of [['POST', '/admin/propostas'], ['PUT', `/admin/propostas/${caio.id}`], ['PUT', `/admin/propostas/${caio.id}/etapa`], ['PUT', '/admin/modelo']]) {
      for (const bruto of ['{"dados":', 'não é json', '[1,2]', '"texto"', '123', 'null']) {
        const r = await admin(m, c, undefined, { bruto });
        assert.equal(r.status, 400, `${m} ${c} ${bruto}`);
        assert.deepEqual(r.json, { erro: 'JSON inválido.' });
      }
    }
    assert.equal((await listar()).length, antes);
    assert.deepEqual(await ver(caio.id), caio);
  });

  // ---------------------------------------------------------------- excluir, listar, resumo
  grupo('Excluir, listar e resumo');

  await teste('excluir: some do painel, da prévia e do público', async () => {
    const x = await criar(dadosAna({ cliente: 'Para Excluir' }));
    assert.equal((await api('GET', `/p/${x.slug}`)).status, 200);
    assert.equal((await api('DELETE', `/admin/propostas/${x.id}`)).status, 401);
    assert.equal((await ver(x.id)).id, x.id, 'sem sessão não apaga');
    const r = await apagar(x.id);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal((await admin('GET', `/admin/propostas/${x.id}`)).status, 404);
    assert.equal((await admin('GET', `/admin/p/${x.slug}`)).status, 404);
    assert.equal((await api('GET', `/p/${x.slug}`)).status, 404);
    assert.ok(!(await listar()).some(p => p.id === x.id));
    assert.equal((await apagar(x.id)).status, 200, 'excluir de novo não dá erro');
  });

  await teste('excluir: proposta fechada → 409 até reabrir (a venda não some do total)', async () => {
    const x = await criar(dadosAna({ cliente: 'Fechada Para Excluir', data: '2027-06-06' }));
    assert.equal((await etapa(x.id, { etapa: 'fechada', fechamento: { opcao: 'simples', pacote: 'cerimonia', valor: 2500 } })).status, 200);
    const antes = (await admin('GET', '/admin/resumo')).json;
    const r = await apagar(x.id);
    assert.equal(r.status, 409);
    assert.deepEqual(r.json, { erro: 'Essa proposta está fechada. Reabra antes de excluir.' });
    assert.equal((await ver(x.id)).etapa, 'fechada', 'continua lá');
    assert.deepEqual((await admin('GET', '/admin/resumo')).json, antes, 'o total não mudou');
    // perdida pode ser excluída; reaberta também
    assert.equal((await etapa(x.id, { etapa: 'perdida', motivo: 'teste' })).status, 200);
    const y = await criar(dadosAna({ cliente: 'Reaberta Para Excluir' }));
    await etapa(y.id, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 3200 } });
    assert.equal((await apagar(y.id)).status, 409);
    assert.equal((await etapa(y.id, { etapa: 'aberta' })).status, 200);
    for (const p of [x, y]) {
      const d = await apagar(p.id);
      assert.equal(d.status, 200, p.dados.cliente);
      assert.equal((await admin('GET', `/admin/propostas/${p.id}`)).status, 404);
    }
  });

  await teste('listar: formato do painel, mais recente primeiro', async () => {
    const r = await admin('GET', '/admin/propostas');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) && r.json.length >= 4);
    for (const p of r.json) {
      mesmasChaves(p, CHAVES_PAINEL);
      mesmasChaves(p.dados, CHAVES_DADOS);
    }
    const datas = r.json.map(p => p.atualizado_em);
    assert.deepEqual(datas, [...datas].sort().reverse());
    assert.ok(!r.texto.includes('_publicada'));
  });

  await teste('resumo: banco vazio → tudo zero', async () => {
    for (const p of await listar()) {
      if (p.etapa === 'fechada') assert.equal((await etapa(p.id, { etapa: 'aberta' })).status, 200);   // fechada não se apaga
      assert.equal((await apagar(p.id)).status, 200);
    }
    assert.deepEqual(await listar(), []);
    const r = await admin('GET', '/admin/resumo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { abertas: 0, fechadas: 0, perdidas: 0, total_fechado: 0,
      fechado_mes: { mes: hojeBr().slice(0, 7), propostas: 0, total: 0 }, por_ano_evento: [] });
  });

  await teste('resumo: etapas, total fechado, mês corrente (Brasília) e ano do evento', async () => {
    const mes = hojeBr().slice(0, 7);
    const mesAnterior = maisDias(`${mes}-01`, -3).slice(0, 7);
    const nova = (cliente, data, status = 'publicada') => criar(dadosAna({ cliente, data }), status);
    const fechar = async (p, valor, data) => {
      const r = await etapa(p.id, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor, ...(data ? { data } : {}) } });
      assert.equal(r.status, 200);
    };
    const p1 = await nova('Casal 1', '2027-05-15'); await fechar(p1, 4000);                       // fechou hoje
    const p2 = await nova('Casal 2', '2027-09-10'); await fechar(p2, 3200.5, `${mes}-01`);         // fechou neste mês
    const p3 = await nova('Casal 3', '2028-01-20'); await fechar(p3, 5000, '2025-03-10');          // fechou em outro ano
    const p4 = await nova('Casal 4', '');           await fechar(p4, 1500, `${mesAnterior}-28`);   // mês passado, evento sem data
    const p5 = await nova('Casal 5', '2027-11-11'); await etapa(p5.id, { etapa: 'perdida', motivo: 'data ocupada' });
    await nova('Casal 6', '2027-12-01');                                                           // em aberto, publicada
    await nova('Casal 7', '2029-03-03', 'rascunho');                                               // em aberto, rascunho
    const p8 = await nova('Casal 8', '2027-12-12'); await fechar(p8, 9999); await etapa(p8.id, { etapa: 'aberta' });   // fechou e reabriu
    let r = await admin('GET', '/admin/resumo');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      abertas: 3, fechadas: 4, perdidas: 1,
      total_fechado: 13700.5,
      fechado_mes: { mes, propostas: 2, total: 7200.5 },
      por_ano_evento: [
        { ano: '2027', eventos: 2, total: 7200.5 },
        { ano: '2028', eventos: 1, total: 5000 },
        { ano: '', eventos: 1, total: 1500 },
      ],
    });
    // mudar a data do evento no PUT comum reflete no resumo por ano (e não mexe no fechamento)
    const e = await admin('PUT', `/admin/propostas/${p1.id}`, { dados: dadosAna({ cliente: 'Casal 1', data: '2028-02-02' }), status: 'publicada' });
    assert.equal(e.json.valor_fechado, 4000);
    r = await admin('GET', '/admin/resumo');
    assert.deepEqual(r.json.por_ano_evento, [
      { ano: '2027', eventos: 1, total: 3200.5 },
      { ano: '2028', eventos: 2, total: 9000 },
      { ano: '', eventos: 1, total: 1500 },
    ]);
    assert.equal(r.json.total_fechado, 13700.5);
    // fechada que virou "não fechou" sai de todas as somas
    await etapa(p2.id, { etapa: 'perdida' });
    r = await admin('GET', '/admin/resumo');
    assert.deepEqual(r.json, {
      abertas: 3, fechadas: 3, perdidas: 2,
      total_fechado: 10500,
      fechado_mes: { mes, propostas: 1, total: 4000 },
      por_ano_evento: [{ ano: '2028', eventos: 2, total: 9000 }, { ano: '', eventos: 1, total: 1500 }],
    });
    // conferência independente pela lista
    const lista = await listar();
    assert.equal(lista.filter(p => p.etapa === 'aberta').length, r.json.abertas);
    assert.equal(lista.filter(p => p.etapa === 'fechada').reduce((s, p) => s + p.valor_fechado, 0), r.json.total_fechado);
    assert.ok(lista.filter(p => p.etapa !== 'fechada').every(p => p.valor_fechado === null));
    assert.equal((await api('GET', '/admin/resumo')).status, 401);
  });

  // ---------------------------------------------------------------- rate-limit (por último: bloqueia o login deste IP)
  grupo('Rate-limit do login');

  await teste('rajada em paralelo: só 8 tentativas chegam à senha, o resto leva 429 (registro atômico)', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.20' };
    const N = 48;
    const rajada = await Promise.all(Array.from({ length: N }, (_, i) => api('POST', '/login', { corpo: { senha: `errada-${i}` }, headers })));
    const conta = s => rajada.filter(r => r.status === s).length;
    assert.equal(conta(401), 8, `401 = ${conta(401)}, 429 = ${conta(429)}, outros = ${N - conta(401) - conta(429)}`);
    assert.equal(conta(429), N - 8);
    for (const r of rajada) {
      if (r.status === 401) assert.deepEqual(r.json, { erro: 'Senha incorreta.' });
      else assert.deepEqual(r.json, { erro: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
    }
    // bloqueado de verdade: a senha certa não entra, nem em nova rajada
    assert.equal((await api('POST', '/login', { corpo: { senha }, headers })).status, 429);
    const denovo = await Promise.all(Array.from({ length: 16 }, () => api('POST', '/login', { corpo: { senha }, headers })));
    assert.ok(denovo.every(r => r.status === 429 && !r.json.token), 'nenhuma passou');
  });

  await teste('IPv6: endereços do mesmo bloco /64 dividem a contagem; outro /64 e IPv4 não', async () => {
    const tentar = (ip, s = 'errada') => api('POST', '/login', { corpo: { senha: s }, headers: { 'cf-connecting-ip': ip } });
    for (let i = 1; i <= 8; i++) assert.equal((await tentar('2001:db8:1:2::1')).status, 401, `tentativa ${i}`);
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:0001:0002:0:0:0:9', '2001:db8:1:2:abcd::']) {
      assert.equal((await tentar(ip)).status, 429, ip);
      assert.equal((await tentar(ip, senha)).status, 429, `${ip} com a senha certa`);
    }
    assert.equal((await tentar('2001:db8:1:3::1')).status, 401, 'outro /64');
    assert.equal((await tentar('2001:db8:1:3::1', senha)).status, 200, 'outro /64 entra');
    assert.equal((await tentar('203.0.113.21')).status, 401, 'IPv4');
    assert.equal((await tentar('::ffff:203.0.113.22')).status, 401, 'IPv4 mapeado');
  });

  await teste('8 erros → a 9ª tentativa leva 429, mesmo com a senha certa', async () => {
    // um erro e um acerto antes: o acerto zera a contagem
    assert.equal((await api('POST', '/login', { corpo: { senha: 'errada' } })).status, 401);
    assert.equal((await api('POST', '/login', { corpo: { senha } })).status, 200);
    for (let i = 1; i <= 8; i++) {
      const r = await api('POST', '/login', { corpo: { senha: `errada-${i}` } });
      assert.equal(r.status, 401, `tentativa ${i}`);
    }
    const nona = await api('POST', '/login', { corpo: { senha: 'errada-9' } });
    assert.equal(nona.status, 429);
    assert.deepEqual(nona.json, { erro: 'Muitas tentativas. Espere 15 minutos e tente de novo.' });
    const certa = await api('POST', '/login', { corpo: { senha } });
    assert.equal(certa.status, 429);
    assert.ok(!certa.json.token);
    assert.equal((await admin('GET', '/admin/resumo')).status, 200, 'quem já estava logado continua');
    assert.equal((await api('GET', '/')).status, 200);
    // "visitante" não passa pelo limite (com a demo desligada, responde 503, e não 429)
    const v = await api('POST', '/login', { corpo: { senha: 'Visitante' } });
    assert.equal(v.status, 503);
    assert.deepEqual(v.json, { erro: 'O modo visitante está desligado.' });
  });
}

// ======================================================================================
// PARTE 2 — o mesmo Worker dentro do Node, com relógio simulado
// ======================================================================================

// D1 mínimo em cima do node:sqlite (prepare/bind/first/all/run + batch). Como no D1, o batch é uma
// transação: tudo ou nada, e nenhuma outra requisição se intercala no meio dele.
function d1(db) {
  const st = (sql, args = []) => ({
    bind: (...a) => st(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const i = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(i.changes) } }; },
    rodarJa: () => db.prepare(sql).run(...args),
  });
  return {
    prepare: sql => st(sql),
    batch: async lista => {
      db.exec('BEGIN');
      try { for (const s of lista) s.rodarJa(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return lista.map(() => ({ success: true }));
    },
  };
}

async function parte2() {
  const worker = (await import(pathToFileURL(path.join(RAIZ, 'src', 'index.js')).href)).default;
  const demo = await import(pathToFileURL(path.join(RAIZ, 'src', 'demo.js')).href);
  // no Workers existe crypto.subtle.timingSafeEqual; no Node, não
  if (!crypto.subtle.timingSafeEqual) {
    crypto.subtle.timingSafeEqual = (a, b) => nodeCrypto.timingSafeEqual(new Uint8Array(a), new Uint8Array(b));
  }
  const cli = env => clienteHttp((caminho, init) => worker.fetch(new Request(`http://teste.local${caminho}`, init), env));
  const SENHA = nodeCrypto.randomBytes(18).toString('base64url');   // só em memória
  const CHAVE = nodeCrypto.randomBytes(32).toString('base64url');   // SESSAO_CHAVE de teste, só em memória

  await teste('sem o secret ADMIN_SENHA: login → 503 e o painel fica fechado (o visitante, com SESSAO_CHAVE, continua)', async () => {
    for (const ADMIN_SENHA of [undefined, '']) {
      const c = cli({ ORIGENS: ORIGENS.join(','), ADMIN_SENHA });
      const r = await c('POST', '/login', { corpo: { senha: '' } });
      assert.equal(r.status, 503);
      assert.deepEqual(r.json, { erro: 'A senha do painel ainda não foi configurada.' });
      assert.equal((await c('GET', '/admin/propostas', { token: forjar('', { exp: 9999999999, papel: 'admin' }) })).status, 401);
      assert.equal((await c('GET', '/admin/resumo')).status, 401);
      assert.equal((await c('GET', '/')).status, 200);
      // a SESSAO_CHAVE não abre a porta do admin
      const v = cli({ ORIGENS: ORIGENS.join(','), ADMIN_SENHA, SESSAO_CHAVE: CHAVE, DEMO: '1' });
      assert.equal((await v('POST', '/login', { corpo: { senha: CHAVE } })).status, 503);
      const l = await v('POST', '/login', { corpo: { senha: 'visitante' } });
      assert.equal(l.status, 200);
      assert.equal(l.json.papel, 'visitante');
      assert.equal((await v('GET', '/admin/propostas', { token: forjar(CHAVE, { exp: 9999999999, papel: 'admin' }) })).status, 401);
    }
  });

  await teste('sem o secret SESSAO_CHAVE: "visitante" → 503 "O modo visitante está desligado." e nenhum token de visitante entra', async () => {
    for (const SESSAO_CHAVE of [undefined, '']) {
      const c = cli({ ORIGENS: ORIGENS.join(','), ADMIN_SENHA: SENHA, SESSAO_CHAVE, DEMO: '1' });
      for (const s of ['visitante', ' VISITANTE ']) {
        const r = await c('POST', '/login', { corpo: { senha: s } });
        assert.equal(r.status, 503, JSON.stringify(s));
        assert.deepEqual(r.json, { erro: 'O modo visitante está desligado.' });
      }
      // token de visitante (com qualquer chave, até a vazia) não entra
      for (const k of ['', CHAVE]) {
        const r = await c('GET', '/admin/resumo', { token: forjarVisitante(k, { exp: 9999999999, papel: 'visitante' }) });
        assert.equal(r.status, 401);
        assert.deepEqual(r.json, ERRO_SESSAO);
      }
    }
  });

  await teste('sem DEMO = "1" (cópia de um músico): o modo visitante fica desligado mesmo com a SESSAO_CHAVE gravada', async () => {
    for (const DEMO of [undefined, '0', '', 'sim', 1, true]) {
      const c = cli({ ORIGENS: ORIGENS.join(','), ADMIN_SENHA: SENHA, SESSAO_CHAVE: CHAVE, DEMO });
      for (const s of ['visitante', ' VISITANTE ']) {
        const r = await c('POST', '/login', { corpo: { senha: s } });
        assert.equal(r.status, 503, `DEMO ${JSON.stringify(DEMO)} ${JSON.stringify(s)}`);
        assert.deepEqual(r.json, { erro: 'O modo visitante está desligado.' });
      }
      // token de visitante bem assinado com a SESSAO_CHAVE (como se tivesse sido emitido): não entra
      const v = forjarVisitante(CHAVE, { exp: 9999999999, papel: 'visitante' });
      for (const caminho of ['/admin/propostas', '/admin/resumo', '/admin/modelo', '/admin/p/exemplo']) {
        const r = await c('GET', caminho, { token: v });
        assert.equal(r.status, 401, `DEMO ${JSON.stringify(DEMO)} ${caminho}`);
        assert.deepEqual(r.json, ERRO_SESSAO);
      }
    }
  });

  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node antigo */ }
  if (!DatabaseSync) {
    console.log('  (pulado: este Node não tem node:sqlite; os testes de relógio precisam do Node 22.5+)');
    return;
  }
  const schema = fs.readFileSync(path.join(RAIZ, 'schema.sql'), 'utf8');
  // sem DEMO (a base de um músico de verdade), a não ser que o teste peça
  const novoAmbiente = (extra = {}) => {
    const db = new DatabaseSync(':memory:');
    db.exec(schema);
    return { DB: d1(db), ORIGENS: ORIGENS.join(','), ADMIN_SENHA: SENHA, SESSAO_CHAVE: CHAVE, db, ...extra };
  };
  const contar = (amb, sql = 'SELECT COUNT(*) AS n FROM propostas', ...args) => amb.db.prepare(sql).get(...args).n;

  // relógio: Date.now() e new Date() passam a devolver a hora escolhida
  const DateReal = globalThis.Date;
  let relogio = null;
  class DateFalsa extends DateReal {
    constructor(...a) { if (a.length === 0 && relogio !== null) super(relogio); else super(...a); }
    static now() { return relogio === null ? DateReal.now() : relogio; }
  }
  globalThis.Date = DateFalsa;

  try {
    await teste('fuso: "hoje" é o dia em Brasília (UTC−3), não o dia em UTC', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      relogio = DateReal.UTC(2026, 10, 1, 1, 30);            // 01/11 01:30 UTC = 31/10 22:30 em Brasília
      let { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const nova = (await c('POST', '/admin/propostas', { token })).json;
      assert.equal(nova.dados.validade, '2026-11-30');       // 31/10 + 30 dias
      const criar = async cliente => (await c('POST', '/admin/propostas', { token, corpo: { dados: dadosAna({ cliente }), status: 'publicada' } })).json;
      const fechar = async (p, valor) => (await c('PUT', `/admin/propostas/${p.id}/etapa`, { token, corpo: { etapa: 'fechada', fechamento: { opcao: 'simples', pacote: 'cerimonia', valor } } })).json;
      const resumo = async () => (await c('GET', '/admin/resumo', { token })).json;
      const x = await criar('Fuso 1');
      const fx = await fechar(x, 1000);
      assert.equal(fx.fechado_em, '2026-10-31');
      assert.equal(fx.fechamento.data, '2026-10-31');
      const y = await criar('Fuso 2');
      const fy = (await c('PUT', `/admin/propostas/${y.id}/etapa`, { token, corpo: { etapa: 'perdida' } })).json;
      assert.equal(fy.fechado_em, '2026-10-31');
      assert.deepEqual((await resumo()).fechado_mes, { mes: '2026-10', propostas: 1, total: 1000 });
      relogio = DateReal.UTC(2026, 10, 1, 2, 59, 59);        // 23:59:59 de 31/10 em Brasília
      assert.deepEqual((await resumo()).fechado_mes, { mes: '2026-10', propostas: 1, total: 1000 });
      relogio = DateReal.UTC(2026, 10, 1, 3, 0, 0);          // meia-noite de 01/11 em Brasília
      let r = await resumo();
      assert.deepEqual(r.fechado_mes, { mes: '2026-11', propostas: 0, total: 0 });
      assert.equal(r.total_fechado, 1000);
      const z = await criar('Fuso 3');
      assert.equal((await fechar(z, 2000)).fechado_em, '2026-11-01');
      r = await resumo();
      assert.deepEqual(r.fechado_mes, { mes: '2026-11', propostas: 1, total: 2000 });
      assert.equal(r.total_fechado, 3000);
      relogio = DateReal.UTC(2027, 0, 1, 2, 0);              // 01/01/2027 02:00 UTC = 31/12/2026 23:00 em Brasília
      assert.equal((await c('GET', '/admin/resumo', { token })).status, 401, 'dois meses depois a sessão já venceu');
      ({ token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json);
      assert.equal((await resumo()).fechado_mes.mes, '2026-12');
      const copia = (await c('POST', `/admin/propostas/${x.id}/duplicar`, { token })).json;
      assert.equal(copia.dados.validade, '2027-01-30');      // 31/12 + 30 dias
    });

    await teste('rate-limit: é por IP e a janela de 15 minutos passa', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      const t0 = DateReal.UTC(2026, 9, 5, 15, 0, 0);
      relogio = t0;
      const ipA = { 'cf-connecting-ip': '198.51.100.7' }, ipB = { 'cf-connecting-ip': '198.51.100.8' };
      const tentar = (senha, headers) => c('POST', '/login', { corpo: { senha }, headers });
      for (let i = 1; i <= 8; i++) assert.equal((await tentar('errada', ipA)).status, 401, `tentativa ${i}`);
      assert.equal((await tentar(SENHA, ipA)).status, 429);
      assert.equal((await tentar(SENHA, ipB)).status, 200, 'outro IP não é afetado');
      relogio = t0 + 899 * 1000;
      assert.equal((await tentar(SENHA, ipA)).status, 429, '14 min 59 s: ainda bloqueado');
      relogio = t0 + 901 * 1000;
      assert.equal((await tentar(SENHA, ipA)).status, 200, '15 min depois: liberado');
      for (let i = 1; i <= 7; i++) assert.equal((await tentar('errada', ipA)).status, 401, `nova contagem ${i}`);
      assert.equal((await tentar(SENHA, ipA)).status, 200);
      assert.equal(amb.db.prepare('SELECT COUNT(*) AS n FROM login_falhas').get().n, 0, 'a tabela de falhas não acumula');
      // tentativa bloqueada não é gravada: insistir durante o bloqueio não estica a janela
      for (let i = 1; i <= 8; i++) assert.equal((await tentar('errada', ipA)).status, 401);   // 8 falhas em t0 + 901 s
      relogio = t0 + 1800 * 1000;                                                                // 899 s depois: ainda bloqueado
      for (let i = 1; i <= 20; i++) assert.equal((await tentar(i % 2 ? 'errada' : SENHA, ipA)).status, 429, `insistência ${i}`);
      assert.equal(amb.db.prepare('SELECT COUNT(*) AS n FROM login_falhas WHERE ip = ?').get('198.51.100.7').n, 8, 'só as 8 falhas ficam gravadas');
      relogio = t0 + 1802 * 1000;                                                                // 15 min e 1 s depois da 8ª falha
      assert.equal((await tentar(SENHA, ipA)).status, 200, '15 min depois da 8ª falha: liberado, apesar das 20 insistências');
    });

    await teste('rate-limit: rajada em paralelo não passa das 8 avaliações (as chamadas se entrelaçam nos await)', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 5, 16, 0, 0);
      const headers = { 'cf-connecting-ip': '198.51.100.9' };
      const rajada = await Promise.all(Array.from({ length: 40 }, (_, i) => c('POST', '/login', { corpo: { senha: `errada-${i}` }, headers })));
      assert.equal(rajada.filter(r => r.status === 401).length, 8);
      assert.equal(rajada.filter(r => r.status === 429).length, 32);
      assert.equal(amb.db.prepare('SELECT COUNT(*) AS n FROM login_falhas').get().n, 8);
      assert.equal((await c('POST', '/login', { corpo: { senha: SENHA }, headers })).status, 429);
    });

    await teste('rate-limit: IPv6 conta pelo bloco /64 (o provedor dá o bloco inteiro ao assinante)', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 5, 17, 0, 0);
      const tentar = (ip, s = 'errada') => c('POST', '/login', { corpo: { senha: s }, headers: { 'cf-connecting-ip': ip } });
      for (let i = 1; i <= 8; i++) assert.equal((await tentar('2001:db8:1:2::1')).status, 401);
      for (const ip of ['2001:db8:1:2::2', '2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:0001:0002:0:0:0:9', '2001:db8:1:2:abcd::']) {
        assert.equal((await tentar(ip, SENHA)).status, 429, ip);
      }
      assert.equal(amb.db.prepare('SELECT DISTINCT ip FROM login_falhas').all().map(r => r.ip).join(), '2001:0db8:0001:0002::/64');
      assert.equal((await tentar('2001:db8:1:3::1', SENHA)).status, 200, 'outro /64');
      assert.equal((await tentar('203.0.113.5', SENHA)).status, 200, 'IPv4');
      // IPv4 não é agrupado: 8 erros em .5 não bloqueiam .6
      for (let i = 1; i <= 8; i++) assert.equal((await tentar('203.0.113.5')).status, 401);
      assert.equal((await tentar('203.0.113.5', SENHA)).status, 429);
      assert.equal((await tentar('203.0.113.6', SENHA)).status, 200);
    });

    await teste('login: POST vazio sem content-type JSON (o "simples" de outro site) → 415 e não conta', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 5, 18, 0, 0);
      const ip = { 'cf-connecting-ip': '198.51.100.30' };
      for (let i = 0; i < 20; i++) {
        const r = await c('POST', '/login', { headers: i % 2 ? { ...ip, 'content-type': 'text/plain' } : ip });
        assert.equal(r.status, 415);
        assert.deepEqual(r.json, { erro: 'Envie o conteúdo em JSON.' });
      }
      assert.equal(amb.db.prepare('SELECT COUNT(*) AS n FROM login_falhas').get().n, 0, 'nada gravado');
      assert.equal((await c('POST', '/login', { corpo: { senha: SENHA }, headers: ip })).status, 200);
    });

    await teste('corpo em stream: a leitura para no limite e descarta o resto (não carrega o corpo inteiro)', async () => {
      const amb = novoAmbiente(), c = cli(amb);
      relogio = null;
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const pedaco = new Uint8Array(64 * 1024).fill(120);   // 64 KB
      const fluxo = (max = Infinity) => {
        const f = { lidos: 0, cancelado: false };
        f.stream = new ReadableStream({
          pull(ctrl) { if (f.lidos >= max) return ctrl.close(); f.lidos++; ctrl.enqueue(pedaco); },
          cancel() { f.cancelado = true; },
        }, { highWaterMark: 0 });
        return f;
      };
      for (const [m, caminho, tk] of [['POST', '/login', null], ['POST', '/admin/propostas', token], ['PUT', '/admin/modelo', token]]) {
        const f = fluxo(160);   // até 10 MB
        const r = await c(m, caminho, { token: tk, bruto: f.stream, duplex: 'half' });
        assert.equal(r.status, 413, `${m} ${caminho}`);
        assert.deepEqual(r.json, { erro: 'Conteúdo grande demais.' });
        await dormir(0);
        assert.ok(f.lidos <= 5, `${m} ${caminho}: leu ${f.lidos} pedaços de 64 KB (o limite é 200 KB)`);
        assert.ok(f.cancelado, `${m} ${caminho}: o resto do corpo foi descartado`);
      }
      // content-length acima do limite: 413 sem ler nenhum byte
      const f = fluxo();
      const r = await c('POST', '/login', { bruto: f.stream, duplex: 'half', headers: { 'content-length': String(300 * 1024) } });
      assert.equal(r.status, 413);
      assert.equal(f.lidos, 0, 'nenhum pedaço lido');
      // e nada disso contou como tentativa de senha
      assert.equal(amb.db.prepare('SELECT COUNT(*) AS n FROM login_falhas').get().n, 0);
    });

    await teste('sessão: vale 30 dias e depois expira', async () => {
      const c = cli(novoAmbiente());
      const t0 = DateReal.UTC(2026, 9, 5, 15, 0, 0);
      relogio = t0;
      const l = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      assert.equal(l.exp, t0 / 1000 + 30 * 86400);
      relogio = t0 + 30 * 86400 * 1000 - 5000;
      assert.equal((await c('GET', '/admin/resumo', { token: l.token })).status, 200);
      relogio = t0 + 30 * 86400 * 1000 + 1000;
      const r = await c('GET', '/admin/resumo', { token: l.token });
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, ERRO_SESSAO);
    });

    await teste('sessão: trocar a senha derruba as sessões antigas', async () => {
      const amb = novoAmbiente();
      relogio = DateReal.UTC(2026, 9, 5, 15, 0, 0);
      const l = (await cli(amb)('POST', '/login', { corpo: { senha: SENHA } })).json;
      assert.equal((await cli(amb)('GET', '/admin/resumo', { token: l.token })).status, 200);
      assert.equal((await cli({ ...amb, ADMIN_SENHA: `${SENHA}-nova` })('GET', '/admin/resumo', { token: l.token })).status, 401);
    });

    // ------------------------------------------------------------ visitante (com relógio e banco)

    await teste('visitante: entrar não grava nada em login_falhas, entra com o IP bloqueado e a sessão vale 7 dias', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      const t0 = DateReal.UTC(2026, 9, 5, 15, 0, 0);
      relogio = t0;
      const ip = { 'cf-connecting-ip': '198.51.100.50' };
      const tentar = (senha, headers = ip) => c('POST', '/login', { corpo: { senha }, headers });
      for (let i = 0; i < 20; i++) assert.equal((await tentar(i % 2 ? ' Visitante ' : 'visitante')).status, 200);
      assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM login_falhas'), 0, 'nenhuma tentativa gravada');
      for (let i = 1; i <= 8; i++) assert.equal((await tentar('errada')).status, 401);
      assert.equal((await tentar(SENHA)).status, 429);
      const l = await tentar('VISITANTE');
      assert.equal(l.status, 200, 'IP bloqueado: o visitante entra');
      assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM login_falhas'), 8, 'só as 8 falhas');
      assert.equal(l.json.exp, t0 / 1000 + 7 * 86400);
      assert.deepEqual(corpoDoToken(l.json.token), { exp: l.json.exp, papel: 'visitante' });
      relogio = t0 + 7 * 86400 * 1000 - 5000;
      assert.equal((await c('GET', '/admin/resumo', { token: l.json.token })).status, 200);
      relogio = t0 + 7 * 86400 * 1000 + 1000;
      const r = await c('GET', '/admin/resumo', { token: l.json.token });
      assert.equal(r.status, 401);
      assert.deepEqual(r.json, ERRO_SESSAO);
    });

    await teste('trocar a SESSAO_CHAVE derruba só as sessões de visitante; trocar a senha, só as de admin', async () => {
      const amb = novoAmbiente({ DEMO: '1' });
      relogio = DateReal.UTC(2026, 9, 5, 15, 0, 0);
      const adm = (await cli(amb)('POST', '/login', { corpo: { senha: SENHA } })).json;
      const vis = (await cli(amb)('POST', '/login', { corpo: { senha: 'visitante' } })).json;
      assert.equal(adm.papel, 'admin');
      assert.equal(vis.papel, 'visitante');
      const ler = (env, t) => cli(env)('GET', '/admin/resumo', { token: t.token }).then(r => r.status);
      assert.equal(await ler({ ...amb, SESSAO_CHAVE: `${CHAVE}-nova` }, vis), 401);
      assert.equal(await ler({ ...amb, SESSAO_CHAVE: `${CHAVE}-nova` }, adm), 200);
      assert.equal(await ler({ ...amb, ADMIN_SENHA: `${SENHA}-nova` }, vis), 200);
      assert.equal(await ler({ ...amb, ADMIN_SENHA: `${SENHA}-nova` }, adm), 401);
      // com o mesmo valor nos dois secrets, os sais diferentes ainda separam os papéis
      const igual = { ...amb, ADMIN_SENHA: SENHA, SESSAO_CHAVE: SENHA };
      const v2 = (await cli(igual)('POST', '/login', { corpo: { senha: 'visitante' } })).json;
      const [corpoV, sigV] = v2.token.split('.');
      const promovido = `${Buffer.from(JSON.stringify({ ...corpoDoToken(v2.token), papel: 'admin' })).toString('base64url')}.${sigV}`;
      assert.ok(corpoV);
      assert.equal(await ler(igual, { token: promovido }), 401, 'papel trocado no corpo');
      assert.equal(await ler(igual, { token: forjarVisitante(SENHA, { exp: 9999999999, papel: 'admin' }) }), 401, 'admin assinado com a chave do visitante');
      const w = await cli(igual)('PUT', '/admin/modelo', { token: v2.token, corpo: { dados: MODELO_PADRAO } });
      assert.equal(w.status, 403);
      // desligar a demo (DEMO apagado ou "0") derruba as sessões de visitante que já existiam; a do admin fica
      for (const DEMO of [undefined, '0']) {
        assert.equal(await ler({ ...amb, DEMO }, vis), 401, `DEMO ${JSON.stringify(DEMO)}`);
        assert.equal(await ler({ ...amb, DEMO }, adm), 200, `DEMO ${JSON.stringify(DEMO)}`);
      }
    });

    await teste('visitante: escrita → 403 sem ler nenhum byte do corpo (nem os 10 MB em stream) e nada é gravado', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = null;
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const p = (await c('POST', '/admin/propostas', { token, corpo: { dados: dadosAna(), status: 'publicada' } })).json;
      const v = (await c('POST', '/login', { corpo: { senha: 'visitante' } })).json.token;
      const fotografar = async () => JSON.stringify([(await c('GET', '/admin/propostas', { token })).json, (await c('GET', '/admin/modelo', { token })).json]);
      const antes = await fotografar();
      const pedaco = new Uint8Array(64 * 1024).fill(120);
      const fluxo = () => {
        const f = { lidos: 0 };
        f.stream = new ReadableStream({ pull(ctrl) { if (f.lidos >= 160) return ctrl.close(); f.lidos++; ctrl.enqueue(pedaco); } }, { highWaterMark: 0 });
        return f;
      };
      const escritas = [['POST', '/admin/propostas'], ['PUT', `/admin/propostas/${p.id}`], ['DELETE', `/admin/propostas/${p.id}`],
        ['POST', `/admin/propostas/${p.id}/duplicar`], ['PUT', `/admin/propostas/${p.id}/etapa`], ['PUT', '/admin/modelo'], ['PATCH', '/admin/modelo']];
      for (const [m, caminho] of escritas) {
        const f = fluxo();
        const r = await c(m, caminho, { token: v, bruto: f.stream, duplex: 'half' });
        assert.equal(r.status, 403, `${m} ${caminho}`);
        assert.deepEqual(r.json, ERRO_VISITANTE);
        await dormir(0);
        assert.equal(f.lidos, 0, `${m} ${caminho}: leu ${f.lidos} pedaços`);
        // content-length acima do limite também é 403 (não 413): o corpo nem é olhado
        const g = await c(m, caminho, { token: v, bruto: '{}', headers: { 'content-type': 'application/json', 'content-length': String(300 * 1024) } });
        assert.equal(g.status, 403, `${m} ${caminho} com content-length grande`);
      }
      assert.equal(await fotografar(), antes, 'nada mudou');
    });

    // ------------------------------------------------------------ demo (src/demo.js + env.DEMO = '1')

    await teste('gerarDemo: as 18 linhas da ESPEC §8, com sábados, datas e valores certos para qualquer "hoje"', async () => {
      const dias = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12',
        '2026-12-31', '2027-01-01', '2027-02-27', '2028-02-29'];
      for (const h of dias) {
        const linhas = demo.gerarDemo(h);
        assert.deepEqual(demo.gerarDemo(h), linhas, 'sempre o mesmo resultado para o mesmo dia');
        conferirDemo(linhas, h);
      }
      assert.throws(() => demo.gerarDemo('06/10/2026'));
      assert.throws(() => demo.gerarDemo(undefined));
    });

    await teste('DEMO=1: o primeiro GET grava as 18 linhas da demo; os seguintes não duplicam; resumo e formato certos', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);   // 06/10/2026, 12h em Brasília
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      assert.equal(contar(amb), 0, 'o login não grava a demo');
      const r = await c('GET', '/admin/propostas', { token });
      assert.equal(r.status, 200);
      assert.equal(r.json.length, 18);
      const linhas = demo.gerarDemo('2026-10-06');
      conferirNoPainel(r.json, linhas);
      assert.deepEqual(r.json.map(p => p.atualizado_em), r.json.map(p => p.atualizado_em).sort().reverse(), 'mais recente primeiro');
      assert.deepEqual(amb.db.prepare('SELECT id, semeado_em FROM demo_meta').all().map(x => ({ ...x })), [{ id: 1, semeado_em: '2026-10-06' }]);
      for (const caminho of ['/admin/propostas', '/admin/resumo', '/admin/modelo', `/admin/propostas/${linhas[1].id}`, '/admin/p/exemplo', '/admin/p/sofia-e-daniel']) {
        assert.equal((await c('GET', caminho, { token })).status, 200, caminho);
      }
      assert.equal(contar(amb), 18, 'sem duplicar');
      assert.deepEqual((await c('GET', '/admin/resumo', { token })).json, {
        abertas: 6, fechadas: 9, perdidas: 3, total_fechado: 46400,
        fechado_mes: { mes: '2026-10', propostas: 2, total: 9900 },
        por_ano_evento: [{ ano: '2026', eventos: 6, total: 27200 }, { ano: '2027', eventos: 3, total: 19200 }],
      });
      // as linhas da demo têm o mesmo formato que o painel grava: passam pelo limpar() sem mudar nada
      // (e as publicadas passam na validação de publicação)
      for (const l of linhas) {
        const { _publicada_alguma_vez, ...dados } = JSON.parse(l.dados);
        const x = await c('POST', '/admin/propostas', { token, corpo: { dados, status: l.status } });
        assert.equal(x.status, 201, `${l.slug}: ${x.texto}`);
        assert.deepEqual(x.json.dados, dados, l.slug);
        assert.equal((await c('DELETE', `/admin/propostas/${x.json.id}`, { token })).status, 200);
      }
      assert.equal(contar(amb), 18);
    });

    await teste('gerarContatosDemo: 12 contatos fictícios, 10 ligados à proposta de mesmo nome e 2 sem proposta, com lembrete', async () => {
      for (const h of ['2026-10-06', '2026-12-31', '2028-02-29']) {
        const linhas = demo.gerarDemo(h), cs = demo.gerarContatosDemo(h, linhas);
        assert.deepEqual(demo.gerarContatosDemo(h), cs, 'sem as linhas, gera as mesmas');
        assert.equal(cs.length, 12);
        assert.equal(new Set(cs.map(x => x.id)).size, 12);
        cs.forEach((x, i) => {
          mesmasChaves(x, demo.COLUNAS_CONTATO, x.nome);
          assert.equal(x.id, `00000000-0000-4000-8000-0000000001${String(i + 1).padStart(2, '0')}`);
          assert.ok(!linhas.some(l => l.id === x.id), 'id de contato não colide com id de proposta');
          assert.match(x.whatsapp, /^(\d{11})?$/, x.nome);
          assert.ok(['instagram', 'portal', 'indicacao', 'google', 'whatsapp', 'outro'].includes(x.origem), x.nome);
          assert.match(x.data_evento, /^\d{4}-\d{2}-\d{2}$/);
          assert.match(x.criado_em, ISO);
          assert.equal(x.atualizado_em, x.criado_em);
          assert.ok(x.criado_em.slice(0, 10) <= h, 'nenhum contato do futuro');
          if (x.proposta_id) {
            const p = linhas.find(l => l.id === x.proposta_id);
            assert.ok(p, `${x.nome}: proposta da demo`);
            assert.equal(p.cliente, x.nome);
            assert.equal(p.data_evento, x.data_evento);
            assert.ok(x.criado_em < p.criado_em, 'o contato chega antes da proposta');
          }
        });
        assert.equal(cs.filter(x => x.proposta_id).length, 10);
        const por = o => cs.filter(x => x.origem === o).length;
        assert.deepEqual(['instagram', 'portal', 'indicacao', 'google', 'whatsapp'].map(por), [4, 3, 2, 2, 1]);
        const d = n => demo.somarDias(h, n);
        assert.deepEqual(cs.filter(x => x.lembrete_em).map(x => [x.nome, x.lembrete_em, x.lembrete_txt]), [
          ['Marina & Rafael', d(0), 'Perguntar se ficou alguma dúvida'],
          ['Isabela & Rodrigo', d(-1), 'Responder a dúvida sobre o álbum'],
          ['Rafaela & Otávio', d(2), 'Mandar a proposta'],
          ['Clínica Ser · confraternização', d(0), 'Mandar a proposta'],
        ]);
        assert.equal(cs.find(x => x.nome.startsWith('Clínica')).whatsapp, '', 'um contato sem WhatsApp');
      }
    });

    await teste('DEMO=1: contatos de exemplo gravados com a demo; visitante só lê os 12; regravação devolve e o do admin fica', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const v = (await c('POST', '/login', { corpo: { senha: 'visitante' } })).json.token;
      const nContatos = () => contar(amb, 'SELECT COUNT(*) AS n FROM contatos');
      const porId = l => [...l].sort((a, b) => a.id.localeCompare(b.id));
      const ct = nn => `00000000-0000-4000-8000-0000000001${String(nn).padStart(2, '0')}`;
      const pr = nn => `00000000-0000-4000-8000-0000000000${String(nn).padStart(2, '0')}`;
      assert.equal(nContatos(), 0);
      // o primeiro GET de contatos também grava a demo
      const r = await c('GET', '/admin/contatos', { token: v });
      assert.equal(r.status, 200);
      assert.deepEqual(porId(r.json), porId(demo.gerarContatosDemo('2026-10-06')));
      assert.deepEqual(r.json.map(x => x.criado_em), r.json.map(x => x.criado_em).sort().reverse(), 'mais recente primeiro');
      assert.equal(contar(amb), 18);
      // o admin cria dois contatos (um ligado a uma proposta da demo) e mexe nos da demo
      const meu = (await c('POST', '/admin/contatos', { token, corpo: { nome: 'Contato do Admin', whatsapp: '11977776666', origem: 'outro', proposta_id: pr(1) } })).json;
      const meu2 = (await c('POST', '/admin/contatos', { token, corpo: { nome: 'Outro do Admin', obs: 'nota privada' } })).json;
      assert.equal(meu.proposta_id, pr(1));
      assert.equal((await c('PUT', `/admin/contatos/${ct(2)}`, { token, corpo: { nome: 'Beatriz & Thiago', obs: 'Mudado pelo admin' } })).status, 200);
      assert.equal((await c('DELETE', `/admin/contatos/${ct(3)}`, { token })).status, 200);
      assert.equal((await c('DELETE', `/admin/propostas/${pr(13)}`, { token })).status, 200);   // a do contato 08
      assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM contatos WHERE id = ? AND proposta_id IS NULL', ct(8)), 1, 'excluir a proposta solta o vínculo');
      // o visitante: só os da demo (11, com as mudanças do admin), nunca os do admin; toda escrita → 403 e nada muda
      const antes = JSON.stringify(amb.db.prepare('SELECT * FROM contatos ORDER BY id').all());
      const lv = await c('GET', '/admin/contatos', { token: v });
      assert.equal(lv.json.length, 11);
      assert.ok(lv.json.every(x => x.id.startsWith(demo.DEMO_PREFIXO)));
      for (const segredo of ['Contato do Admin', 'Outro do Admin', 'nota privada', '11977776666']) assert.ok(!lv.texto.includes(segredo), segredo);
      for (const [m, caminho, corpo] of [['POST', '/admin/contatos', { nome: 'Visitante' }], ['PUT', `/admin/contatos/${ct(1)}`, { nome: 'Trocado' }],
        ['DELETE', `/admin/contatos/${ct(1)}`], ['PUT', `/admin/contatos/${meu.id}`, { nome: 'X' }], ['DELETE', `/admin/contatos/${meu.id}`]]) {
        const x = await c(m, caminho, { token: v, corpo });
        assert.equal(x.status, 403, `${m} ${caminho}`);
        assert.deepEqual(x.json, ERRO_VISITANTE);
      }
      assert.equal(JSON.stringify(amb.db.prepare('SELECT * FROM contatos ORDER BY id').all()), antes, 'nada mudou');
      assert.equal((await c('GET', '/admin/contatos', { token })).json.length, 13, '11 da demo + 2 do admin');
      // 7 dias depois: a demo volta ao estado de fábrica (contatos e propostas) e os do admin ficam como estavam
      relogio = DateReal.UTC(2026, 9, 13, 3, 0, 0);
      const la = (await c('GET', '/admin/contatos', { token })).json;
      assert.equal(la.length, 14);
      assert.deepEqual(porId(la.filter(x => x.id.startsWith(demo.DEMO_PREFIXO))), porId(demo.gerarContatosDemo('2026-10-13')));
      assert.deepEqual(la.find(x => x.id === meu.id), meu);
      assert.deepEqual(la.find(x => x.id === meu2.id), meu2);
      assert.equal((await c('GET', '/admin/contatos', { token: v })).json.length, 12);
      assert.equal(contar(amb), 18);
    });

    await teste('DEMO=1: várias requisições ao mesmo tempo no banco vazio dão o mesmo resultado (idempotente)', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const v = (await c('POST', '/login', { corpo: { senha: 'visitante' } })).json.token;
      const pedidos = [];
      for (let i = 0; i < 5; i++) {
        pedidos.push(c('GET', '/admin/propostas', { token }), c('GET', '/admin/resumo', { token: v }), c('GET', '/p/exemplo'),
          c('GET', '/admin/p/sofia-e-daniel', { token: v }));
      }
      const rs = await Promise.all(pedidos);
      assert.ok(rs.every(r => r.status === 200), rs.map(r => r.status).join());
      for (let i = 0; i < rs.length; i += 4) assert.equal(rs[i].json.length, 18);
      assert.equal(contar(amb), 18);
      assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM demo_meta'), 1);
      // tirando as aberturas do exemplo (o público pode ter aberto antes ou depois de cada regravação), é igual à demo
      const lista = (await c('GET', '/admin/propostas', { token })).json;
      conferirNoPainel(lista, demo.gerarDemo('2026-10-06'));
    });

    await teste('DEMO=1: /p/exemplo abre para o público já na primeira requisição, sem contar abertura; o visitante só lê', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
      const r = await c('GET', '/p/exemplo');
      assert.equal(r.status, 200);
      mesmasChaves(r.json, ['slug', 'dados']);
      mesmasChaves(r.json.dados, CHAVES_DADOS);
      assert.equal(r.json.slug, 'exemplo');
      assert.equal(r.json.dados.cliente, 'Marina & Rafael');
      assert.equal(r.json.dados.sugestao, 'media');
      assert.ok(r.json.dados.mensagem.length > 20);
      assert.ok(!r.texto.includes('_publicada') && !r.texto.includes('views'));
      // abrir uma linha da demonstração não conta (o link "exemplo" vai para muitos músicos)
      for (let i = 0; i < 3; i++) assert.equal((await c('GET', '/p/exemplo')).status, 200);
      assert.equal(contar(amb, 'SELECT views AS n FROM propostas WHERE slug = ?', 'exemplo'), 4, 'continuam as 4 da demo');
      assert.equal(contar(amb, "SELECT COUNT(*) AS n FROM propostas WHERE ultima_vista >= '2026-10-06'"), 0, 'nenhuma abertura de hoje');
      assert.equal(contar(amb), 18);
      assert.equal((await c('GET', '/p/sofia-e-daniel')).status, 404, 'rascunho não abre para o público');
      for (const slug of ['beatriz-e-thiago', 'carolina-e-eduardo', 'convencao-prisma-2027', 'bodas-de-prata-lucia-e-antonio']) assert.equal((await c('GET', `/p/${slug}`)).status, 200, slug);
      // o visitante vê a prévia do rascunho, o resumo da demo, e não grava
      const v = (await c('POST', '/login', { corpo: { senha: 'visitante' } })).json.token;
      const pv = await c('GET', '/admin/p/sofia-e-daniel', { token: v });
      assert.equal(pv.status, 200);
      assert.equal(pv.json.status, 'rascunho');
      assert.equal((await c('GET', '/admin/resumo', { token: v })).json.abertas, 6);
      const w = await c('PUT', `/admin/propostas/${pv.json.id}/etapa`, { token: v, corpo: { etapa: 'perdida' } });
      assert.equal(w.status, 403);
      assert.equal((await c('GET', '/admin/p/sofia-e-daniel', { token: v })).json.etapa, 'aberta');
      // uma proposta do administrador, na mesma instância, conta abertura normalmente
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const meu = (await c('POST', '/admin/propostas', { token, corpo: { dados: dadosAna({ cliente: 'Casal do Admin' }), status: 'publicada' } })).json;
      for (let i = 0; i < 2; i++) assert.equal((await c('GET', `/p/${meu.slug}`)).status, 200);
      assert.equal((await c('GET', `/admin/propostas/${meu.id}`, { token })).json.views, 2);
    });

    await teste('DEMO=1: o visitante só enxerga as linhas da demo (rascunho, valor e observação do admin nunca saem para ele)', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const v = (await c('POST', '/login', { corpo: { senha: ' VISITANTE ' } })).json.token;
      // o admin cria, na demonstração, um rascunho com dados que parecem reais e fecha outra proposta com observação
      const real = (await c('POST', '/admin/propostas', { token, corpo: { status: 'rascunho',
        dados: dadosAna({ cliente: 'Casal Real Teste', data: '2027-05-15', local: 'Endereço do casal', mensagem: 'msg privada' }) } })).json;
      const fechou = (await c('POST', '/admin/propostas', { token, corpo: { dados: dadosAna({ cliente: 'Outro Casal Real' }), status: 'publicada' } })).json;
      const f = await c('PUT', `/admin/propostas/${fechou.id}/etapa`, { token, corpo: { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 4321, obs: 'obs interna' } } });
      assert.equal(f.json.valor_fechado, 4321);
      const doAdmin = (await c('GET', '/admin/propostas', { token })).json;
      assert.equal(doAdmin.length, 20, 'o admin vê as 18 da demo + as 2 dele');
      // o visitante: só as 18 da demo, iguais às do admin
      const lista = await c('GET', '/admin/propostas', { token: v });
      assert.equal(lista.status, 200);
      assert.deepEqual(lista.json, doAdmin.filter(p => p.id.startsWith(demo.DEMO_PREFIXO)));
      assert.equal(lista.json.length, 18);
      for (const segredo of ['Casal Real Teste', 'Outro Casal Real', 'msg privada', 'obs interna', 'Endereço do casal', '4321']) {
        assert.ok(!lista.texto.includes(segredo), `a lista do visitante tem "${segredo}"`);
      }
      for (const caminho of [`/admin/propostas/${real.id}`, `/admin/propostas/${fechou.id}`, `/admin/p/${real.slug}`, `/admin/p/${fechou.slug}`]) {
        const r = await c('GET', caminho, { token: v });
        assert.equal(r.status, 404, caminho);
        assert.deepEqual(r.json, { erro: 'Proposta não encontrada.' });
      }
      // as linhas da demo continuam abrindo (inclusive a prévia do rascunho de exemplo)
      assert.equal((await c('GET', `/admin/propostas/${demo.DEMO_PREFIXO}000000000001`, { token: v })).status, 200);
      assert.equal((await c('GET', '/admin/p/sofia-e-daniel', { token: v })).json.status, 'rascunho');
      // o resumo do visitante é só o da demo; o do admin soma a venda dele
      const rv = (await c('GET', '/admin/resumo', { token: v })).json;
      assert.deepEqual(rv, {
        abertas: 6, fechadas: 9, perdidas: 3, total_fechado: 46400,
        fechado_mes: { mes: '2026-10', propostas: 2, total: 9900 },
        por_ano_evento: [{ ano: '2026', eventos: 6, total: 27200 }, { ano: '2027', eventos: 3, total: 19200 }],
      });
      const ra = (await c('GET', '/admin/resumo', { token })).json;
      assert.deepEqual([ra.abertas, ra.fechadas, ra.total_fechado, ra.fechado_mes.total], [7, 10, 46400 + 4321, 9900 + 4321]);
      // e ele continua sem gravar nada
      assert.equal((await c('DELETE', `/admin/propostas/${real.id}`, { token: v })).status, 403);
      assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 20);
    });

    await teste('DEMO=1: com mais de 6 dias (data de Brasília) a demo volta ao estado de fábrica; o que o admin criou fica', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      const id = nn => `00000000-0000-4000-8000-0000000000${String(nn).padStart(2, '0')}`;
      assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 18);
      // o admin cria e fecha uma proposta dele...
      const meu = (await c('POST', '/admin/propostas', { token, corpo: { dados: dadosAna({ cliente: 'Casal do Admin' }), status: 'publicada' } })).json;
      const meuFechado = (await c('PUT', `/admin/propostas/${meu.id}/etapa`, { token, corpo: { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 4200 } } })).json;
      assert.equal(meuFechado.etapa, 'fechada');
      // ...e mexe na demo: edita uma, fecha outra, apaga uma terceira e o público abre o exemplo
      const d2 = (await c('GET', `/admin/propostas/${id(2)}`, { token })).json;
      assert.equal((await c('PUT', `/admin/propostas/${id(2)}`, { token, corpo: { dados: { ...d2.dados, local: 'Local mudado' } } })).status, 200);
      assert.equal((await c('PUT', `/admin/propostas/${id(11)}/etapa`, { token, corpo: { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 4200 } } })).status, 200);
      assert.equal((await c('DELETE', `/admin/propostas/${id(12)}`, { token })).status, 200);
      assert.equal((await c('GET', '/p/exemplo')).status, 200);
      const conferirMexida = lista => {
        assert.equal(lista.length, 18, '17 da demo + a do admin');
        assert.equal(lista.find(p => p.id === id(2)).dados.local, 'Local mudado');
        assert.equal(lista.find(p => p.id === id(11)).etapa, 'fechada');
        assert.ok(!lista.some(p => p.id === id(12)));
        assert.equal(lista.find(p => p.slug === 'exemplo').views, 4, 'abrir o exemplo não conta');
      };
      // 6 dias depois, até 23:59:59 em Brasília: nada é regravado (nem pelo público, nem pelo painel)
      for (const hora of [DateReal.UTC(2026, 9, 12, 15, 0, 0), DateReal.UTC(2026, 9, 13, 2, 59, 59)]) {
        relogio = hora;
        assert.equal((await c('GET', '/p/beatriz-e-thiago')).status, 200);
        conferirMexida((await c('GET', '/admin/propostas', { token })).json);
      }
      assert.equal(amb.db.prepare('SELECT semeado_em FROM demo_meta').get().semeado_em, '2026-10-06');
      // 13/10 03:00 UTC = 13/10 00:00 em Brasília, 7 dias depois: regrava
      relogio = DateReal.UTC(2026, 9, 13, 3, 0, 0);
      const lista = (await c('GET', '/admin/propostas', { token })).json;
      assert.equal(lista.length, 19, '18 da demo + a do admin');
      conferirNoPainel(lista.filter(p => p.id !== meu.id), demo.gerarDemo('2026-10-13'));
      assert.deepEqual(lista.find(p => p.id === meu.id), meuFechado, 'a proposta do admin ficou intacta');
      assert.equal(amb.db.prepare('SELECT semeado_em FROM demo_meta').get().semeado_em, '2026-10-13');
      // o resumo soma a demo nova + a venda do admin
      const resumo = (await c('GET', '/admin/resumo', { token })).json;
      assert.equal(resumo.fechadas, 10);
      assert.equal(resumo.total_fechado, 46400 + 4200);
    });

    await teste('DEMO=1: data da demo vazia, inválida ou no futuro → regrava no próximo GET', async () => {
      for (const semeado of [null, '', 'lixo', '2026-13-01', '2099-01-01', '2026-10-07']) {
        const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
        relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
        const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
        amb.db.prepare('INSERT INTO demo_meta (id, semeado_em) VALUES (1, ?)').run(semeado);
        assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 18, `semeado_em ${JSON.stringify(semeado)}`);
        assert.equal(amb.db.prepare('SELECT semeado_em FROM demo_meta').get().semeado_em, '2026-10-06');
      }
      // no prazo (hoje e 6 dias atrás): não regrava
      for (const semeado of ['2026-10-06', '2026-09-30']) {
        const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
        const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
        amb.db.prepare('INSERT INTO demo_meta (id, semeado_em) VALUES (1, ?)').run(semeado);
        assert.deepEqual((await c('GET', '/admin/propostas', { token })).json, [], `semeado_em ${semeado}`);
      }
    });

    await teste('sem DEMO = "1" nada da demo roda (a base de um músico de verdade); escrita do admin não grava a demo', async () => {
      for (const DEMO of [undefined, '0', '', 'sim', 1, true]) {
        const amb = novoAmbiente({ DEMO }), c = cli(amb);
        relogio = DateReal.UTC(2026, 9, 6, 15, 0, 0);
        const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
        assert.deepEqual((await c('GET', '/admin/propostas', { token })).json, [], `DEMO ${JSON.stringify(DEMO)}`);
        assert.equal((await c('GET', '/p/exemplo')).status, 404);
        assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM demo_meta'), 0);
      }
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      assert.equal((await c('POST', '/admin/propostas', { token })).status, 201);
      assert.equal((await c('PUT', '/admin/modelo', { token, corpo: { dados: MODELO_PADRAO } })).status, 200);
      assert.equal(contar(amb), 1, 'POST/PUT não gravam a demo');
      assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 19, 'o GET seguinte grava');
    });

    await teste('schema.sql: roda de novo sem apagar propostas nem sobrescrever o modelo', async () => {
      const amb = novoAmbiente({ DEMO: '1' }), c = cli(amb);
      relogio = null;
      const { token } = (await c('POST', '/login', { corpo: { senha: SENHA } })).json;
      await c('PUT', '/admin/modelo', { token, corpo: { dados: { ...MODELO_PADRAO, validade_dias: 60 } } });
      await c('POST', '/admin/propostas', { token });
      assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 19);
      amb.db.exec(schema);
      assert.equal((await c('GET', '/admin/modelo', { token })).json.validade_dias, 60);
      assert.equal((await c('GET', '/admin/propostas', { token })).json.length, 19);
      assert.equal(contar(amb, 'SELECT COUNT(*) AS n FROM demo_meta'), 1);
      const inserir = (coluna, valor) => amb.db.prepare(
        `INSERT INTO propostas (id, slug, dados, criado_em, atualizado_em, ${coluna}) VALUES ('i', 's', '{}', 'x', 'x', ?)`).run(valor);
      assert.throws(() => inserir('etapa', 'ganha'), /CHECK/);
      assert.throws(() => inserir('status', 'arquivada'), /CHECK/);
      assert.throws(() => amb.db.prepare(`INSERT INTO modelo (id, dados, atualizado_em) VALUES (2, '{}', 'x')`).run(), /CHECK/);
      assert.throws(() => amb.db.prepare(`INSERT INTO demo_meta (id, semeado_em) VALUES (2, 'x')`).run(), /CHECK/);
    });
  } finally {
    globalThis.Date = DateReal;
  }
}

// ======================================================================================
// PARTE 3 — Worker de verdade com a demo ligada (DEMO = "1" do wrangler.toml)
// ======================================================================================

// 3a: banco novo. O primeiro GET grava as 18 linhas num D1 de verdade (batch), o segundo não duplica,
// o exemplo abre (sem contar abertura), o modo visitante por HTTP (login, limite de tentativas, só leitura,
// só as linhas da demo) e o admin grava (cria uma proposta e mexe em duas da demo).
async function parte3a({ senha, chave }) {
  const api = clienteHttp((caminho, init) => fetch(BASE + caminho, init));
  const demo = await import(pathToFileURL(path.join(RAIZ, 'src', 'demo.js')).href);
  const token = (await api('POST', '/login', { corpo: { senha } })).json?.token;
  let visita = (await api('POST', '/login', { corpo: { senha: 'visitante' } })).json?.token;
  if (!token || !visita) throw new Error('Login de admin ou de visitante falhou na parte 3.');
  const hoje0 = hojeBr();
  const estado = { token, meu: null };
  const admin = (metodo, caminho, corpo, extra) => api(metodo, caminho, { token, corpo, ...extra });
  const visitante = (metodo, caminho, extra) => api(metodo, caminho, { token: visita, ...extra });
  const loginComo = (s, ip) => api('POST', '/login', { corpo: { senha: s }, headers: { 'cf-connecting-ip': ip } });
  const listar = async () => (await admin('GET', '/admin/propostas')).json;
  const doDemo = p => p.id.startsWith(demo.DEMO_PREFIXO);

  await teste('DEMO=1: requisições ao mesmo tempo no banco novo gravam as 18 linhas uma vez só', async () => {
    const pedidos = [];
    for (let i = 0; i < 4; i++) {
      pedidos.push(api('GET', '/admin/propostas', { token }), api('GET', '/admin/resumo', { token: visita }), api('GET', '/p/exemplo'),
        api('GET', '/admin/p/sofia-e-daniel', { token: visita }));
    }
    const rs = await Promise.all(pedidos);
    assert.ok(rs.every(r => r.status === 200), rs.map(r => `${r.status} ${r.texto.slice(0, 80)}`).join(' | '));
    for (let i = 0; i < rs.length; i += 4) assert.equal(rs[i].json.length, 18);
    const lista = (await api('GET', '/admin/propostas', { token })).json;
    conferirNoPainel(lista, demo.gerarDemo(hoje0));
  });

  await teste('DEMO=1: o GET seguinte não duplica; o exemplo abre para o público sem contar abertura; rascunho não abre', async () => {
    const antes = (await api('GET', '/admin/p/exemplo', { token })).json.views;
    const r = await api('GET', '/p/exemplo');
    assert.equal(r.status, 200);
    mesmasChaves(r.json, ['slug', 'dados']);
    assert.equal(r.json.dados.cliente, 'Marina & Rafael');
    assert.equal((await api('GET', '/admin/p/exemplo', { token })).json.views, antes, 'na demonstração, o exemplo não conta abertura');
    assert.equal((await api('GET', '/p/sofia-e-daniel')).status, 404);
    assert.equal((await api('GET', '/admin/propostas', { token })).json.length, 18);
    const resumo = (await api('GET', '/admin/resumo', { token: visita })).json;
    assert.deepEqual([resumo.abertas, resumo.fechadas, resumo.perdidas, resumo.total_fechado], [6, 9, 3, 46400]);
  });

  // ---------------------------------------------------------------- modo visitante por HTTP
  grupo('Modo visitante (só leitura, só as linhas da demo)');

  await teste('login "visitante" (maiúsculas e espaços não importam) → { token, exp, papel: "visitante" } de 7 dias', async () => {
    for (const s of ['visitante', ' Visitante ', 'VISITANTE', '\tvisitante\n', 'ViSiTaNtE']) {
      const antes = agoraSeg();
      const r = await loginComo(s, '203.0.113.40');
      assert.equal(r.status, 200, JSON.stringify(s));
      mesmasChaves(r.json, ['token', 'exp', 'papel']);
      assert.equal(r.json.papel, 'visitante');
      assert.ok(r.json.exp >= antes + 7 * 86400 - 5 && r.json.exp <= antes + 7 * 86400 + 60, 'exp = agora + 7 dias');
      assert.deepEqual(corpoDoToken(r.json.token), { exp: r.json.exp, papel: 'visitante' });
      assert.ok(!r.texto.includes(chave), 'a resposta não devolve a chave');
      visita = r.json.token;
    }
    // parecido não é "visitante": vira tentativa de senha comum
    for (const s of ['visitantes', 'visit ante', 'vísitante', 'visitante.', 'visitante visitante']) {
      const r = await loginComo(s, '203.0.113.39');
      assert.equal(r.status, 401, JSON.stringify(s));
      assert.deepEqual(r.json, { erro: 'Senha incorreta.' });
    }
    // corpo fora de JSON continua 415, mesmo com "visitante"
    const r = await api('POST', '/login', { bruto: '{"senha":"visitante"}', headers: { 'content-type': 'text/plain' } });
    assert.equal(r.status, 415);
    // o token bem assinado com a SESSAO_CHAVE (sal do visitante) vale; o papel trocado no corpo, não
    assert.equal((await api('GET', '/admin/resumo', { token: forjarVisitante(chave, { exp: agoraSeg() + 600, papel: 'visitante' }) })).status, 200);
    assert.equal((await api('GET', '/admin/resumo', { token: forjarVisitante(chave, { exp: agoraSeg() + 600, papel: 'admin' }) })).status, 401);
  });

  await teste('visitante não passa pelo limite de tentativas nem conta como tentativa (nem com 8 erros antes)', async () => {
    const ip = '203.0.113.41';
    for (let i = 0; i < 12; i++) assert.equal((await loginComo(i % 2 ? 'VISITANTE' : 'visitante', ip)).status, 200, `visitante ${i + 1}`);
    // as 12 entradas de visitante não contaram: ainda cabem 8 erros
    for (let i = 1; i <= 8; i++) assert.equal((await loginComo(`errada-${i}`, ip)).status, 401, `tentativa ${i}`);
    assert.equal((await loginComo('errada-9', ip)).status, 429);
    // IP bloqueado: a senha certa não entra, o visitante entra
    assert.equal((await loginComo(senha, ip)).status, 429);
    for (const s of ['visitante', ' Visitante ']) {
      const r = await loginComo(s, ip);
      assert.equal(r.status, 200, `${JSON.stringify(s)} com o IP bloqueado`);
      assert.equal(r.json.papel, 'visitante');
    }
    // rajada de visitantes em paralelo num IP limpo: todos entram e nenhum conta
    const rajada = await Promise.all(Array.from({ length: 20 }, () => loginComo('visitante', '203.0.113.42')));
    assert.ok(rajada.every(r => r.status === 200 && r.json.papel === 'visitante'), rajada.map(r => r.status).join());
    for (let i = 1; i <= 8; i++) assert.equal((await loginComo('errada', '203.0.113.42')).status, 401, `depois da rajada ${i}`);
  });

  await teste('visitante lê as 5 rotas GET, só com as linhas da demo: o que o admin cria (rascunho, valor, observação) nunca aparece', async () => {
    // o admin cria, na demonstração, um rascunho que parece real e fecha outra proposta com observação interna
    const real = (await admin('POST', '/admin/propostas', { status: 'rascunho',
      dados: dadosAna({ cliente: 'Casal Real Teste', data: '2027-05-15', local: 'Endereço do casal', mensagem: 'msg privada' }) })).json;
    const fechou = (await admin('POST', '/admin/propostas', { dados: dadosAna({ cliente: 'Outro Casal Real' }), status: 'publicada' })).json;
    assert.equal((await admin('PUT', `/admin/propostas/${fechou.id}/etapa`,
      { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 4321, obs: 'obs interna' } })).json.valor_fechado, 4321);
    try {
      const todas = await listar();
      assert.equal(todas.length, 20);
      const lista = await visitante('GET', '/admin/propostas');
      assert.equal(lista.status, 200);
      assert.deepEqual(lista.json, todas.filter(doDemo), 'o visitante vê só as 18 da demo, iguais às do admin');
      for (const segredo of ['Casal Real Teste', 'Outro Casal Real', 'msg privada', 'obs interna', 'Endereço do casal', '4321']) {
        assert.ok(!lista.texto.includes(segredo), `a lista do visitante tem "${segredo}"`);
      }
      for (const c of [`/admin/propostas/${real.id}`, `/admin/propostas/${fechou.id}`, `/admin/p/${real.slug}`, `/admin/p/${fechou.slug}`]) {
        const r = await visitante('GET', c);
        assert.equal(r.status, 404, c);
        assert.deepEqual(r.json, { erro: 'Proposta não encontrada.' });
      }
      const ex = (await admin('GET', '/admin/p/exemplo')).json;
      const uma = await visitante('GET', `/admin/propostas/${DEMO_ID(1)}`);
      assert.equal(uma.status, 200);
      assert.deepEqual(uma.json, ex);
      for (let i = 0; i < 2; i++) {
        const pv = await visitante('GET', '/admin/p/exemplo');
        assert.equal(pv.status, 200);
        assert.deepEqual(pv.json, ex);
      }
      const pr = await visitante('GET', '/admin/p/sofia-e-daniel');
      assert.equal(pr.status, 200, 'prévia do rascunho da demo');
      assert.equal(pr.json.status, 'rascunho');
      const modelo = await visitante('GET', '/admin/modelo');
      assert.equal(modelo.status, 200);
      assert.deepEqual(modelo.json, MODELO_PADRAO);
      const rv = (await visitante('GET', '/admin/resumo')).json;
      assert.deepEqual([rv.abertas, rv.fechadas, rv.perdidas, rv.total_fechado], [6, 9, 3, 46400], 'o resumo do visitante é só o da demo');
      const ra = (await admin('GET', '/admin/resumo')).json;
      assert.deepEqual([ra.abertas, ra.fechadas, ra.total_fechado], [7, 10, 46400 + 4321], 'o do admin soma o que é dele');
      assert.deepEqual((await admin('GET', '/admin/p/exemplo')).json, ex, 'nenhuma abertura contada');
      // GET que não existe continua 404
      for (const c of ['/admin/qualquer-coisa', `/admin/propostas/${ID_FALSO}`, '/admin/p/nao-existe-zzzz']) {
        assert.equal((await visitante('GET', c)).status, 404, c);
      }
    } finally {
      // o banco volta a ter só a demo (a parte 3b conta as linhas)
      await admin('PUT', `/admin/propostas/${fechou.id}/etapa`, { etapa: 'aberta' });
      for (const p of [real, fechou]) await admin('DELETE', `/admin/propostas/${p.id}`);
    }
    assert.equal((await listar()).length, 18);
  });

  await teste('visitante: toda escrita → 403 "Modo visitante: nada é salvo nem publicado.", antes de ler o corpo, e nada muda', async () => {
    const foto = async () => ({ lista: await listar(), modelo: (await admin('GET', '/admin/modelo')).json, resumo: (await admin('GET', '/admin/resumo')).json });
    const antes = await foto();
    const escritas = [
      ['POST', '/admin/propostas', { dados: dadosAna({ cliente: 'Visitante tentou' }), status: 'publicada' }],
      ['PUT', `/admin/propostas/${DEMO_ID(1)}`, { dados: dadosAna({ cliente: 'Trocado' }), status: 'publicada' }],
      ['PUT', `/admin/propostas/${DEMO_ID(15)}`, { status: 'publicada' }],
      ['DELETE', `/admin/propostas/${DEMO_ID(15)}`],
      ['DELETE', `/admin/propostas/${DEMO_ID(1)}`],
      ['POST', `/admin/propostas/${DEMO_ID(1)}/duplicar`],
      ['PUT', `/admin/propostas/${DEMO_ID(11)}/etapa`, { etapa: 'fechada', fechamento: { opcao: 'media', pacote: 'cerimonia', valor: 4000 } }],
      ['PUT', `/admin/propostas/${DEMO_ID(15)}/etapa`, { etapa: 'perdida', motivo: 'x' }],
      ['PUT', '/admin/modelo', { dados: { ...MODELO_PADRAO, validade_dias: 5 } }],
      // método ou rota que não existe também para no 403 (o visitante nunca chega a escrever nada)
      ['PATCH', `/admin/propostas/${DEMO_ID(1)}`, { dados: {} }],
      ['DELETE', '/admin/modelo'],
      ['POST', '/admin/resumo'],
      ['POST', '/admin/qualquer-coisa'],
      ['PUT', `/admin/propostas/${ID_FALSO}`, { dados: dadosAna() }],
    ];
    for (const [m, c, corpo] of escritas) {
      for (const extra of [{ corpo }, { bruto: '{"dados":' }, { bruto: '{"dados":{}}', headers: { 'content-type': 'text/plain' } }, {}]) {
        if (!corpo && extra.corpo === undefined && 'corpo' in extra) continue;
        const r = await visitante(m, c, extra);
        assert.equal(r.status, 403, `${m} ${c} ${JSON.stringify(extra).slice(0, 60)}`);
        assert.deepEqual(r.json, ERRO_VISITANTE);
      }
    }
    assert.deepEqual(await foto(), antes, 'nada mudou');
    // o CORS da resposta 403 deixa o painel ler a mensagem
    const r = await visitante('POST', '/admin/propostas', { headers: { origin: ORIGENS[0] } });
    assert.equal(r.status, 403);
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGENS[0]);
  });

  await teste('DEMO=1: o admin grava (cria uma proposta e mexe na demo); o visitante não vê a proposta do admin', async () => {
    const foto = async () => JSON.stringify(await listar());
    const antes = await foto();
    assert.equal((await visitante('GET', '/admin/propostas')).json.length, 18);
    for (const [m, c, corpo] of [['POST', '/admin/propostas', { dados: dadosAna(), status: 'publicada' }],
      ['PUT', `/admin/propostas/${DEMO_ID(11)}/etapa`, { etapa: 'perdida' }], ['DELETE', `/admin/propostas/${DEMO_ID(12)}`],
      ['PUT', `/admin/propostas/${DEMO_ID(2)}`, { dados: dadosAna() }], ['PUT', '/admin/modelo', { dados: MODELO_PADRAO }]]) {
      const r = await visitante(m, c, { corpo });
      assert.equal(r.status, 403, `${m} ${c}`);
      assert.deepEqual(r.json, ERRO_VISITANTE);
    }
    assert.equal(await foto(), antes, 'nada mudou');
    // o admin cria uma proposta dele, edita a 02 e apaga a 12 (que a regravação vai devolver)
    const criada = await admin('POST', '/admin/propostas', { dados: dadosAna({ cliente: 'Casal do Admin' }), status: 'publicada' });
    assert.equal(criada.status, 201);
    const d2 = (await admin('GET', `/admin/propostas/${DEMO_ID(2)}`)).json;
    assert.equal((await admin('PUT', `/admin/propostas/${DEMO_ID(2)}`, { dados: { ...d2.dados, local: 'Local mudado' } })).status, 200);
    assert.equal((await admin('DELETE', `/admin/propostas/${DEMO_ID(12)}`)).status, 200);
    const lista = await listar();
    assert.equal(lista.length, 18, '17 da demo + a do admin');
    assert.equal(lista.find(p => p.id === DEMO_ID(2)).dados.local, 'Local mudado');
    // o visitante: as 17 da demo (com a edição do admin numa linha da demo), sem a proposta do admin
    const doVisitante = (await visitante('GET', '/admin/propostas')).json;
    assert.deepEqual(doVisitante, lista.filter(doDemo));
    assert.equal(doVisitante.length, 17);
    assert.equal((await visitante('GET', `/admin/propostas/${criada.json.id}`)).status, 404);
    // a proposta do admin conta abertura normalmente (só as linhas da demo não contam)
    assert.equal((await api('GET', `/p/${criada.json.slug}`)).status, 200);
    estado.meu = (await admin('GET', `/admin/propostas/${criada.json.id}`)).json;
    assert.equal(estado.meu.views, 1);
  });

  await teste('DEMO=1: contatos — visitante lê só os 12 de exemplo, escrita → 403; o admin grava, edita e apaga contato da demo', async () => {
    const CT = nn => `00000000-0000-4000-8000-0000000001${String(nn).padStart(2, '0')}`;
    const porId = l => [...l].sort((a, b) => a.id.localeCompare(b.id));
    const lv = await visitante('GET', '/admin/contatos');
    assert.equal(lv.status, 200);
    assert.deepEqual(porId(lv.json), porId(demo.gerarContatosDemo(hoje0)));
    // o contato ligado à proposta 12 não existe; os ligados às propostas que o admin mexeu continuam ligados
    assert.ok(lv.json.filter(x => x.proposta_id).every(x => x.proposta_id.startsWith(demo.DEMO_PREFIXO)));
    // escrita do visitante → 403, antes de ler o corpo, e nada muda
    const antes = JSON.stringify((await admin('GET', '/admin/contatos')).json);
    for (const [m, c, corpo] of [['POST', '/admin/contatos', { nome: 'Visitante' }], ['PUT', `/admin/contatos/${CT(1)}`, { nome: 'Trocado' }],
      ['DELETE', `/admin/contatos/${CT(1)}`], ['PATCH', `/admin/contatos/${CT(1)}`], ['PUT', `/admin/contatos/${ID_FALSO}`, { nome: 'X' }]]) {
      for (const extra of [{ corpo }, { bruto: '{"nome":' }]) {
        const r = await visitante(m, c, extra);
        assert.equal(r.status, 403, `${m} ${c}`);
        assert.deepEqual(r.json, ERRO_VISITANTE);
      }
    }
    assert.equal(JSON.stringify((await admin('GET', '/admin/contatos')).json), antes, 'nada mudou');
    // o admin: cria um contato dele (ligado à proposta dele), edita o 02 e apaga o 03 da demo
    const meu = await admin('POST', '/admin/contatos', { nome: 'Contato do Admin', whatsapp: '(11) 97777-6666', origem: 'outro', obs: 'nota privada', proposta_id: estado.meu.id });
    assert.equal(meu.status, 201);
    assert.equal(meu.json.proposta_id, estado.meu.id);
    assert.equal((await admin('PUT', `/admin/contatos/${CT(2)}`, { nome: 'Beatriz & Thiago', obs: 'Mudado pelo admin' })).status, 200);
    assert.equal((await admin('DELETE', `/admin/contatos/${CT(3)}`)).status, 200);
    assert.equal((await admin('GET', '/admin/contatos')).json.length, 12, '11 da demo + o do admin');
    const depois = await visitante('GET', '/admin/contatos');
    assert.equal(depois.json.length, 11);
    for (const segredo of ['Contato do Admin', 'nota privada', '11977776666']) assert.ok(!depois.texto.includes(segredo), segredo);
    assert.equal(depois.json.find(x => x.id === CT(2)).obs, 'Mudado pelo admin');
    estado.meuContato = meu.json;
  });
  return estado;
}

// 3b: mesmo banco, com a data da demo vencida (gravada com o servidor parado): o próximo GET regrava só
// as linhas da demo, num batch de verdade, e a proposta do admin fica como estava.
async function parte3b({ token, meu, meuContato }) {
  const api = clienteHttp((caminho, init) => fetch(BASE + caminho, init));
  const demo = await import(pathToFileURL(path.join(RAIZ, 'src', 'demo.js')).href);

  await teste('DEMO=1: com a demo vencida, o próximo GET regrava só as linhas da demo; a proposta do admin fica', async () => {
    assert.ok(meu, 'a parte 3a criou a proposta do admin');
    const lista = (await api('GET', '/admin/propostas', { token })).json;
    assert.equal(lista.length, 19, '18 da demo + a do admin');
    conferirNoPainel(lista.filter(p => p.id !== meu.id), demo.gerarDemo(hojeBr()));
    assert.deepEqual(lista.find(p => p.id === meu.id), meu, 'a proposta do admin ficou intacta');
    assert.equal(lista.find(p => p.id === DEMO_ID(2)).dados.local, 'Igreja Matriz · Niterói', 'a 02 voltou ao original');
    assert.ok(lista.some(p => p.id === DEMO_ID(12)), 'a 12 voltou');
    // regravou uma vez só (e abrir o exemplo continua sem contar)
    assert.equal((await api('GET', '/p/exemplo')).status, 200);
    assert.equal((await api('GET', '/admin/p/exemplo', { token })).json.views, 4);
    assert.equal((await api('GET', '/admin/propostas', { token })).json.length, 19);
  });

  await teste('DEMO=1: a regravação devolve os 12 contatos de exemplo (o 02 volta, o 03 volta); o contato do admin fica', async () => {
    assert.ok(meuContato, 'a parte 3a criou o contato do admin');
    const lista = (await api('GET', '/admin/contatos', { token })).json;
    assert.equal(lista.length, 13, '12 da demo + o do admin');
    const porId = l => [...l].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(porId(lista.filter(x => x.id !== meuContato.id)), porId(demo.gerarContatosDemo(hojeBr())));
    assert.deepEqual(lista.find(x => x.id === meuContato.id), meuContato, 'o contato do admin ficou intacto');
  });
}

// ======================================================================================

async function portaLivre() {
  for (let i = 0; i < 25 && await portaOcupada(PORTA); i++) await dormir(200);
  return !(await portaOcupada(PORTA));
}

function falhaGeral(nome, e) {
  falhas.push(nome);
  console.log(`  FALHOU  ${nome}\n          ${String((e && e.stack) || e).split('\n').join('\n          ')}`);
}

function bancoNovo(persist) {
  fs.rmSync(persist, { recursive: true, force: true });
  fs.mkdirSync(persist, { recursive: true });
  aplicarSchema(persist);
}

async function principal() {
  let segredos = null;
  console.log('Parte 1 — Worker de verdade (wrangler dev --local --var DEMO:0, banco novo)');
  console.log(`  porta ${PORTA} · banco em ${PERSIST}`);
  try {
    if (!fs.existsSync(WRANGLER)) throw new Error(`Não achei o wrangler em ${WRANGLER} (defina WRANGLER_JS).`);
    if (WIN && Math.max(PERSIST.length, PERSIST_DEMO.length) + 109 > 259) {
      throw new Error(`A pasta temporária é longa demais para o banco local no Windows (${PERSIST_DEMO.length} caracteres, máximo 150). Use CRM_TEST_TMP com um caminho mais curto.`);
    }
    segredos = lerSegredos();
    await liberarPorta(PORTA);
    bancoNovo(PERSIST);
    const srv = subirServidor(PERSIST, ['--var', 'DEMO:0']);
    await esperarServidor(srv);
    await parte1(segredos);
  } catch (e) {
    falhaGeral('parte 1 interrompida', e);
  } finally {
    encerrarServidor();
  }
  await teste('servidor de teste encerrado e porta liberada', async () => assert.equal(await portaLivre(), true));

  console.log('\nParte 2 — mesmo código dentro do Node, com relógio simulado');
  try {
    await parte2();
  } catch (e) {
    falhaGeral('parte 2 interrompida', e);
  }

  console.log('\nParte 3 — Worker de verdade com a demo ligada (DEMO = "1" do wrangler.toml), banco novo');
  console.log(`  porta ${PORTA} · banco em ${PERSIST_DEMO}`);
  if (!segredos) {
    falhaGeral('parte 3 não rodou', new Error('sem os segredos de teste (.dev.vars)'));
  } else {
    try {
      await liberarPorta(PORTA);
      bancoNovo(PERSIST_DEMO);
      let srv = subirServidor(PERSIST_DEMO);
      await esperarServidor(srv);
      const estado = await parte3a(segredos);
      // vence a demo com o servidor parado (o banco local é um arquivo só) e sobe de novo
      encerrarServidor();
      if (!(await portaLivre())) throw new Error(`A porta ${PORTA} não liberou para reiniciar o servidor.`);
      d1Local(PERSIST_DEMO, `--command=UPDATE demo_meta SET semeado_em = '2000-01-01' WHERE id = 1`);
      srv = subirServidor(PERSIST_DEMO);
      await esperarServidor(srv);
      await parte3b(estado);
    } catch (e) {
      falhaGeral('parte 3 interrompida', e);
    } finally {
      encerrarServidor();
    }
    await teste('servidor da parte 3 encerrado e porta liberada', async () => assert.equal(await portaLivre(), true));
  }

  console.log(`\n${passou} ok, ${falhas.length} com falha`);
  for (const f of falhas) console.log(`  - ${f}`);
  process.exit(falhas.length ? 1 : 0);
}

principal();
