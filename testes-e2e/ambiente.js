'use strict';
// Ambiente dos testes ponta a ponta do painel de propostas (base RK).
//
// Sobe tudo do zero, só na máquina:
//   1. confere que as portas 8792 (API) e 8126 (site) estão livres (se não estiverem, para e avisa);
//   2. apaga a pasta do banco local e aplica api/schema.sql num D1 local novo
//      (wrangler d1 execute rk-painel-demo --local --persist-to <pasta> --file=schema.sql --yes, dentro de api/);
//   3. sobe a API: wrangler dev --local --ip 127.0.0.1 --port 8792 --persist-to <mesma pasta> (dentro de api/,
//      então o DEMO = "1" do wrangler.toml vale e os dados fictícios se semeiam no primeiro GET);
//   4. sobe o site: python -m http.server 8126 servindo site/ (aberto como http://localhost:8126);
//   5. lê a ADMIN_SENHA de api/.dev.vars sem nunca imprimir (o log do wrangler é gravado com os segredos trocados por ***);
//   6. no fim (ou no Ctrl+C) encerra os dois servidores com taskkill /T /F.
//
// Nada aqui publica nem toca no banco remoto: não há "wrangler deploy", "secret put" nem "--remote".
//
// Variáveis opcionais: RK_E2E_TMP (pasta temporária; o banco fica em <pasta>\p1), WRANGLER_JS (caminho do
// wrangler.js), PYTHON (comando do Python, padrão "python"), PW_JS (pasta do Playwright), VER=1 (abre o Chrome
// na tela em vez de headless).

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const BASE_DIR = path.resolve(__dirname, '..');            // raiz do repositório
const API_DIR = path.join(BASE_DIR, 'api');
const SITE_DIR = path.join(BASE_DIR, 'site');
const PRINTS = path.join(__dirname, 'prints');
const PORTA_API = 8792;
const PORTA_SITE = 8126;
const API = `http://127.0.0.1:${PORTA_API}`;
const SITE = `http://localhost:${PORTA_SITE}`;
const HOST_API_PUBLICADA = 'rk-painel-demo.joao-vitor-kos.workers.dev';
const WA_RK = '5542999246208';

// Pasta curta de propósito: o workerd grava em <pasta>\v3\d1\miniflare-D1DatabaseObject\<64 hex>.sqlite-wal
// (mais ~109 caracteres) e, passando de 259 no Windows, o D1 local responde só "internal error".
const RASCUNHO_PADRAO = path.join(os.tmpdir(), 'rk-demo');
const TMP = path.resolve(process.env.RK_E2E_TMP || (fs.existsSync(RASCUNHO_PADRAO) ? RASCUNHO_PADRAO : path.join(os.tmpdir(), 'rk-e2e')));
const PERSIST = path.join(TMP, 'p1');
const LOGS = path.join(TMP, 'e2e-logs');
const WRANGLER = process.env.WRANGLER_JS
  || path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', 'd77349f55c2be1c0', 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const PLAYWRIGHT = process.env.PW_JS
  || path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', 'e41f203b7505f1fb', 'node_modules', 'playwright');
const PYTHON = process.env.PYTHON || 'python';
const AMBIENTE = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', FORCE_COLOR: '0' };

const dormir = ms => new Promise(r => setTimeout(r, ms));

// ======================================================================================
// Segredos (.dev.vars) — lidos, nunca impressos
// ======================================================================================

let segredos = null;
function lerDevVars() {
  if (segredos) return segredos;
  const arq = path.join(API_DIR, '.dev.vars');
  if (!fs.existsSync(arq)) throw new Error('Falta api/.dev.vars. Rode antes, dentro de api/: node tests/gerar-dev-vars.mjs');
  const texto = fs.readFileSync(arq, 'utf8');
  const valor = nome => {
    const m = texto.match(new RegExp('^\\s*' + nome + '\\s*=\\s*(.+?)\\s*$', 'm'));
    return m ? m[1].replace(/^(["'])(.*)\1$/, '$2') : '';
  };
  segredos = { ADMIN_SENHA: valor('ADMIN_SENHA'), SESSAO_CHAVE: valor('SESSAO_CHAVE') };
  if (!segredos.ADMIN_SENHA) throw new Error('O api/.dev.vars não tem ADMIN_SENHA (rode node tests/gerar-dev-vars.mjs dentro de api/).');
  if (!segredos.SESSAO_CHAVE) console.log('  aviso: o api/.dev.vars não tem SESSAO_CHAVE: o login "visitante" vai responder 503.');
  return segredos;
}
// troca qualquer segredo por *** antes de gravar ou mostrar um texto
function redigir(texto) {
  let t = String(texto == null ? '' : texto);
  if (segredos) for (const v of Object.values(segredos)) if (v && v.length >= 6) t = t.split(v).join('***');
  return t;
}

// ======================================================================================
// Portas e processos
// ======================================================================================

function conecta(host, porta) {
  return new Promise(resolve => {
    const s = net.connect({ host, port: porta });
    s.setTimeout(1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

// PIDs escutando na porta (netstat -ano), em qualquer endereço. Quem escuta tem o endereço remoto
// 0.0.0.0:0 ou [::]:0 (assim não depende do idioma do Windows na coluna de estado).
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

function infoProcesso(pid) {
  if (!WIN) return { nome: '', pai: 0, cmd: '' };
  const comando = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'; if ($p) { $p.Name + '|' + $p.ParentProcessId + '|' + $p.CommandLine }`;
  const saida = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', comando], { encoding: 'utf8' }).stdout || '';
  const [nome = '', pai = '', ...cmd] = saida.trim().split('|');
  return { nome, pai: Number(pai) || 0, cmd: cmd.join('|') };
}

async function portaOcupada(porta) {
  return pidsNaPorta(porta).length > 0 || await conecta('127.0.0.1', porta) || await conecta('::1', porta);
}

// As duas portas precisam estar livres: este roteiro nunca encerra programa dos outros.
async function exigirPortasLivres() {
  const ocupadas = [];
  for (const porta of [PORTA_API, PORTA_SITE]) {
    if (await portaOcupada(porta)) {
      const quem = pidsNaPorta(porta).map(pid => { const p = infoProcesso(pid); return `${p.nome || '?'} (PID ${pid})`; });
      ocupadas.push(`porta ${porta} em uso${quem.length ? ' por ' + quem.join(', ') : ''}`);
    }
  }
  if (ocupadas.length) {
    throw new Error('As portas dos testes não estão livres: ' + ocupadas.join('; ') +
      '.\n  Se for um servidor que sobrou de uma rodada anterior destes testes, encerre com: taskkill /PID <pid> /T /F');
  }
}

function matarArvore(pid) {
  if (!pid) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGTERM'); } catch (e) { /* já encerrou */ } }
}

const filhos = [];   // {nome, filho, log()}
let encerrado = false;
function encerrar() {
  if (encerrado) return;
  encerrado = true;
  for (const f of filhos) matarArvore(f.filho && f.filho.pid);
}
process.on('exit', encerrar);
process.on('SIGINT', () => { encerrar(); process.exit(130); });
process.on('SIGTERM', () => { encerrar(); process.exit(143); });

// Quem escuta na porta precisa ser filho (ou neto) do processo que este roteiro subiu.
function ehNosso(porta, pidFilho) {
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

function subirProcesso(nome, comando, args, opcoes) {
  fs.mkdirSync(LOGS, { recursive: true });
  const arqLog = path.join(LOGS, nome + '.log');
  fs.writeFileSync(arqLog, '');
  const filho = spawn(comando, args, { ...opcoes, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  const junta = b => {
    const t = redigir(b.toString());
    log = (log + t).slice(-8000);
    try { fs.appendFileSync(arqLog, t); } catch (e) { /* log é só ajuda */ }
  };
  filho.stdout.on('data', junta);
  filho.stderr.on('data', junta);
  const reg = { nome, filho, log: () => log, arqLog };
  filhos.push(reg);
  return reg;
}

// ======================================================================================
// Banco local novo + API (wrangler dev) + site (http.server)
// ======================================================================================

function aplicarSchema() {
  if (!fs.existsSync(WRANGLER)) throw new Error(`Não achei o wrangler em ${WRANGLER} (defina WRANGLER_JS).`);
  if (!fs.existsSync(path.join(API_DIR, 'schema.sql'))) throw new Error('Falta api/schema.sql.');
  if (PERSIST.length + 110 > 259) console.log(`  aviso: a pasta do banco tem ${PERSIST.length} caracteres; o D1 local pode falhar (use RK_E2E_TMP mais curta).`);
  fs.rmSync(PERSIST, { recursive: true, force: true });
  fs.mkdirSync(PERSIST, { recursive: true });
  const r = spawnSync(process.execPath,
    [WRANGLER, 'd1', 'execute', 'rk-painel-demo', '--local', '--persist-to', PERSIST, '--file=schema.sql', '--yes'],
    { cwd: API_DIR, encoding: 'utf8', env: AMBIENTE, windowsHide: true });
  if (r.status !== 0) throw new Error('Não consegui aplicar o schema.sql:\n' + redigir((r.stdout || '') + (r.stderr || '')).slice(-3000));
}

async function subirApi() {
  const srv = subirProcesso('wrangler-dev', process.execPath,
    [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORTA_API), '--persist-to', PERSIST, '--var', 'ORIGENS:http://localhost:' + PORTA_SITE],
    { cwd: API_DIR, env: AMBIENTE });
  const limite = Date.now() + 120000;
  while (Date.now() < limite) {
    if (srv.filho.exitCode !== null) throw new Error('O wrangler dev encerrou sozinho:\n' + srv.log());
    try {
      const r = await fetch(`${API}/`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      if (r.ok && j && j.ok) {
        if (!ehNosso(PORTA_API, srv.filho.pid)) throw new Error(`Quem responde na porta ${PORTA_API} não é o wrangler que este roteiro subiu.`);
        return srv;
      }
    } catch (e) {
      if (/não é o wrangler/.test(String(e && e.message))) throw e;   // o resto é só "ainda subindo"
    }
    await dormir(400);
  }
  throw new Error('O wrangler dev não respondeu em 120 s:\n' + srv.log());
}

async function subirSite() {
  if (!fs.existsSync(SITE_DIR)) throw new Error('Falta a pasta site/.');
  const srv = subirProcesso('http-server', PYTHON,
    ['-m', 'http.server', String(PORTA_SITE), '--bind', '127.0.0.1', '--directory', SITE_DIR],
    { cwd: SITE_DIR, env: process.env });
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    if (srv.filho.exitCode !== null) throw new Error('O http.server encerrou sozinho:\n' + srv.log());
    try {
      const r = await fetch(`http://127.0.0.1:${PORTA_SITE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return srv;
    } catch (e) { /* ainda subindo */ }
    await dormir(250);
  }
  throw new Error('O http.server não respondeu em 30 s:\n' + srv.log());
}

// ======================================================================================
// API pelo Node (para conferir o banco por fora do navegador)
// ======================================================================================

// O ProxyWorker do wrangler dev às vezes derruba uma conexão ("Network connection lost"): repete só nesses casos.
async function apiReq(metodo, caminho, { token, corpo } = {}) {
  const h = {};
  if (corpo !== undefined) h['content-type'] = 'application/json';
  if (token) h.authorization = 'Bearer ' + token;
  for (let i = 1; i <= 6; i++) {
    let r, texto;
    try {
      r = await fetch(API + caminho, { method: metodo, headers: h, body: corpo !== undefined ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(15000) });
      texto = await r.text();
    } catch (e) {
      if (i < 6) { await dormir(250); continue; }
      throw new Error(`${metodo} ${caminho}: ${e && e.message}`);
    }
    if ((r.status === 500 && /Network connection lost/i.test(texto)) || (texto === '' && r.status >= 500)) { await dormir(250); continue; }
    let json = null;
    try { json = JSON.parse(texto); } catch (e) { /* não era JSON */ }
    return { status: r.status, json, texto };
  }
  throw new Error(`${metodo} ${caminho}: o proxy local derrubou todas as tentativas`);
}

async function login(senha) {
  const r = await apiReq('POST', '/login', { corpo: { senha } });
  if (r.status !== 200 || !r.json || !r.json.token) throw new Error(`login falhou: ${r.status} ${redigir(r.texto).slice(0, 200)}`);
  return r.json;
}
const loginAdmin = async () => (await login(lerDevVars().ADMIN_SENHA)).token;
const loginVisitante = async () => (await login('visitante')).token;

async function listar(token) {
  const r = await apiReq('GET', '/admin/propostas', { token });
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GET /admin/propostas: ${r.status} ${r.texto.slice(0, 200)}`);
  return r.json.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
async function listarContatos(token) {
  const r = await apiReq('GET', '/admin/contatos', { token });
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GET /admin/contatos: ${r.status} ${r.texto.slice(0, 200)}`);
  return r.json.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// ======================================================================================
// Datas e dados da demonstração (ESPEC §8)
// ======================================================================================

const hojeBr = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);   // Brasília, UTC−3
function maisDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaDaSemana = iso => new Date(`${iso}T12:00:00Z`).getUTCDay();
// sab(n): o primeiro sábado em hoje+n ou depois; para n negativo, o último sábado em hoje+n ou antes
function sab(n, hoje = hojeBr()) {
  let d = maisDias(hoje, n);
  const passo = n < 0 ? -1 : 1;
  while (diaDaSemana(d) !== 6) d = maisDias(d, passo);
  return d;
}
const idDemo = nn => `00000000-0000-4000-8000-0000000000${String(nn).padStart(2, '0')}`;
const fmtNum = v => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v);
const fmtReais = v => 'R$ ' + fmtNum(v);
// texto da tela comparável: sem espaços especiais nem quebras duplicadas
const norm = s => String(s == null ? '' : s).replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();

// ======================================================================================
// Relatório (etapas com ok/falhou/aviso)
// ======================================================================================

class Relatorio {
  constructor(nome) { this.nome = nome; this.ok = 0; this.falhas = []; this.avisos = []; this.n = 0; this.pagina = null; }
  async etapa(titulo, fn, { critica = false } = {}) {
    this.n++;
    try {
      await fn();
      this.ok++;
      console.log(`  ok      ${titulo}`);
    } catch (e) {
      const msg = redigir(String((e && e.message) || e)).split('\n').slice(0, 14).join('\n          ');
      this.falhas.push(`${titulo}: ${msg.split('\n')[0]}`);
      console.log(`  FALHOU  ${titulo}\n          ${msg}`);
      if (this.pagina) {
        try {
          fs.mkdirSync(PRINTS, { recursive: true });
          const arq = path.join(PRINTS, `falha-${this.nome}-${String(this.n).padStart(2, '0')}.png`);
          await this.pagina.screenshot({ path: arq });
          console.log(`          print: ${path.relative(BASE_DIR, arq)}`);
        } catch (e2) { /* sem print */ }
      }
      if (critica) throw new Error(`etapa crítica falhou (${titulo}); o resto do roteiro "${this.nome}" depende dela`);
    }
  }
  aviso(msg) { this.avisos.push(msg); console.log(`  aviso   ${msg}`); }
  resumo() {
    return { nome: this.nome, ok: this.ok, falhas: this.falhas.slice(), avisos: this.avisos.slice() };
  }
}

function verdade(cond, msg) { if (!cond) throw new Error(msg || 'esperava verdadeiro'); }
// JSON com as chaves dos objetos em ordem: a comparação não depende da ordem em que os campos foram gravados
function canonico(v) {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach(k => { o[k] = canonico(v[k]); }); return o; }
  return v;
}
function igual(atual, esperado, msg) {
  const a = JSON.stringify(canonico(atual)), b = JSON.stringify(canonico(esperado));
  if (a !== b) throw new Error(`${msg || 'diferente'}\n  veio:     ${a && a.slice(0, 600)}\n  esperado: ${b && b.slice(0, 600)}`);
}
// o que mudou entre duas listas do banco (GET /admin/propostas): propostas novas, sumidas e campos alterados
function diferencasBanco(antes, depois) {
  const dif = [];
  const nome = p => `${(p.dados && p.dados.cliente) || 'sem nome'} (${p.id})`;
  const ids = new Set([...antes, ...depois].map(p => p.id));
  for (const id of ids) {
    const a = antes.find(p => p.id === id), d = depois.find(p => p.id === id);
    if (!a) { dif.push(`nova: ${nome(d)}`); continue; }
    if (!d) { dif.push(`sumiu: ${nome(a)}`); continue; }
    const campos = [...new Set([...Object.keys(a), ...Object.keys(d)])]
      .filter(k => JSON.stringify(canonico(a[k])) !== JSON.stringify(canonico(d[k])));
    if (campos.length) dif.push(`mudou ${nome(a)}: ${campos.join(', ')}`);
  }
  return dif;
}
function contem(texto, trecho, msg) {
  if (!norm(texto).includes(norm(trecho))) throw new Error(`${msg || 'texto'} não tem "${trecho}"\n  texto: ${norm(texto).slice(0, 500)}`);
}

// ======================================================================================
// Navegador
// ======================================================================================

function playwright() {
  try { return require(PLAYWRIGHT); } catch (e) {
    throw new Error(`Não achei o Playwright em ${PLAYWRIGHT} (defina PW_JS). ${e.message}`);
  }
}

async function abrirNavegador() {
  const { chromium } = playwright();
  return chromium.launch({ channel: 'chrome', headless: !process.env.VER });
}

const CELULAR = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const COMPUTADOR = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 };

async function novoContexto(browser, { celular = false, reduzirMovimento = false } = {}) {
  const ctx = await browser.newContext({
    ...(celular ? CELULAR : COMPUTADOR),
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    reducedMotion: reduzirMovimento ? 'reduce' : 'no-preference',
  });
  // window.confirm / prompt / beforeunload: aceita e anota (o painel pede confirmação para excluir, reabrir, sair sem salvar)
  const dialogos = [];
  const aoAbrir = p => p.on('dialog', d => { dialogos.push(`${d.type()}: ${d.message()}`); d.accept().catch(() => {}); });
  ctx.on('page', aoAbrir);
  ctx._dialogos = dialogos;
  return ctx;
}

// Erros de console, erros de JavaScript e respostas >= 400 (ou falhas de rede) em todas as abas do contexto.
// `permitir(url, status)` libera um caso esperado (ex.: 404 de /p/<slug> na página de erro).
// Falha de rede em host externo (net::ERR_*) vira aviso, não falha: depende da internet da máquina.
function vigiar(ctx, { permitir = () => false } = {}) {
  const v = { erros: [], avisos: [] };
  const local = u => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u);
  const ligar = p => {
    p.on('console', m => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/^Failed to load resource/i.test(t)) return;   // coberto pelas respostas abaixo
      v.erros.push(`console (${p.url()}): ${t}`);
    });
    p.on('pageerror', e => v.erros.push(`javascript (${p.url()}): ${e && e.message}`));
    p.on('response', r => {
      const s = r.status(), u = r.url();
      if (s < 400 || permitir(u, s)) return;
      v.erros.push(`HTTP ${s} ${r.request().method()} ${u}`);
    });
    p.on('requestfailed', r => {
      const u = r.url(), f = (r.failure() && r.failure().errorText) || '';
      if (/ERR_ABORTED/.test(f)) return;   // navegação/lazy-load cancelado: normal
      if (local(u)) v.erros.push(`rede ${f} ${r.method()} ${u}`);
      else v.avisos.push(`rede externa ${f} ${u.slice(0, 120)}`);
    });
  };
  ctx.pages().forEach(ligar);
  ctx.on('page', ligar);
  return v;
}

// Toda requisição do navegador para a API local (e qualquer uma para a API publicada, que não pode acontecer aqui).
function gravarRedeApi(ctx) {
  const lista = [];
  ctx.on('request', r => {
    const u = new URL(r.url());
    if (u.host === `127.0.0.1:${PORTA_API}` || u.host === `localhost:${PORTA_API}` || u.host === HOST_API_PUBLICADA) {
      lista.push({ metodo: r.method(), caminho: u.pathname, host: u.host });
    }
  });
  return lista;
}

// Clica em algo que abre outra página: pode ser aba nova (target=_blank) ou a mesma aba.
// Devolve { pagina, novaAba, fechar() } — fechar() fecha a aba nova ou volta na mesma.
async function abrirDestino(ctx, page, clicar) {
  const urlAntes = page.url();
  const novaP = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  await clicar();
  const nova = await novaP;
  if (nova) {
    await nova.waitForLoadState('domcontentloaded');
    return { pagina: nova, novaAba: true, fechar: () => nova.close() };
  }
  await page.waitForURL(u => String(u) !== urlAntes, { timeout: 8000 });
  return {
    pagina: page, novaAba: false,
    fechar: async () => { await page.goBack({ waitUntil: 'domcontentloaded' }); },
  };
}

async function lerLS(page, chave) { return page.evaluate(k => { try { return localStorage.getItem(k); } catch (e) { return '__erro__'; } }, chave); }
async function lerJsonLS(page, chave) { const t = await lerLS(page, chave); try { return JSON.parse(t); } catch (e) { return null; } }
const lerSandbox = page => lerJsonLS(page, 'rk_demo_sandbox_v1');
const visivel = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);
async function esperarVisivel(page, sel, ms = 10000) { await page.locator(sel).first().waitFor({ state: 'visible', timeout: ms }); }
async function esperarOculto(page, sel, ms = 10000) { await page.locator(sel).first().waitFor({ state: 'hidden', timeout: ms }); }
async function texto(page, sel) { return norm(await page.locator(sel).first().innerText()); }
async function esperarToast(page, trecho, ms = 8000) {
  await page.waitForFunction(t => {
    const el = document.getElementById('toast');
    return !!el && el.textContent.replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').includes(t);
  }, trecho, { timeout: ms }).catch(async () => {
    const atual = await page.locator('#toast').textContent().catch(() => '');
    throw new Error(`o aviso (#toast) não mostrou "${trecho}" (mostrou: "${norm(atual)}")`);
  });
}
// a página não rola para o lado (tolerância de 1 px de arredondamento)
async function semRolagemLateral(page) {
  const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, vw: window.innerWidth }));
  verdade(m.doc <= m.vw + 1 && m.body <= m.vw + 1, `rolagem lateral: scrollWidth ${m.doc}/${m.body} > largura ${m.vw}`);
}
// rola a página inteira devagar (dispara lazy-load e animações de entrada) e volta ao topo
async function rolarTudo(page) {
  await page.evaluate(async () => {
    const passo = Math.max(200, Math.floor(innerHeight * 0.7));
    for (let y = 0; y < document.documentElement.scrollHeight; y += passo) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    scrollTo(0, document.documentElement.scrollHeight);
    await new Promise(r => setTimeout(r, 300));
    await Promise.all(Array.from(document.images).map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 6000); })));
    scrollTo(0, 0);
  });
  await dormir(300);
}
// print sem animação no meio do caminho (folhas e transições terminam na hora); página inteira sai em JPEG (bem menor)
async function print(page, nome, opcoes = {}) {
  fs.mkdirSync(PRINTS, { recursive: true });
  const inteira = !!opcoes.fullPage;
  const arq = path.join(PRINTS, nome + (inteira ? '.jpg' : '.png'));
  await dormir(250);
  await page.screenshot({ path: arq, animations: 'disabled', ...(inteira ? { type: 'jpeg', quality: 78 } : {}), ...opcoes });
  return arq;
}

// ======================================================================================
// Rodar um roteiro sozinho (node visitante.js) ou vários (rodar-tudo.js)
// ======================================================================================

async function subirTudo() {
  console.log('Ambiente');
  console.log(`  banco local novo em ${PERSIST}`);
  await exigirPortasLivres();
  lerDevVars();
  aplicarSchema();
  console.log('  schema.sql aplicado');
  await subirApi();
  console.log(`  API no ar em ${API} (wrangler dev, DEMO do wrangler.toml)`);
  await subirSite();
  console.log(`  site no ar em ${SITE} (servindo site/)`);
  const browser = await abrirNavegador();
  return {
    browser,
    loginAdmin, loginVisitante, listar, listarContatos, apiReq,
    senhaAdmin: () => lerDevVars().ADMIN_SENHA,
    async fechar() { try { await browser.close(); } catch (e) { /* já fechado */ } encerrar(); },
  };
}

function imprimirResumo(resumos) {
  console.log('\nResumo');
  let falhas = 0;
  for (const r of resumos) {
    falhas += r.falhas.length;
    console.log(`  ${r.falhas.length ? 'FALHOU' : 'ok    '}  ${r.nome}: ${r.ok} etapas ok, ${r.falhas.length} com falha, ${r.avisos.length} avisos`);
    r.falhas.forEach(f => console.log(`            - ${f}`));
    r.avisos.forEach(a => console.log(`            (aviso) ${a}`));
  }
  console.log(falhas ? `\n${falhas} etapa(s) com falha. Prints das falhas em ${path.relative(BASE_DIR, PRINTS)}\\` : '\nTudo certo.');
  return falhas;
}

async function principal(rodar) {
  let ctx = null, resumo = null, codigo = 1;
  try {
    ctx = await subirTudo();
    resumo = await rodar(ctx);
    codigo = imprimirResumo([resumo]) ? 1 : 0;
  } catch (e) {
    console.error('\nERRO: ' + redigir((process.env.PILHA ? e && e.stack : e && e.message) || e));   // PILHA=1 mostra a pilha
    if (resumo) imprimirResumo([resumo]);
  } finally {
    if (ctx) await ctx.fechar(); else encerrar();
  }
  process.exit(codigo);
}

module.exports = {
  BASE_DIR, API_DIR, SITE_DIR, PRINTS, PERSIST, LOGS, API, SITE, PORTA_API, PORTA_SITE, HOST_API_PUBLICADA, WA_RK,
  dormir, lerDevVars, redigir, encerrar, subirTudo, principal, imprimirResumo,
  apiReq, loginAdmin, loginVisitante, listar, listarContatos,
  hojeBr, maisDias, sab, idDemo, fmtNum, fmtReais, norm,
  Relatorio, verdade, igual, contem, canonico, diferencasBanco,
  abrirNavegador, novoContexto, vigiar, gravarRedeApi, abrirDestino,
  lerLS, lerJsonLS, lerSandbox, visivel, esperarVisivel, esperarOculto, texto, esperarToast, semRolagemLateral, rolarTudo, print,
};
