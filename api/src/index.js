// API do painel de propostas para prestadores de serviço (base RK, base do CRM) — Cloudflare Worker + D1.
//
// Público:   GET  /p/:slug                 proposta publicada (conta uma abertura; na demonstração, as
//                                          linhas de exemplo não contam)
// Login:     POST /login {senha}           devolve {token, exp, papel}
//                                          "visitante" (sem diferenciar maiúsculas e espaços) → sessão de
//                                          visitante, 7 dias, só leitura e SÓ com DEMO = "1"; a senha do
//                                          músico → admin, 30 dias
// Painel:    (Authorization: Bearer <token>) — o visitante só faz GET (qualquer outro método → 403) e só
//            enxerga as linhas da demonstração (o que o administrador cria nunca aparece para ele)
//            GET    /admin/propostas
//            POST   /admin/propostas                 nova (a partir do modelo)
//            GET    /admin/propostas/:id
//            PUT    /admin/propostas/:id             {dados, status} — nunca mexe na etapa
//            DELETE /admin/propostas/:id
//            POST   /admin/propostas/:id/duplicar
//            PUT    /admin/propostas/:id/etapa       fechou / não fechou / reabrir
//            GET    /admin/p/:slug                   prévia (rascunho incluso, não conta abertura)
//            GET    /admin/modelo · PUT /admin/modelo {dados}
//            GET    /admin/resumo                    números do topo do painel
//            GET    /admin/contatos · POST /admin/contatos · PUT/DELETE /admin/contatos/:id   (quem pediu preço)
//
// A senha do painel é o secret ADMIN_SENHA (definido pelo João com `wrangler secret put`).
// O token é base64url({exp, papel}) + "." + HMAC. Admin: chave derivada da própria senha (PBKDF2): trocar
// a senha derruba as sessões, e um token vazado não vira atalho para testar senhas offline. Visitante:
// chave derivada do secret SESSAO_CHAVE. Cada papel tem a sua chave, então um token de visitante não vira
// token de admin trocando o papel no corpo.
//
// O modo visitante só existe na demonstração pública (DEMO = "1" e SESSAO_CHAVE gravada). A palavra
// "visitante" é pública (está escrita na tela de login): numa cópia para um músico de verdade (sem DEMO),
// ela responde 503 e nenhum token de visitante vale, mesmo que alguém grave a SESSAO_CHAVE. E, mesmo na
// demonstração, o visitante só lê as linhas de exemplo (ids com DEMO_PREFIXO): rascunhos, valores e
// observações do que o administrador criar ali nunca saem para ele.
//
// Com DEMO = "1" (a demonstração pública), os dados fictícios de src/demo.js se regravam sozinhos quando
// passam de 6 dias, antes de qualquer GET de proposta ou do painel (ver garantirDemo).

import { gerarDemo, gerarContatosDemo, COLUNAS, COLUNAS_CONTATO, DEMO_PREFIXO } from './demo.js';

const SESSAO_SEG = 30 * 24 * 3600;
const SESSAO_VISITANTE_SEG = 7 * 24 * 3600;
const DEMO_DIAS = 6;             // dados da demo com mais de 6 dias são gravados de novo
// sal da derivação da chave de cada papel (PBKDF2)
const SAIS = { admin: 'rk-painel-sessao', visitante: 'rk-painel-visitante' };
const ERRO_SESSAO = 'Sessão expirada. Entre de novo.';
const MAX_FALHAS = 8;            // tentativas erradas por IP (IPv6: por bloco /64)...
const JANELA_FALHAS = 15 * 60;   // ...a cada 15 minutos
const MAX_CORPO = 200 * 1024;
const MAX_CENTAVOS = 9_999_999_999;   // teto de qualquer preço: R$ 99.999.999,99
// Iterações do PBKDF2 da chave de sessão: ~3 ms, uma vez por isolate (o plano grátis dá 10 ms de CPU
// por requisição; 100 mil iterações levariam ~30 ms e derrubariam a primeira chamada após cada cold start).
const PBKDF2_ITERACOES = 10_000;

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req.headers.get('origin') || '', env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await rotear(req, env, new URL(req.url));
    } catch (e) {
      res = e instanceof ErroHttp ? json({ erro: e.message }, e.status) : json({ erro: 'Erro interno' }, 500);
      if (!(e instanceof ErroHttp)) console.error(e && e.stack || e);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

class ErroHttp extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function rotear(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  let r;

  if (m === 'GET' && (r = p.match(/^\/p\/([a-z0-9-]{3,80})$/))) {
    await garantirDemo(env);
    return propostaPublica(env, r[1]);
  }
  if (m === 'POST' && p === '/login') return login(req, env);
  if (m === 'GET' && p === '/') return json({ ok: true, servico: 'painel de propostas RK' });

  if (p.startsWith('/admin/')) {
    const papel = await exigirSessao(req, env);
    // o visitante só lê: qualquer escrita para aqui, antes de ler o corpo
    if (papel === 'visitante' && m !== 'GET') throw new ErroHttp(403, 'Modo visitante: nada é salvo nem publicado.');
    // e só enxerga as linhas da demonstração (nunca o que o administrador criou)
    const soDemo = papel === 'visitante';
    if (m === 'GET') await garantirDemo(env);
    if (m === 'GET' && p === '/admin/propostas') return listar(env, soDemo);
    if (m === 'POST' && p === '/admin/propostas') return criar(req, env);
    if ((r = p.match(/^\/admin\/propostas\/([a-f0-9-]{36})$/))) {
      if (m === 'GET') return json(await buscarPorId(env, r[1], soDemo));
      if (m === 'PUT') return atualizar(req, env, r[1]);
      if (m === 'DELETE') return excluir(env, r[1]);
    }
    if (m === 'POST' && (r = p.match(/^\/admin\/propostas\/([a-f0-9-]{36})\/duplicar$/))) return duplicar(env, r[1]);
    if (m === 'PUT' && (r = p.match(/^\/admin\/propostas\/([a-f0-9-]{36})\/etapa$/))) return mudarEtapa(req, env, r[1]);
    if (m === 'GET' && (r = p.match(/^\/admin\/p\/([a-z0-9-]{3,80})$/))) return previa(env, r[1], soDemo);
    if (p === '/admin/modelo') {
      if (m === 'GET') return json(await lerModelo(env));
      if (m === 'PUT') return salvarModelo(req, env);
    }
    if (m === 'GET' && p === '/admin/resumo') return resumo(env, soDemo);
    if (p === '/admin/contatos') {
      if (m === 'GET') return listarContatos(env, soDemo);
      if (m === 'POST') return salvarContato(req, env, null);
    }
    if ((r = p.match(/^\/admin\/contatos\/([a-f0-9-]{36})$/))) {
      if (m === 'PUT') return salvarContato(req, env, r[1]);
      if (m === 'DELETE') return excluirContato(env, r[1]);
    }
  }
  throw new ErroHttp(404, 'Não encontrado.');
}

// ---------- público ----------

// Só o conteúdo da proposta sai daqui: etapa, fechamento e valor fechado são do painel.
// Na demonstração (DEMO = "1"), abrir uma linha de exemplo não conta abertura: o link "exemplo" vai para
// muitos músicos e, contando, todo visitante veria "Aberta N vezes · última hoje" crescendo nos cartões.
async function propostaPublica(env, slug) {
  const row = await env.DB.prepare(`SELECT id, slug, dados FROM propostas WHERE slug = ? AND status = 'publicada'`).bind(slug).first();
  if (!row) throw new ErroHttp(404, 'Proposta não encontrada.');
  if (!(env.DEMO === '1' && row.id.startsWith(DEMO_PREFIXO))) {
    const agora = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE propostas SET views = views + 1, primeira_vista = COALESCE(primeira_vista, ?1), ultima_vista = ?1 WHERE id = ?2`
    ).bind(agora, row.id).run();
  }
  const dados = JSON.parse(row.dados);
  delete dados._publicada_alguma_vez;
  return json({ slug: row.slug, dados });
}

// ---------- demonstração (DEMO = "1") ----------

// Regrava os dados fictícios quando nunca foram gravados ou têm mais de DEMO_DIAS dias (data de Brasília).
// Um batch só (atômico): apaga as linhas da demo, regrava as 18 propostas e os 12 contatos e anota o dia. Só
// mexe nas linhas cujo id começa com DEMO_PREFIXO; as propostas e os contatos criados no painel ficam. Duas requisições ao mesmo tempo gravam
// a mesma coisa, então o resultado é o mesmo (idempotente).
async function garantirDemo(env) {
  if (env.DEMO !== '1') return;
  const dia = hoje();
  const row = await env.DB.prepare(`SELECT semeado_em FROM demo_meta WHERE id = 1`).first();
  const idade = row && DATA(row.semeado_em) ? diasEntre(row.semeado_em, dia) : NaN;
  if (idade >= 0 && idade <= DEMO_DIAS) return;
  const inserir = `INSERT OR REPLACE INTO propostas (${COLUNAS.join(', ')}) VALUES (${COLUNAS.map(() => '?').join(', ')})`;
  const inserirContato = `INSERT OR REPLACE INTO contatos (${COLUNAS_CONTATO.join(', ')}) VALUES (${COLUNAS_CONTATO.map(() => '?').join(', ')})`;
  const linhas = gerarDemo(dia);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM propostas WHERE id LIKE ?`).bind(`${DEMO_PREFIXO}%`),
    ...linhas.map(l => env.DB.prepare(inserir).bind(...COLUNAS.map(c => l[c]))),
    env.DB.prepare(`DELETE FROM contatos WHERE id LIKE ?`).bind(`${DEMO_PREFIXO}%`),
    ...gerarContatosDemo(dia, linhas).map(l => env.DB.prepare(inserirContato).bind(...COLUNAS_CONTATO.map(c => l[c]))),
    env.DB.prepare(`INSERT OR REPLACE INTO demo_meta (id, semeado_em) VALUES (1, ?)`).bind(dia),
  ]);
}

function diasEntre(de, ate) {
  return Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000);
}

// ---------- login ----------

async function login(req, env) {
  // O corpo vem antes da contagem: JSON inválido (400), corpo grande (413) ou fora de JSON (415) não contam.
  const corpo = await lerJson(req, true);
  const senha = typeof corpo.senha === 'string' ? corpo.senha : '';

  // "visitante" é público (está escrito na tela de login): não passa pelo limite de tentativas, não grava
  // nada e entra só para ler. Só existe na demonstração (DEMO = "1") e com o secret SESSAO_CHAVE: fora
  // disso (a cópia de um músico de verdade) responde 503, mesmo que alguém grave a SESSAO_CHAVE lá.
  if (senha.trim().toLowerCase() === 'visitante') {
    if (env.DEMO !== '1' || !env.SESSAO_CHAVE) throw new ErroHttp(503, 'O modo visitante está desligado.');
    return json(await emitirSessao(env, 'visitante', SESSAO_VISITANTE_SEG));
  }

  if (!env.ADMIN_SENHA) throw new ErroHttp(503, 'A senha do painel ainda não foi configurada.');
  const ip = chaveIp(req.headers.get('cf-connecting-ip') || 'local');
  const agora = Math.floor(Date.now() / 1000);
  // A tentativa é registrada ANTES de conferir a senha, numa instrução só (atômica no SQLite): ela só
  // entra se ainda houver vaga na janela. Contar primeiro e gravar depois deixava uma rajada em
  // paralelo ler o mesmo "7 falhas" e passar toda do limite. Tentativa bloqueada não é gravada.
  const vaga = await env.DB.prepare(
    `INSERT INTO login_falhas (ip, ts) SELECT ?1, ?2
       WHERE (SELECT COUNT(*) FROM login_falhas WHERE ip = ?1 AND ts > ?3) < ?4
       RETURNING ts`
  ).bind(ip, agora, agora - JANELA_FALHAS, MAX_FALHAS).first();
  if (!vaga) throw new ErroHttp(429, 'Muitas tentativas. Espere 15 minutos e tente de novo.');

  if (!(await iguais(senha, env.ADMIN_SENHA))) {
    await env.DB.prepare(`DELETE FROM login_falhas WHERE ts < ?`).bind(agora - JANELA_FALHAS).run();   // faxina
    throw new ErroHttp(401, 'Senha incorreta.');
  }
  await env.DB.prepare(`DELETE FROM login_falhas WHERE ip = ?`).bind(ip).run();
  return json(await emitirSessao(env, 'admin', SESSAO_SEG));
}

// segredo que assina as sessões de cada papel (papel desconhecido → nenhum). Fora da demonstração não
// há segredo de visitante: nenhum token de visitante vale, nem bem assinado com uma SESSAO_CHAVE gravada.
function segredoDo(env, papel) {
  if (papel === 'admin') return env.ADMIN_SENHA || '';
  if (papel === 'visitante') return env.DEMO === '1' ? (env.SESSAO_CHAVE || '') : '';
  return '';
}

async function emitirSessao(env, papel, segundos) {
  const exp = Math.floor(Date.now() / 1000) + segundos;
  const corpoToken = b64url(new TextEncoder().encode(JSON.stringify({ exp, papel })));
  return { token: `${corpoToken}.${await assinar(papel, segredoDo(env, papel), corpoToken)}`, exp, papel };
}

// Chave do rate-limit. IPv4 inteiro; IPv6 pelo bloco /64, porque o provedor entrega um /64 (ou mais)
// a cada assinante e cada endereço do bloco ganharia 8 tentativas novas sem proxy nem VPN.
function chaveIp(ip) {
  if (!ip.includes(':') || ip.includes('.')) return ip;   // IPv4 (ou IPv4 mapeado em IPv6)
  const [esq, dir = ''] = ip.split('::');
  const a = esq ? esq.split(':') : [], b = dir ? dir.split(':') : [];
  const grupos = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  return `${grupos.slice(0, 4).map(g => g.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

// Devolve o papel da sessão ('admin' ou 'visitante'). O papel vem do corpo do token, mas só vale se a
// assinatura bater com a chave DESSE papel: {papel:'admin'} assinado com a chave do visitante não passa.
async function exigirSessao(req, env) {
  const h = req.headers.get('authorization') || '';
  const partes = (h.startsWith('Bearer ') ? h.slice(7) : '').split('.');
  const [corpo, sig] = partes;
  if (partes.length !== 2 || !corpo || !sig) throw new ErroHttp(401, ERRO_SESSAO);
  let dados = null;
  try { dados = JSON.parse(new TextDecoder().decode(b64urlDecode(corpo))); } catch { /* token inválido */ }
  const papel = dados && typeof dados === 'object' ? dados.papel : undefined;
  const segredo = segredoDo(env, papel);
  if (!segredo) throw new ErroHttp(401, ERRO_SESSAO);
  if (!(await iguais(sig, await assinar(papel, segredo, corpo)))) throw new ErroHttp(401, ERRO_SESSAO);
  if (!(typeof dados.exp === 'number' && dados.exp > Date.now() / 1000)) throw new ErroHttp(401, ERRO_SESSAO);
  return papel;
}

// A chave do HMAC é derivada do segredo com PBKDF2 (não é a senha crua): quem obtiver um token válido
// tem mensagem e MAC, e com a senha crua como chave testaria senhas offline a milhões por segundo.
// Cada papel usa um sal próprio. A derivação roda uma vez por isolate e fica em cache (por papel e
// segredo, para a troca de senha ou de chave valer na hora).
const chavesSessao = new Map();
function chaveSessao(papel, segredo) {
  const id = `${papel}\u0000${segredo}`;
  let chave = chavesSessao.get(id);
  if (!chave) {
    const enc = new TextEncoder();
    chave = crypto.subtle.importKey('raw', enc.encode(segredo), 'PBKDF2', false, ['deriveKey']).then(base =>
      crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SAIS[papel]), iterations: PBKDF2_ITERACOES },
        base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']));
    chavesSessao.set(id, chave);
    chave.catch(() => chavesSessao.delete(id));
  }
  return chave;
}

async function assinar(papel, segredo, msg) {
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await chaveSessao(papel, segredo), new TextEncoder().encode(msg))));
}

// compara em tempo constante (hash dos dois lados, tamanhos iguais)
async function iguais(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// ---------- painel: propostas ----------

// `soDemo` (o visitante): só as linhas da demonstração, cujo id começa com DEMO_PREFIXO
const SO_DEMO = `id LIKE '${DEMO_PREFIXO}%'`;

async function listar(env, soDemo = false) {
  const { results } = await env.DB.prepare(`SELECT * FROM propostas ${soDemo ? `WHERE ${SO_DEMO}` : ''} ORDER BY atualizado_em DESC`).all();
  return json(results.map(formatar));
}

async function buscarPorId(env, id, soDemo = false) {
  const row = await env.DB.prepare(`SELECT * FROM propostas WHERE id = ? ${soDemo ? `AND ${SO_DEMO}` : ''}`).bind(id).first();
  if (!row) throw new ErroHttp(404, 'Proposta não encontrada.');
  return formatar(row);
}

async function previa(env, slug, soDemo = false) {
  const row = await env.DB.prepare(`SELECT * FROM propostas WHERE slug = ? ${soDemo ? `AND ${SO_DEMO}` : ''}`).bind(slug).first();
  if (!row) throw new ErroHttp(404, 'Proposta não encontrada.');
  return json(formatar(row));
}

// O painel manda a proposta já preenchida (e publicada) no primeiro "salvar";
// sem corpo, cria um rascunho a partir do modelo.
async function criar(req, env) {
  const corpo = await lerJson(req);
  const modelo = await lerModelo(env);
  const dados = limpar(corpo.dados == null ? modelo : corpo.dados);
  if (!dados.validade) dados.validade = somarDias(hoje(), modelo.validade_dias);
  const status = corpo.status === 'publicada' ? 'publicada' : 'rascunho';
  if (status === 'publicada') {
    validarPublicacao(dados);
    dados._publicada_alguma_vez = true;
  }
  return json(await inserir(env, dados, status), 201);
}

// A cópia nasce como proposta nova: rascunho, em aberto, sem fechamento e com validade nova.
async function duplicar(env, id) {
  const orig = await buscarPorId(env, id);
  const modelo = await lerModelo(env);
  const cliente = orig.dados.cliente ? `${TXT(orig.dados.cliente, 112)} (cópia)` : '';
  const dados = limpar({ ...orig.dados, cliente });
  dados.validade = somarDias(hoje(), modelo.validade_dias);
  return json(await inserir(env, dados, 'rascunho'), 201);
}

async function inserir(env, dados, status) {
  const id = crypto.randomUUID();
  const agora = new Date().toISOString();
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const slug = gerarSlug(dados.cliente);
    try {
      await env.DB.prepare(
        `INSERT INTO propostas (id, slug, status, cliente, data_evento, dados, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, slug, status, dados.cliente, dados.data || null, JSON.stringify(dados), agora, agora).run();
      return buscarPorId(env, id);
    } catch (e) {
      if (!String(e).includes('UNIQUE')) throw e;
    }
  }
  throw new ErroHttp(500, 'Não consegui gerar um link único. Tente de novo.');
}

// Mexe só em dados, status e link. Etapa e fechamento têm rota própria (mudarEtapa).
async function atualizar(req, env, id) {
  const atual = await buscarPorId(env, id);
  const corpo = await lerJson(req);
  const dados = limpar(corpo.dados == null ? atual.dados : corpo.dados);
  const status = ['rascunho', 'publicada'].includes(corpo.status) ? corpo.status : atual.status;
  if (status === 'publicada') validarPublicacao(dados);
  // O link acompanha o nome do cliente só enquanto ninguém pode tê-lo recebido:
  // rascunho que nunca foi publicado nem aberto. Depois disso o link fica fixo.
  let slug = atual.slug;
  const linkLivre = atual.status === 'rascunho' && !atual.views && !atual.publicada_alguma_vez;
  if (linkLivre && dados.cliente !== atual.dados.cliente) slug = await slugLivre(env, dados.cliente, id);
  if (atual.publicada_alguma_vez || status === 'publicada') dados._publicada_alguma_vez = true;
  await env.DB.prepare(
    `UPDATE propostas SET slug = ?, status = ?, cliente = ?, data_evento = ?, dados = ?, atualizado_em = ? WHERE id = ?`
  ).bind(slug, status, dados.cliente, dados.data || null, JSON.stringify(dados), new Date().toISOString(), id).run();
  return json(await buscarPorId(env, id));
}

async function slugLivre(env, cliente, id) {
  for (let i = 0; i < 5; i++) {
    const s = gerarSlug(cliente);
    const ocupado = await env.DB.prepare(`SELECT 1 FROM propostas WHERE slug = ? AND id != ?`).bind(s, id).first();
    if (!ocupado) return s;
  }
  throw new ErroHttp(500, 'Não consegui gerar um link único. Tente de novo.');
}

// Exclusão física. Proposta fechada não se apaga: a venda sumiria do total fechado e das somas do CRM
// sem volta. Reabrir primeiro ("Reabrir" dentro da proposta) é um toque no painel.
async function excluir(env, id) {
  const row = await env.DB.prepare(`SELECT etapa FROM propostas WHERE id = ?`).bind(id).first();
  if (row && row.etapa === 'fechada') throw new ErroHttp(409, 'Essa proposta está fechada. Reabra antes de excluir.');
  // o contato que tinha essa proposta continua, só perde o vínculo
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM propostas WHERE id = ?`).bind(id),
    env.DB.prepare(`UPDATE contatos SET proposta_id = NULL WHERE proposta_id = ?`).bind(id),
  ]);
  return json({ ok: true });
}

// ---------- painel: contatos (quem pediu preço) ----------
// Nome, WhatsApp, de onde veio, data do evento, lembrete de retorno e a proposta feita para ele.
// Telefone de terceiro: só no painel (nunca na página pública), só o necessário, e dá para excluir.
// O visitante só lê os contatos de exemplo (soDemo), como nas propostas.
const ORIGENS_CONTATO = ['instagram', 'portal', 'indicacao', 'google', 'whatsapp', 'outro'];
const SEL_CONTATO = COLUNAS_CONTATO.join(', ');

// WhatsApp do Brasil: só os números, com DDD (10 ou 11 dígitos); o 55 do país sai
function limparWhatsapp(v) {
  let d = (typeof v === 'string' ? v : '').replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (!d) return '';
  if (d.length !== 10 && d.length !== 11) throw new ErroHttp(400, 'WhatsApp inválido: coloque com DDD, só os números.');
  return d;
}

async function limparContato(env, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ErroHttp(400, 'Dados inválidos.');
  const nome = TXT(typeof d.nome === 'string' ? d.nome.trim() : '', 120).trim();
  if (!nome) throw new ErroHttp(400, 'Coloque o nome.');
  let proposta_id = typeof d.proposta_id === 'string' && /^[a-f0-9-]{36}$/.test(d.proposta_id) ? d.proposta_id : null;
  if (proposta_id && !(await env.DB.prepare(`SELECT 1 FROM propostas WHERE id = ?`).bind(proposta_id).first())) proposta_id = null;
  return {
    nome,
    whatsapp: limparWhatsapp(d.whatsapp),
    origem: ORIGENS_CONTATO.includes(d.origem) ? d.origem : '',
    data_evento: DATA(d.data_evento) || null,
    obs: TXT(d.obs, 500),
    lembrete_em: DATA(d.lembrete_em) || null,
    lembrete_txt: TXT(d.lembrete_txt, 140),
    proposta_id,
  };
}

async function listarContatos(env, soDemo = false) {
  const { results } = await env.DB.prepare(`SELECT ${SEL_CONTATO} FROM contatos ${soDemo ? `WHERE ${SO_DEMO}` : ''} ORDER BY criado_em DESC`).all();
  return json(results);
}

async function salvarContato(req, env, id) {
  const c = await limparContato(env, await lerJson(req));
  const agora = new Date().toISOString(), novo = !id;
  if (novo) {
    id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO contatos (${SEL_CONTATO}) VALUES (${COLUNAS_CONTATO.map(() => '?').join(', ')})`)
      .bind(id, c.nome, c.whatsapp, c.origem, c.data_evento, c.obs, c.lembrete_em, c.lembrete_txt, c.proposta_id, agora, agora).run();
  } else {
    const r = await env.DB.prepare(
      `UPDATE contatos SET nome = ?, whatsapp = ?, origem = ?, data_evento = ?, obs = ?, lembrete_em = ?, lembrete_txt = ?, proposta_id = ?, atualizado_em = ? WHERE id = ?`
    ).bind(c.nome, c.whatsapp, c.origem, c.data_evento, c.obs, c.lembrete_em, c.lembrete_txt, c.proposta_id, agora, id).run();
    if (!r.meta || !r.meta.changes) throw new ErroHttp(404, 'Contato não encontrado.');
  }
  return json(await env.DB.prepare(`SELECT ${SEL_CONTATO} FROM contatos WHERE id = ?`).bind(id).first(), novo ? 201 : 200);
}

async function excluirContato(env, id) {
  await env.DB.prepare(`DELETE FROM contatos WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

function formatar(row) {
  const dados = JSON.parse(row.dados);
  const publicada_alguma_vez = !!dados._publicada_alguma_vez || row.status === 'publicada';
  delete dados._publicada_alguma_vez;
  return {
    id: row.id, slug: row.slug, status: row.status, etapa: row.etapa, dados,
    fechamento: row.fechamento ? JSON.parse(row.fechamento) : null,
    valor_fechado: row.valor_fechado, fechado_em: row.fechado_em,
    criado_em: row.criado_em, atualizado_em: row.atualizado_em,
    views: row.views, primeira_vista: row.primeira_vista, ultima_vista: row.ultima_vista,
    publicada_alguma_vez,
  };
}

// ---------- painel: fechamento (semente do CRM) ----------

// {etapa:'fechada', fechamento:{opcao, pacote, valor, data, obs, adicionais?:[{nome, valor}], pagamentos?:[{tipo, valor, vence_em, pago_em}]}} · {etapa:'perdida', motivo} · {etapa:'aberta'}
async function mudarEtapa(req, env, id) {
  await buscarPorId(env, id);
  const corpo = await lerJson(req);
  let fechamento = null, valor = null, em = null;
  if (corpo.etapa === 'fechada') {
    const f = OBJ(corpo.fechamento);
    const base = NUM(f.valor);   // valor da opção que fechou
    if (!(base > 0)) throw new ErroHttp(400, 'Coloque o valor fechado.');
    // adicionais combinados no fechamento (ex.: trompetes): nome + valor opcional; entram no total fechado
    const adicionais = (Array.isArray(f.adicionais) ? f.adicionais : []).map(a => ({
      nome: TXT(a && typeof a.nome === 'string' ? a.nome.trim() : '', 120).trim(),
      valor: NUM(a && a.valor),
    })).filter(a => a.nome || a.valor !== null).slice(0, 10);
    if (adicionais.some(a => !a.nome)) throw new ErroHttp(400, 'Coloque o nome do adicional.');
    valor = CENT(base + adicionais.reduce((s, a) => s + (a.valor || 0), 0));
    em = DATA(f.data) || hoje();
    fechamento = {
      opcao: [...OPCOES, 'outro'].includes(f.opcao) ? f.opcao : 'outro',
      pacote: PACOTES.includes(f.pacote) ? f.pacote : 'outro',
      valor: base, data: em, obs: TXT(f.obs, 500),
    };
    if (adicionais.length) fechamento.adicionais = adicionais;
    // pagamentos (financeiro): sinal na assinatura e restante antes do evento; cada um com quando vence e quando foi pago
    const pagamentos = (Array.isArray(f.pagamentos) ? f.pagamentos : []).map(x => ({
      tipo: TIPOS_PAGAMENTO.includes(x && x.tipo) ? x.tipo : 'parcela',
      valor: NUM(x && x.valor),
      vence_em: DATA(x && x.vence_em),
      pago_em: DATA(x && x.pago_em),
    })).filter(x => x.valor > 0).slice(0, 24);
    if (pagamentos.length) fechamento.pagamentos = pagamentos;
  } else if (corpo.etapa === 'perdida') {
    em = hoje();
    fechamento = { motivo: TXT(corpo.motivo, 300) };
  } else if (corpo.etapa !== 'aberta') {
    throw new ErroHttp(400, 'Etapa inválida.');
  }
  await env.DB.prepare(
    `UPDATE propostas SET etapa = ?, fechamento = ?, valor_fechado = ?, fechado_em = ?, atualizado_em = ? WHERE id = ?`
  ).bind(corpo.etapa, fechamento && JSON.stringify(fechamento), valor, em, new Date().toISOString(), id).run();
  return json(await buscarPorId(env, id));
}

async function resumo(env, soDemo = false) {
  const mes = hoje().slice(0, 7);
  const t = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(etapa = 'aberta'), 0)  AS abertas,
      COALESCE(SUM(etapa = 'fechada'), 0) AS fechadas,
      COALESCE(SUM(etapa = 'perdida'), 0) AS perdidas,
      COALESCE(SUM(CASE WHEN etapa = 'fechada' THEN valor_fechado END), 0) AS total_fechado,
      COALESCE(SUM(etapa = 'fechada' AND substr(fechado_em, 1, 7) = ?1), 0) AS mes_propostas,
      COALESCE(SUM(CASE WHEN etapa = 'fechada' AND substr(fechado_em, 1, 7) = ?1 THEN valor_fechado END), 0) AS mes_total
    FROM propostas ${soDemo ? `WHERE ${SO_DEMO}` : ''}`).bind(mes).first();
  // fechadas pelo ano do evento; as sem data ("") ficam por último
  const { results } = await env.DB.prepare(`
    SELECT COALESCE(substr(data_evento, 1, 4), '') AS ano, COUNT(*) AS eventos, COALESCE(SUM(valor_fechado), 0) AS total
    FROM propostas WHERE etapa = 'fechada' ${soDemo ? `AND ${SO_DEMO}` : ''} GROUP BY 1`).all();
  return json({
    abertas: t.abertas, fechadas: t.fechadas, perdidas: t.perdidas,
    total_fechado: CENT(t.total_fechado),
    fechado_mes: { mes, propostas: t.mes_propostas, total: CENT(t.mes_total) },
    por_ano_evento: results
      .map(a => ({ ano: a.ano, eventos: a.eventos, total: CENT(a.total) }))
      .sort((a, b) => (a.ano === '') - (b.ano === '') || (a.ano < b.ano ? -1 : 1)),
  });
}

// ---------- painel: modelo ----------

async function lerModelo(env) {
  const row = await env.DB.prepare(`SELECT dados FROM modelo WHERE id = 1`).first();
  return limparModelo(row ? JSON.parse(row.dados) : {});
}

async function salvarModelo(req, env) {
  const corpo = await lerJson(req);
  const dados = limparModelo(corpo.dados);
  await env.DB.prepare(`INSERT OR REPLACE INTO modelo (id, dados, atualizado_em) VALUES (1, ?, ?)`)
    .bind(JSON.stringify(dados), new Date().toISOString()).run();
  return json(dados);
}

// ---------- validação dos dados editáveis ----------

const OPCOES = ['simples', 'media', 'completa'];
const PACOTES = ['cerimonia', 'cerimonia_recepcao', 'outro'];
const TIPOS_PAGAMENTO = ['sinal', 'restante', 'parcela'];
const OBJ = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// corta no limite sem deixar metade de um emoji no fim
const TXT = (v, max) => (typeof v === 'string' ? v : '').slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
// Preço: número ≥ 0 com 2 casas, até o teto; fora disso é null. Arredonda em centavos ANTES de aceitar:
// v * 100 estoura em Infinity para v ≈ 1e307, e Infinity passaria em "> 0" e viraria null só no JSON.
const NUM = v => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const c = Math.round(v * 100);
  return Number.isFinite(c) && c <= MAX_CENTAVOS ? c / 100 : null;
};
const CENT = v => { const c = Math.round((Number(v) || 0) * 100); return Number.isFinite(c) ? c / 100 : 0; };
const DATA = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && dataExiste(v) ? v : '');
const HORA = v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : '');

function dataExiste(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// Rótulos dos dois valores de cada opção (chaves internas: cerimonia = pacote A, cerimonia_recepcao = pacote B).
// Proposta antiga sem rótulos continua lendo "Cerimônia" e "Cerimônia + recepção".
const ROTULOS_PADRAO = { pacote_a: 'Cerimônia', pacote_b: 'Cerimônia + recepção', nota_b: '' };
function limparRotulos(r) {
  r = OBJ(r);
  return {
    pacote_a: TXT(r.pacote_a, 40).trim() || ROTULOS_PADRAO.pacote_a,
    pacote_b: TXT(r.pacote_b, 60).trim() || ROTULOS_PADRAO.pacote_b,
    nota_b: TXT(r.nota_b, 140).trim(),
  };
}

// Devolve só o formato combinado; qualquer campo fora dele é descartado.
function limpar(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new ErroHttp(400, 'Dados inválidos.');
  const secoes = OBJ(d.secoes);
  const opcoes = {};
  // o que cada opção mostra; proposta antiga sem isso herda as chaves globais de antes
  const verRec = d.mostrar_recepcao !== false, verCer = d.mostrar_cerimonia !== false || !verRec;   // nunca os dois escondidos
  for (const k of OPCOES) {
    const o = OBJ(OBJ(d.opcoes)[k]);
    opcoes[k] = {
      on: o.on === true,
      nome: TXT(o.nome, 60),
      clima: TXT(o.clima, 120),
      itens: TXT(o.itens, 600),
      cerimonia: NUM(o.cerimonia),
      cerimonia_recepcao: NUM(o.cerimonia_recepcao),
      ver_cerimonia: typeof o.ver_cerimonia === 'boolean' ? o.ver_cerimonia : verCer,   // mostra o valor só da cerimônia
      ver_recepcao: typeof o.ver_recepcao === 'boolean' ? o.ver_recepcao : verRec,      // mostra o valor cerimônia + recepção
    };
  }
  return {
    cliente: TXT(typeof d.cliente === 'string' ? d.cliente.trim() : '', 120).trim(),
    tipo: TXT(d.tipo, 80),
    rotulos: limparRotulos(d.rotulos),   // como a página chama os dois valores de cada opção
    data: DATA(d.data),
    hora: HORA(d.hora),
    local: TXT(d.local, 200),
    mensagem: TXT(d.mensagem, 2000),
    opcoes,
    ordem: limparOrdem(d.ordem, opcoes),   // a ordem em que o músico apresenta as opções
    // a sugestão só vale se a opção estiver ligada
    sugestao: OPCOES.includes(d.sugestao) && opcoes[d.sugestao].on ? d.sugestao : '',
    inclui: TXT(d.inclui, 600),
    adicionais: (Array.isArray(d.adicionais) ? d.adicionais : []).map(i => ({
      nome: TXT(i && i.nome, 120), descricao: TXT(i && i.descricao, 300), valor: NUM(i && i.valor),
    })).filter(i => i.nome || i.descricao || i.valor !== null).slice(0, 20),
    condicoes: TXT(d.condicoes, 1500),
    validade: DATA(d.validade),
    observacoes: TXT(d.observacoes, 1500),
    secoes: {
      videos: secoes.videos !== false,
      depoimentos: secoes.depoimentos !== false,
    },
  };
}

// Ordem das opções na página: as 3 chaves, cada uma uma vez, na ordem que o músico escolheu.
// Dado antigo: "cara" = a de maior valor à mostra primeiro; qualquer outra coisa = simples → completa.
function limparOrdem(v, opcoes) {
  if (Array.isArray(v)) {
    const ordem = [];
    for (const k of v) if (OPCOES.includes(k) && !ordem.includes(k)) ordem.push(k);
    for (const k of OPCOES) if (!ordem.includes(k)) ordem.push(k);
    return ordem;
  }
  if (v === 'cara') {
    const maior = k => {
      const o = opcoes[k], vs = [];
      if (o.ver_cerimonia && o.cerimonia > 0) vs.push(o.cerimonia);
      if (o.ver_recepcao && o.cerimonia_recepcao > 0) vs.push(o.cerimonia_recepcao);
      return vs.length ? Math.max(...vs) : -1;
    };
    return [...OPCOES].sort((a, b) => (maior(b) - maior(a)) || (OPCOES.indexOf(b) - OPCOES.indexOf(a)));
  }
  return [...OPCOES];
}

// O modelo é uma proposta sem os campos de cada cliente e com o prazo de validade em dias.
function limparModelo(d) {
  const dados = limpar(d);
  for (const k of ['cliente', 'data', 'hora', 'local', 'mensagem', 'validade']) delete dados[k];
  dados.validade_dias = Math.min(365, Math.max(1, Math.round(Number(d.validade_dias) || 30)));
  return dados;
}

// Proposta publicada precisa de nome e de pelo menos uma opção ligada com um valor que apareça na página
// (cada opção escolhe se mostra o valor só da cerimônia, o da cerimônia + recepção, ou os dois).
function validarPublicacao(dados) {
  if (!dados.cliente) throw new ErroHttp(400, 'Coloque o nome do cliente.');
  const comValor = o => o.on && ((o.ver_cerimonia && o.cerimonia > 0) || (o.ver_recepcao && o.cerimonia_recepcao > 0));
  if (!OPCOES.some(k => comValor(dados.opcoes[k]))) {
    throw new ErroHttp(400, 'Marque pelo menos uma opção com valor.');
  }
}

// ---------- utilitários ----------

function gerarSlug(cliente) {
  const base = (cliente || 'proposta').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'proposta';
  const sufixo = Array.from(crypto.getRandomValues(new Uint8Array(4)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
  return `${base}-${sufixo}`;
}

// "hoje" no fuso de Brasília (UTC−3, sem horário de verão)
function hoje() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Corpo sempre é um objeto JSON (ou vazio), declarado como application/json. Sem esse content-type a
// requisição é "simples" (o navegador manda sem pré-voo CORS): qualquer site aberto no celular do músico
// poderia disparar logins errados em nome do IP dele até bloqueá-lo. Exigir JSON obriga o pré-voo,
// que corsHeaders nega a quem não está em ORIGENS.
// `sempreJson` (o login): exige o content-type mesmo sem corpo, porque um POST vazio sem content-type
// também é "simples" e contaria como tentativa. Nas rotas do painel o Bearer já obriga o pré-voo.
async function lerJson(req, sempreJson = false) {
  const tipo = (req.headers.get('content-type') || '').trim().toLowerCase();
  const ehJson = tipo.startsWith('application/json');
  if ((tipo || sempreJson) && !ehJson) throw new ErroHttp(415, 'Envie o conteúdo em JSON.');
  const bytes = await lerCorpo(req);
  if (!bytes.length) return {};
  if (!ehJson) throw new ErroHttp(415, 'Envie o conteúdo em JSON.');
  let corpo;
  try { corpo = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ErroHttp(400, 'JSON inválido.'); }
  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) throw new ErroHttp(400, 'JSON inválido.');
  return corpo;
}

// Lê o corpo aos pedaços e para no limite (em bytes): um corpo de dezenas de MB não chega a ser
// carregado na memória do Worker. O content-length, quando vem, corta antes de ler qualquer byte.
async function lerCorpo(req) {
  if (Number(req.headers.get('content-length')) > MAX_CORPO) throw new ErroHttp(413, 'Conteúdo grande demais.');
  if (!req.body) return new Uint8Array(0);
  const partes = [];
  let total = 0;
  const leitor = req.body.getReader();
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CORPO) {
      leitor.cancel().catch(() => { /* o resto do corpo é descartado */ });
      throw new ErroHttp(413, 'Conteúdo grande demais.');
    }
    partes.push(value);
  }
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) { bytes.set(p, pos); pos += p.byteLength; }
  return bytes;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function corsHeaders(origin, env) {
  const permitidas = String(env.ORIGENS || '').split(',').map(s => s.trim()).filter(Boolean);
  const h = { 'vary': 'Origin' };
  if (permitidas.includes(origin)) {
    h['access-control-allow-origin'] = origin;
    h['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    h['access-control-allow-headers'] = 'content-type, authorization';
    h['access-control-max-age'] = '86400';
  }
  return h;
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
