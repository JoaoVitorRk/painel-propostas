'use strict';
// Roteiro ponta a ponta do ADMINISTRADOR (senha de verdade = ADMIN_SENHA do api/.dev.vars) — ESPEC §4.1, §5.3 e §9.
//   node testes-e2e/admin.js        (sobe API 8792 + site 8126 do zero, roda e encerra tudo)
//
// O que prova:
//   - o administrador entra com a senha e não vê nada do modo visitante (faixa, guia, dicas, sandbox);
//   - ele cria e publica uma proposta DE VERDADE (POST na API) e ela abre para um cliente sem login, contando a abertura;
//   - a prévia do administrador (#previa) não conta abertura;
//   - um visitante (outro navegador) continua vendo só as linhas da demo (a proposta do administrador não aparece para
//     ele: a API filtra pelo prefixo dos ids), e o que ELE cria fica só no navegador dele: o link dele não abre para
//     ninguém e nada chega ao banco;
//   - "Fechou?" com adicional, Reabrir e Excluir do administrador gravam de verdade; depois de excluída o link para;
//   - com token de visitante, as 5 leituras dão 200 e TODA escrita dá 403 "Modo visitante: nada é salvo nem publicado."
//     sem mudar nada no banco;
//   - no fim o banco volta a ser igual ao do começo (a proposta de teste é excluída) e não há erro de console.
//
// SUPOSIÇÕES (escritas antes de o painel ficar pronto; numa rodada prévia em 06/10/2026, contra as versões em andamento, todas valeram):
//   1. Com papel "admin" a faixa #faixaVisitante, o guia #folhaGuia e as .dica-visitante ficam ocultos (ou nem existem).
//   2. #prontaAvisoVisitante fica oculto para o administrador.
//   3. A página da proposta, com sessão de admin no localStorage, busca GET /admin/p/:slug e mostra #previa (como hoje).
//   4. Ids e textos do painel original (§10): #btNovaAgenda, #fxAddAdic com linhas .x-nome/.x-valor, toasts "reaberta"/"excluída".
//   5. 404 de GET /p/<slug> é esperado nas páginas de proposta excluída/inexistente e não conta como erro.

const A = require('./ambiente');
const { verdade, igual, contem } = A;

const ERRO_VISITANTE = 'Modo visitante: nada é salvo nem publicado.';
const NOME = 'Admin Teste E2E & Par';

async function rodar(ctx) {
  const rel = new A.Relatorio('admin');
  console.log('\nAdministrador (grava de verdade)');

  const tokenAdmin = await ctx.loginAdmin();
  const antes = await ctx.listar(tokenAdmin);
  const ver = async id => (await ctx.apiReq('GET', `/admin/propostas/${id}`, { token: tokenAdmin }));

  const browser = ctx.browser;
  const p404 = (u, s) => s === 404 && /^\/p\/[a-z0-9-]+$/.test(new URL(u).pathname);
  const context = await A.novoContexto(browser);
  const rede = A.gravarRedeApi(context);
  const vig = A.vigiar(context, { permitir: p404 });
  const anon = await A.novoContexto(browser);          // o cliente: navegador sem nada salvo
  const vigAnon = A.vigiar(anon, { permitir: p404 });
  const page = await context.newPage();
  rel.pagina = page;
  let link = '', id = '';
  const errosExtras = [];

  const aba = async nome => {
    await page.click(`#abas [data-aba="${nome}"]`);
    await A.esperarVisivel(page, '#aba' + nome.charAt(0).toUpperCase() + nome.slice(1));
  };
  const cartao = (escopo, nome) => page.locator(`${escopo} .pcard`).filter({ hasText: nome }).first();
  async function naLista() {
    for (let i = 0; i < 3; i++) {
      if (await A.visivel(page, '#vLista') && !(await page.locator('.folha-fundo:visible').count())) return;
      if (await page.locator('.folha-fundo:visible').count()) { await page.keyboard.press('Escape'); await A.dormir(250); continue; }
      if (await A.visivel(page, '#vEditor')) { await page.click('#btVoltar'); await A.dormir(400); continue; }
    }
    await A.esperarVisivel(page, '#vLista');
  }

  await rel.etapa('entra com a senha do administrador', async () => {
    await page.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#vLogin');
    await page.fill('#senha', ctx.senhaAdmin());
    await page.click('#btEntrar');
    await A.esperarVisivel(page, '#vLista', 15000);
    const s = await A.lerJsonLS(page, 'rk_painel_sessao');
    igual(s && s.papel, 'admin', 'papel da sessão');
  }, { critica: true });

  await rel.etapa('o administrador não vê nada do modo visitante', async () => {
    await A.dormir(800);
    verdade(!(await A.visivel(page, '#faixaVisitante')), '#faixaVisitante visível para o admin');
    verdade(!(await A.visivel(page, '#folhaGuia')), 'guia aberto para o admin');
    igual(await page.locator('.dica-visitante:visible').count(), 0, 'dicas de visitante visíveis');
    igual(await A.lerLS(page, 'rk_demo_sandbox_v1'), null, 'sandbox no localStorage do admin');
  });

  await rel.etapa('cria e publica uma proposta de verdade (POST /admin/propostas)', async () => {
    await aba('agenda');
    await page.click('#btNovaAgenda');
    await A.esperarVisivel(page, '#vEditor');
    await page.fill('#fCliente', NOME);
    await page.fill('#fData', A.maisDias(A.hojeBr(), 330));
    await page.fill('#fHora', '17:00');
    await page.fill('#fLocal', 'Espaço de teste · Curitiba');
    await page.click('#btSalvar');
    await A.esperarVisivel(page, '#folhaPronta');
    link = await A.texto(page, '#prontaLink');
    verdade(link.startsWith(A.SITE + '/proposta/?p='), `link: ${link}`);
    verdade(!(await A.visivel(page, '#prontaAvisoVisitante')), 'aviso de visitante aparecendo para o admin');
    verdade(rede.some(r => r.metodo === 'POST' && r.caminho === '/admin/propostas'), 'o painel não fez POST /admin/propostas');
    const slug = new URL(link).searchParams.get('p');
    const p = (await ctx.listar(tokenAdmin)).find(x => x.slug === slug);
    verdade(p, 'a proposta não está no banco');
    igual([p.status, p.etapa, p.views, p.dados.cliente], ['publicada', 'aberta', 0, NOME], 'proposta no banco');
    id = p.id;
  }, { critica: true });

  await rel.etapa('a proposta abre para um cliente sem login e conta a abertura', async () => {
    const pa = await anon.newPage();
    try {
      await pa.goto(link, { waitUntil: 'domcontentloaded' });
      await A.esperarVisivel(pa, '#proposta', 15000);
      contem(await A.texto(pa, '#pCliente'), 'Admin Teste E2E', 'capa');
      verdade(!(await A.visivel(pa, '#faixaSandbox')), '#faixaSandbox para um cliente');
      verdade(!(await A.visivel(pa, '#previa')), '#previa para um cliente');
    } finally { await pa.close(); }
    igual((await ver(id)).json.views, 1, 'views depois da abertura do cliente');
  });

  await rel.etapa('a prévia do administrador (#previa) não conta abertura', async () => {
    const d = await A.abrirDestino(context, page, () => page.click('#prontaVer'));
    try {
      await A.esperarVisivel(d.pagina, '#proposta', 15000);
      await A.esperarVisivel(d.pagina, '#previa');
      verdade(!(await A.visivel(d.pagina, '#faixaSandbox')), '#faixaSandbox na prévia do admin');
    } finally { await d.fechar(); }
    igual((await ver(id)).json.views, 1, 'views depois da prévia');
    if (await A.visivel(page, '#folhaPronta')) await page.click('#prontaVoltar');
    await naLista();
  });

  await rel.etapa('um visitante vê só as linhas da demo (não a proposta do admin), e o que ele cria fica só no navegador dele', async () => {
    const vis = await A.novoContexto(browser);
    const redeVis = A.gravarRedeApi(vis);
    const vigVis = A.vigiar(vis, { permitir: p404 });
    const pv = await vis.newPage();
    try {
      await pv.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
      await A.esperarVisivel(pv, '#btVisitante');
      await pv.click('#btVisitante');
      await A.esperarVisivel(pv, '#vLista', 15000);
      if (await pv.locator('#folhaGuia').isVisible().catch(() => false)) await pv.click('#guiaComecar');
      await pv.click('#abas [data-aba="propostas"]');
      await A.esperarVisivel(pv, '#abaPropostas');
      await pv.waitForFunction(() => document.querySelectorAll('#lista .pcard').length > 0, null, { timeout: 8000 });
      verdade(!(await A.texto(pv, '#lista')).includes(NOME), 'a proposta do admin apareceu para o visitante (a API só devolve as linhas da demo)');
      await pv.click('#btNova');
      await A.esperarVisivel(pv, '#vEditor');
      await pv.fill('#fCliente', 'Visitante Isolado & Par');
      await pv.click('#btSalvar');
      await A.esperarVisivel(pv, '#folhaPronta');
      const linkV = await A.texto(pv, '#prontaLink');
      const pa = await anon.newPage();
      try {
        await pa.goto(linkV, { waitUntil: 'domcontentloaded' });
        await A.esperarVisivel(pa, '#erro', 12000);
      } finally { await pa.close(); }
      const lista = await ctx.listar(tokenAdmin);
      verdade(!lista.some(p => /Visitante Isolado/.test((p.dados && p.dados.cliente) || '')), 'a proposta do visitante chegou ao banco');
      const proibidas = redeVis.filter(r => !(r.metodo === 'GET' || r.metodo === 'OPTIONS' || (r.metodo === 'POST' && r.caminho === '/login')));
      igual(proibidas, [], 'escritas do visitante na rede');
    } finally {
      errosExtras.push(...vigVis.erros);
      await vis.close();
    }
  });

  await rel.etapa('"Fechou?" do administrador grava de verdade, com adicional', async () => {
    await naLista(); await aba('propostas');
    await cartao('#lista', NOME).locator('.b-verde').click();
    await A.esperarVisivel(page, '#folhaFechou');
    await page.click('#fxOpcoes button[data-v="simples"]');
    await page.click('#fxPacotes button[data-v="cerimonia"]');
    igual(await page.inputValue('#fxValor'), '2.400', 'valor que se preenche sozinho');
    await page.click('#fxAddAdic');
    const l = page.locator('#fxAdicionais > *').last();
    await l.locator('.x-nome').fill('Adicional de teste');
    await l.locator('.x-valor').fill('150');
    contem(await A.texto(page, '#fxTotal'), '2.550', '#fxTotal');
    await page.click('#fxSalvar');
    await A.esperarOculto(page, '#folhaFechou');
    await A.esperarToast(page, '2.550');
    const p = (await ver(id)).json;
    igual([p.etapa, p.valor_fechado], ['fechada', 2550], 'etapa e valor no banco');
    igual([p.fechamento.opcao, p.fechamento.pacote, p.fechamento.valor], ['simples', 'cerimonia', 2400], 'fechamento');
    igual(p.fechamento.adicionais, [{ nome: 'Adicional de teste', valor: 150 }], 'adicionais');
    verdade(rede.some(r => r.metodo === 'PUT' && r.caminho === `/admin/propostas/${id}/etapa`), 'o painel não fez PUT .../etapa');
  });

  await rel.etapa('Reabrir e Excluir gravam de verdade; depois o link não abre mais', async () => {
    await naLista(); await aba('clientes');
    await cartao('#clientes', NOME).locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    await page.click('#btReabrir');
    await A.esperarToast(page, 'reaberta');
    const p = (await ver(id)).json;
    igual([p.etapa, p.valor_fechado], ['aberta', null], 'depois de reabrir');
    await page.locator('#maisOpcoes').evaluate(d => { d.open = true; });
    await page.click('#edExcluir');
    await A.esperarToast(page, 'excluída');
    await A.esperarVisivel(page, '#vLista');
    igual((await ver(id)).status, 404, 'GET da proposta excluída');
    verdade(rede.some(r => r.metodo === 'DELETE' && r.caminho === `/admin/propostas/${id}`), 'o painel não fez DELETE');
    const pa = await anon.newPage();
    try {
      await pa.goto(link, { waitUntil: 'domcontentloaded' });
      await A.esperarVisivel(pa, '#erro', 12000);
    } finally { await pa.close(); }
  });

  await rel.etapa('token de visitante: as 5 leituras dão 200 e toda escrita dá 403 sem mudar nada', async () => {
    const tv = await ctx.loginVisitante();
    const l0 = await ctx.listar(tokenAdmin);
    const m0 = (await ctx.apiReq('GET', '/admin/modelo', { token: tokenAdmin })).json;
    for (const caminho of ['/admin/propostas', `/admin/propostas/${A.idDemo(1)}`, '/admin/p/exemplo', '/admin/modelo', '/admin/resumo']) {
      const r = await ctx.apiReq('GET', caminho, { token: tv });
      igual(r.status, 200, `GET ${caminho} com token de visitante`);
    }
    const escritas = [
      ['POST', '/admin/propostas', { dados: { cliente: 'Invasor & Teste' }, status: 'publicada' }],
      ['PUT', `/admin/propostas/${A.idDemo(11)}`, { dados: { cliente: 'Invasor & Teste' }, status: 'publicada' }],
      ['DELETE', `/admin/propostas/${A.idDemo(15)}`, undefined],
      ['POST', `/admin/propostas/${A.idDemo(1)}/duplicar`, {}],
      ['PUT', `/admin/propostas/${A.idDemo(11)}/etapa`, { etapa: 'perdida', motivo: 'teste' }],
      ['PUT', '/admin/modelo', { dados: { tipo: 'Invasão' } }],
    ];
    for (const [metodo, caminho, corpo] of escritas) {
      const r = await ctx.apiReq(metodo, caminho, { token: tv, corpo });
      igual([r.status, r.json && r.json.erro], [403, ERRO_VISITANTE], `${metodo} ${caminho} com token de visitante`);
    }
    igual(A.diferencasBanco(l0, await ctx.listar(tokenAdmin)), [], 'o banco mudou depois das escritas do visitante');
    igual((await ctx.apiReq('GET', '/admin/modelo', { token: tokenAdmin })).json, m0, 'o modelo mudou');
  });

  await rel.etapa('o banco termina igual ao do começo (a proposta de teste foi excluída)', async () => {
    igual(A.diferencasBanco(antes, await ctx.listar(tokenAdmin)), [], 'diferenças no banco');
  });

  await rel.etapa('zero erros de console e de rede nas páginas', async () => {
    vig.avisos.concat(vigAnon.avisos).forEach(a => rel.aviso(a));
    igual(vig.erros.concat(vigAnon.erros, errosExtras), [], 'erros');
  });

  await anon.close();
  await context.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
