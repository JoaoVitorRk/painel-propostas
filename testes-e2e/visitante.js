'use strict';
// Roteiro ponta a ponta do MODO VISITANTE (ESPEC §5.3, §5.4, §9 e §10).
//   node testes-e2e/visitante.js        (sobe API 8792 + site 8126 do zero, roda e encerra tudo)
//
// O que prova:
//   - entrar como visitante, guia de boas-vindas na 1ª entrada, "Como funciona", dicas por tela, faixa do modo visitante;
//   - agenda e clientes com os dados fictícios da demo (§8); cartão "Sua proposta padrão";
//   - criar proposta, "Ver proposta" (abre a página pelo sandbox, com #faixaSandbox), editar uma da demo,
//     "Fechou?" com adicional, Editar fechamento, Reabrir, Não fechou, duplicar, excluir, editar a proposta padrão,
//     Recomeçar e Sair;
//   - TODAS as requisições do navegador para 127.0.0.1:8792 são GET, OPTIONS ou POST /login (nada que grave);
//   - a lista do banco (GET /admin/propostas com token de admin) é igual antes e depois;
//   - zero erros de console; no celular (375 px) a página não rola para o lado. Prints em testes-e2e/prints/.
//
// SUPOSIÇÕES (escritas antes de o painel ficar pronto; numa rodada prévia em 06/10/2026, contra as versões em andamento, todas valeram):
//   1. #btVisitante preenche "visitante" e já entra (não precisa clicar em #btEntrar).
//   2. #folhaGuia, #folhaPronta e #folhaFechou usam o atributo hidden (como as folhas do painel original);
//      #guiaComecar fecha o guia e grava rk_demo_guia_visto = "1".
//   3. #guiaVerExemplo e os "Ver proposta" podem abrir em aba nova ou na mesma aba: o roteiro aceita os dois.
//   4. Cada aba (Agenda, Propostas, Clientes) e o editor mostram uma .dica-visitante visível, com .dica-fechar dentro.
//   5. O botão do #cartaoModelo é um <button>/<a> dentro dele (se não houver, clica no próprio cartão).
//   6. Os textos e a lógica do painel original continuam: toasts "Alterações salvas", "Proposta reaberta",
//      "Proposta padrão salva" (o roteiro procura só "salv"), "excluída"; #fxAdicSug com botões data-nome; #fxPacotes data-v; ids do §10.
//   7. "Duplicar" pode copiar no formulário (como no painel original: nome em branco, salva como nova) ou já criar
//      a cópia no sandbox com "(cópia)": o roteiro aceita os dois e confere que entrou uma proposta a mais.
//   8. "Recomeçar" e "Sair" podem pedir confirmação: todo window.confirm é aceito.
//   9. A 2ª entrada como visitante não deveria mostrar o guia de novo (rk_demo_guia_visto continua): se mostrar, vira aviso.

const A = require('./ambiente');
const { verdade, igual, contem, norm } = A;

async function rodar(ctx) {
  const rel = new A.Relatorio('visitante');
  console.log('\nVisitante (painel no navegador, nada gravado)');

  // ---------- banco antes ----------
  const tokenAdmin = await ctx.loginAdmin();
  const antes = await ctx.listar(tokenAdmin);   // o 1º GET com DEMO=1 já semeia os dados fictícios
  const porId = id => antes.find(p => p.id === id);
  const fechadas = antes.filter(p => p.etapa === 'fechada');
  const abertas = antes.filter(p => p.etapa !== 'fechada' && p.etapa !== 'perdida');
  const totalBase = Math.round(fechadas.reduce((s, p) => s + (Number(p.valor_fechado) || 0), 0) * 100) / 100;
  const hoje = A.hojeBr();

  await rel.etapa('dados da demonstração conferem com a ESPEC §8', async () => {
    for (let nn = 1; nn <= 18; nn++) verdade(porId(A.idDemo(nn)), `falta a proposta da demo ${A.idDemo(nn)}`);
    const p = nn => porId(A.idDemo(nn));
    igual(p(1).slug, 'exemplo', 'slug da 01');
    igual([p(2).dados.data, p(3).dados.data], [A.sab(20), A.sab(20)], '02 e 03 no mesmo sábado (sab(20))');
    igual([p(4).dados.data, p(13).dados.data], [A.sab(48), A.sab(48)], '04 e 13 no mesmo sábado (sab(48))');
    igual(p(15).status, 'rascunho', '15 é rascunho');
    igual([16, 17, 18].map(n => p(n).etapa), ['perdida', 'perdida', 'perdida'], '16 a 18 não fecharam');
    igual(p(2).valor_fechado, 8400, '02 = 7.500 + álbum 900');
    igual(p(6).valor_fechado, 9300, '06 = 7.500 + drone 600 + segundo videomaker 1.200');
    igual(fechadas.length, 9, 'eventos fechados na demo');
    igual(totalBase, 46400, 'faturamento da demo');
  });

  const browser = ctx.browser;
  const context = await A.novoContexto(browser);
  const rede = A.gravarRedeApi(context);
  const vig = A.vigiar(context, { permitir: () => false });
  const page = await context.newPage();
  rel.pagina = page;
  let slugNovo = '';
  let fraseAdaptacao = '';   // onde apareceu "As opções, os valores e os entregáveis são um exemplo…" (§5.4)

  // ---------- utilidades do painel ----------
  const aba = async nome => {
    await page.click(`#abas [data-aba="${nome}"]`);
    await A.esperarVisivel(page, '#aba' + nome.charAt(0).toUpperCase() + nome.slice(1));
  };
  const cartao = (escopo, nome) => page.locator(`${escopo} .pcard`).filter({ hasText: nome }).first();
  const dicasVisiveis = () => page.locator('.dica-visitante:visible').count();
  async function naLista() {   // volta para a lista de qualquer lugar (folha aberta, editor)
    for (let i = 0; i < 3; i++) {
      if (await A.visivel(page, '#vLista') && !(await page.locator('.folha-fundo:visible').count())) return;
      if (await page.locator('.folha-fundo:visible').count()) { await page.keyboard.press('Escape'); await A.dormir(250); continue; }
      if (await A.visivel(page, '#vEditor')) { await page.click('#btVoltar'); await A.dormir(400); continue; }
    }
    await A.esperarVisivel(page, '#vLista');
  }
  async function abrirMaisOpcoes() { await page.locator('#maisOpcoes').evaluate(d => { d.open = true; }); }
  async function sandbox() { return A.lerSandbox(page); }

  // ---------- entrar ----------
  await rel.etapa('abre o painel e entra pelo botão "Entrar como visitante"', async () => {
    await page.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#vLogin');
    await A.esperarVisivel(page, '#btVisitante');
    contem(await A.texto(page, '#vLogin'), 'visitante', 'tela de login');
    await page.click('#btVisitante');
    await A.esperarVisivel(page, '#vLista', 15000);
    const s = await A.lerJsonLS(page, 'rk_painel_sessao');
    verdade(s && s.token && s.exp > Date.now() / 1000, 'sessão rk_painel_sessao gravada');
    igual(s.papel, 'visitante', 'papel da sessão');
  }, { critica: true });

  await rel.etapa('guia de boas-vindas aparece na 1ª entrada, com os 4 passos', async () => {
    await A.esperarVisivel(page, '#folhaGuia', 6000);
    const t = await A.texto(page, '#folhaGuia');
    for (const x of ['Agenda', 'Propostas', 'Fechou?', 'proposta padrão', 'Tudo aqui é exemplo']) contem(t, x, 'guia');
    await A.esperarVisivel(page, '#guiaComecar');
    await A.esperarVisivel(page, '#guiaVerExemplo');
    await A.print(page, 'visitante-computador-guia');
    await page.click('#guiaComecar');
    await A.esperarOculto(page, '#folhaGuia');
    igual(await A.lerLS(page, 'rk_demo_guia_visto'), '1', 'rk_demo_guia_visto');
  });

  await rel.etapa('o sandbox se monta com os dados do servidor', async () => {
    await page.waitForFunction(() => {
      try { const s = JSON.parse(localStorage.getItem('rk_demo_sandbox_v1') || 'null'); return !!(s && Array.isArray(s.propostas) && s.propostas.length); } catch (e) { return false; }
    }, null, { timeout: 10000 });
    const sb = await sandbox();
    igual(sb.v, 1, 'versão do sandbox');
    verdade(!isNaN(Date.parse(sb.criado_em)), 'criado_em do sandbox');
    igual(sb.propostas.map(p => p.id).sort(), antes.map(p => p.id), 'propostas do sandbox = do servidor');
    verdade(sb.modelo && sb.modelo.opcoes && sb.modelo.opcoes.media, 'modelo no sandbox');
    igual(sb.removidos, [], 'removidos começa vazio');
  });

  await rel.etapa('faixa do modo visitante, "Recomeçar" e "Como funciona" à vista', async () => {
    await A.esperarVisivel(page, '#faixaVisitante');
    const t = await A.texto(page, '#faixaVisitante');
    contem(t, 'Modo visitante', 'faixa'); contem(t, 'nada é salvo nem publicado', 'faixa');
    await A.esperarVisivel(page, '#faixaVisitante #btRecomecar');
    await A.esperarVisivel(page, '#btComoFunciona');
  });

  await rel.etapa('"Como funciona" reabre o guia e "Ver uma proposta pronta" abre o exemplo pelo sandbox', async () => {
    await page.click('#btComoFunciona');
    await A.esperarVisivel(page, '#folhaGuia');
    const d = await A.abrirDestino(context, page, () => page.click('#guiaVerExemplo'));
    try {
      await A.esperarVisivel(d.pagina, '#proposta', 15000);
      contem(d.pagina.url(), 'proposta/?p=exemplo', 'endereço');
      contem(await A.texto(d.pagina, '#pCliente'), 'Marina', 'capa');
      await A.esperarVisivel(d.pagina, '#faixaSandbox');
    } finally { await d.fechar(); }
    if (!d.novaAba) await A.esperarVisivel(page, '#vLista');
    if (await A.visivel(page, '#folhaGuia')) await page.click('#guiaComecar');
    await A.esperarOculto(page, '#folhaGuia');
  });

  // ---------- agenda ----------
  await rel.etapa('Agenda: mês atual, dica, dia com dois eventos da demo e próximos 12 meses', async () => {
    await aba('agenda');
    verdade(await dicasVisiveis() >= 1, 'nenhuma .dica-visitante visível na Agenda');
    const mesAtual = await page.evaluate(() => new Date().toLocaleDateString('pt-BR', { month: 'long' }).toLowerCase());
    contem((await A.texto(page, '#mesTitulo')).toLowerCase(), mesAtual, '#mesTitulo');
    verdade((await A.texto(page, '#mAguardando')) !== '–', '#mAguardando sem número');
    igual(await page.locator('#meses > *').count(), 12, 'chips dos próximos meses');
    await A.print(page, 'visitante-computador-agenda');
    // vai até o mês de sab(20): 02 e 03 fecharam no mesmo dia → dia cheio
    const alvo = A.sab(20);
    const nomeMes = await page.evaluate(iso => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, 1).toLocaleDateString('pt-BR', { month: 'long' }).toLowerCase(), alvo);
    for (let i = 0; i < 4 && !(await A.texto(page, '#mesTitulo')).toLowerCase().includes(nomeMes); i++) { await page.click('#mesProx'); await A.dormir(150); }
    contem((await A.texto(page, '#mesTitulo')).toLowerCase(), nomeMes, 'navegação até o mês de sab(20)');
    const dia = page.locator('#cal [aria-label*="Beatriz & Thiago"]').first();
    await dia.waitFor({ state: 'visible', timeout: 5000 });
    contem(await dia.getAttribute('aria-label'), 'Formatura Medicina · Turma 48', 'dia de sab(20)');
    if (!/\bcheio\b/.test(await dia.getAttribute('class') || '')) rel.aviso('o dia com 2 eventos fechados não tem a classe "cheio" (painel original tinha)');
    const lista = await A.texto(page, '#mesLista');
    contem(lista, 'Beatriz & Thiago', '#mesLista'); contem(lista, 'Formatura Medicina · Turma 48', '#mesLista');
    // fecha a dica da agenda
    const antesDicas = await dicasVisiveis();
    if (await A.visivel(page, '#mesHoje')) await page.click('#mesHoje');
    await page.locator('.dica-visitante:visible .dica-fechar').first().click();
    await A.dormir(300);
    verdade(await dicasVisiveis() < antesDicas, 'a dica não fechou');
  });

  // ---------- clientes ----------
  await rel.etapa('Clientes: dica, faturamento e eventos fechados da demo', async () => {
    await aba('clientes');
    verdade(await dicasVisiveis() >= 1, 'nenhuma .dica-visitante visível em Clientes');
    igual(await A.texto(page, '#rTotal'), A.fmtReais(totalBase), '#rTotal');
    igual(await A.texto(page, '#rFechadas'), String(fechadas.length), '#rFechadas');
    const t = await A.texto(page, '#clientes');
    for (const n of ['Beatriz & Thiago', 'Fernanda & Caetano', 'Helena · 15 anos', 'Aline & Bruno']) contem(t, n, '#clientes');
    await A.print(page, 'visitante-computador-clientes');
  });

  // ---------- propostas ----------
  await rel.etapa('Propostas: dica, as em aberto da demo e o cartão "Sua proposta padrão"', async () => {
    await aba('propostas');
    verdade(await dicasVisiveis() >= 1, 'nenhuma .dica-visitante visível em Propostas');
    await page.waitForFunction(n => document.querySelectorAll('#lista .pcard').length === n, abertas.length, { timeout: 8000 })
      .catch(async () => { throw new Error(`#lista tem ${await page.locator('#lista .pcard').count()} cartões; esperado ${abertas.length} em aberto`); });
    const t = await A.texto(page, '#lista');
    for (const n of ['Marina & Rafael', 'Isabela & Rodrigo', 'Cláudia · 50 anos', 'Vanessa & Leonardo', 'Convenção Prisma 2027', 'Sofia & Daniel']) contem(t, n, '#lista');
    await A.esperarVisivel(page, '#cartaoModelo');
    const c = await A.texto(page, '#cartaoModelo');
    contem(c, 'Sua proposta padrão', '#cartaoModelo'); contem(c, 'Monte uma vez', '#cartaoModelo');
    if (!(await page.locator('#btModelo').count())) rel.aviso('#btModelo não existe mais (o contrato §10 mantém esse id)');
    if (norm(await page.locator('body').innerText()).includes('são um exemplo')) fraseAdaptacao = 'Propostas';
    await A.print(page, 'visitante-computador-propostas');
  });

  // ---------- criar ----------
  await rel.etapa('cria uma proposta nova: link na folha "Proposta pronta" com o aviso do visitante', async () => {
    await page.click('#btNova');
    await A.esperarVisivel(page, '#vEditor');
    verdade(await dicasVisiveis() >= 1, 'nenhuma .dica-visitante visível no editor');
    if (!fraseAdaptacao && norm(await page.locator('#vEditor').innerText()).includes('são um exemplo')) fraseAdaptacao = 'editor';
    await A.esperarVisivel(page, '#faixaVisitante');
    await page.fill('#fCliente', 'Teste Visitante & Par');
    await page.fill('#fData', A.maisDias(hoje, 200));
    await page.fill('#fHora', '16:00');
    await page.fill('#fLocal', 'Local de teste');
    await page.click('#btSalvar');
    await A.esperarVisivel(page, '#folhaPronta');
    const link = await A.texto(page, '#prontaLink');
    verdade(link.startsWith(A.SITE + '/proposta/?p='), `link montado a partir do endereço atual: ${link}`);
    slugNovo = new URL(link).searchParams.get('p') || '';
    verdade(/^teste-visitante/.test(slugNovo), `slug a partir do nome: ${slugNovo}`);
    await A.esperarVisivel(page, '#prontaAvisoVisitante');
    contem(await A.texto(page, '#prontaAvisoVisitante'), 'só abre neste aparelho', '#prontaAvisoVisitante');
    const sb = await sandbox();
    igual(sb.propostas.length, antes.length + 1, 'propostas no sandbox');
    const nova = sb.propostas.find(p => p.slug === slugNovo);
    verdade(nova, 'a proposta nova está no sandbox');
    igual([nova.status, nova.etapa, nova.views], ['publicada', 'aberta', 0], 'status, etapa e views da nova');
    verdade(/^[0-9a-f-]{36}$/.test(nova.id), 'id em formato UUID');
    await A.print(page, 'visitante-computador-pronta');
  });

  await rel.etapa('"Ver proposta" da folha abre a página pelo sandbox, com #faixaSandbox', async () => {
    const d = await A.abrirDestino(context, page, () => page.click('#prontaVer'));
    try {
      await A.esperarVisivel(d.pagina, '#proposta', 15000);
      contem(await A.texto(d.pagina, '#pCliente'), 'Teste Visitante', 'capa');
      await A.esperarVisivel(d.pagina, '#faixaSandbox');
      contem(await A.texto(d.pagina, '#faixaSandbox'), 'Modo visitante', '#faixaSandbox');
    } finally { await d.fechar(); }
    if (!(await A.visivel(page, '#folhaPronta'))) await naLista();
    else { await page.click('#prontaVoltar'); await A.esperarVisivel(page, '#vLista'); }
    await aba('propostas');
    contem(await A.texto(page, '#lista'), 'Teste Visitante & Par', 'lista depois de criar');
  });

  // ---------- editar uma da demo ----------
  await rel.etapa('edita uma proposta da demo e a página mostra a versão do sandbox', async () => {
    await naLista(); await aba('propostas');
    await cartao('#lista', 'Cláudia · 50 anos').locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    igual(await page.inputValue('#fCliente'), 'Cláudia · 50 anos', '#fCliente');
    await page.fill('#fLocal', 'Local editado no teste');
    await page.click('#btSalvar');
    await A.esperarToast(page, 'Alterações salvas');
    await page.click('#btVoltar');
    await A.esperarVisivel(page, '#vLista');
    await aba('propostas');
    const c = cartao('#lista', 'Cláudia · 50 anos');
    contem(norm(await c.innerText()), 'Local editado no teste', 'cartão editado');
    const d = await A.abrirDestino(context, page, () => c.locator('a', { hasText: 'Ver proposta' }).first().click());
    try {
      await A.esperarVisivel(d.pagina, '#proposta', 15000);
      contem(await A.texto(d.pagina, '#proposta'), 'Local editado no teste', 'página da proposta');
      await A.esperarVisivel(d.pagina, '#faixaSandbox');
    } finally { await d.fechar(); }
    await naLista();
  });

  // ---------- fechou ----------
  await rel.etapa('"Fechou?" com adicional: total com adicional e faturamento somado', async () => {
    await naLista(); await aba('propostas');
    await cartao('#lista', 'Isabela & Rodrigo').locator('.b-verde').click();
    await A.esperarVisivel(page, '#folhaFechou');
    await page.click('#fxOpcoes button[data-v="completa"]');
    await page.click('#fxPacotes button[data-v="cerimonia_recepcao"]');
    igual(await page.inputValue('#fxValor'), '7.500', 'valor que se preenche sozinho');
    const sug = page.locator('#fxAdicSug button[data-nome="Álbum impresso 30×30"]');
    if (await sug.count() && await sug.first().isVisible()) await sug.first().click();
    else {
      rel.aviso('sem o atalho do adicional em #fxAdicSug: adicionado à mão');
      await page.click('#fxAddAdic');
      const l = page.locator('#fxAdicionais > *').last();
      await l.locator('.x-nome').fill('Álbum impresso 30×30');
      await l.locator('.x-valor').fill('900');
    }
    contem(await A.texto(page, '#fxTotal'), '8.400', '#fxTotal');
    await A.print(page, 'visitante-computador-fechou');
    await page.click('#fxSalvar');
    await A.esperarOculto(page, '#folhaFechou');
    await A.esperarToast(page, '8.400');
    await aba('clientes');
    igual(await A.texto(page, '#rTotal'), A.fmtReais(totalBase + 8400), '#rTotal depois de fechar');
    igual(await A.texto(page, '#rFechadas'), String(fechadas.length + 1), '#rFechadas depois de fechar');
    const p = (await sandbox()).propostas.find(x => x.id === A.idDemo(11));
    igual([p.etapa, p.valor_fechado], ['fechada', 8400], 'etapa e valor no sandbox');
    igual((p.fechamento.adicionais || []).map(a => a.nome), ['Álbum impresso 30×30'], 'adicionais do fechamento');
    igual([p.fechamento.opcao, p.fechamento.pacote, p.fechamento.valor], ['completa', 'cerimonia_recepcao', 7500], 'fechamento');
    verdade(String(p.fechado_em || '').slice(0, 10) === hoje, `fechado_em = hoje (${p.fechado_em})`);
  });

  await rel.etapa('Editar fechamento e Reabrir (o valor sai do total)', async () => {
    await naLista(); await aba('clientes');
    await cartao('#clientes', 'Isabela & Rodrigo').locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    await A.esperarVisivel(page, '#edSituacao');
    contem(await A.texto(page, '#sitTitulo'), '8.400', '#sitTitulo');
    await page.click('#btEditarFech');
    await A.esperarVisivel(page, '#folhaFechou');
    contem(await A.texto(page, '#fxTit'), 'Editar fechamento', '#fxTit');
    igual(await page.locator('#fxAdicionais .x-nome').first().inputValue(), 'Álbum impresso 30×30', 'adicional já preenchido');
    await page.keyboard.press('Escape');
    await A.esperarOculto(page, '#folhaFechou');
    await page.click('#btReabrir');
    await A.esperarToast(page, 'reaberta');
    await A.esperarVisivel(page, '#edFechou');
    await page.click('#btVoltar');
    await A.esperarVisivel(page, '#vLista');
    await aba('clientes');
    igual(await A.texto(page, '#rTotal'), A.fmtReais(totalBase), '#rTotal depois de reabrir');
  });

  await rel.etapa('"Não fechou" com motivo vai para o filtro "Não fechou"', async () => {
    await naLista(); await aba('propostas');
    await cartao('#lista', 'Cláudia · 50 anos').locator('.b-verde').click();
    await A.esperarVisivel(page, '#folhaFechou');
    await page.click('#fxNao');
    await page.locator('#nfMotivos button', { hasText: 'Achou o valor alto' }).first().click();
    await page.click('#nfSalvar');
    await A.esperarOculto(page, '#folhaFechou');
    await A.esperarToast(page, 'Não fechou');
    await page.click('#filtros [data-filtro="perdidas"]');
    contem(await A.texto(page, '#lista'), 'Cláudia · 50 anos', 'filtro Não fechou');
    await page.click('#filtros [data-filtro="abertas"]');
  });

  // ---------- duplicar ----------
  await rel.etapa('duplica uma proposta da demo (entra uma proposta a mais, com as mesmas opções)', async () => {
    await naLista(); await aba('propostas');
    const n0 = (await sandbox()).propostas.length;
    await cartao('#lista', 'Marina & Rafael').locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    await abrirMaisOpcoes();
    await page.click('#edDuplicar');
    await A.dormir(600);
    if ((await sandbox()).propostas.length === n0) {
      // cópia no formulário (como no painel original): falta só o nome do cliente
      await A.esperarVisivel(page, '#vEditor');
      contem((await A.texto(page, '#edTitulo')).toLowerCase(), 'cópia', '#edTitulo');
      igual(await page.inputValue('#fCliente'), '', 'nome em branco na cópia');
      await page.fill('#fCliente', 'Cópia Teste & Par');
      await page.click('#btSalvar');
      await A.esperarVisivel(page, '#folhaPronta');
      await page.click('#prontaVoltar');
    }
    await naLista();
    const sb = await sandbox();
    igual(sb.propostas.length, n0 + 1, 'propostas no sandbox depois de duplicar');
    const orig = sb.propostas.find(p => p.id === A.idDemo(1));
    const copia = sb.propostas.find(p => p.id !== orig.id && /Cópia Teste|\(cópia\)/.test(p.dados.cliente || ''));
    verdade(copia, 'não achei a cópia no sandbox');
    igual(copia.dados.opcoes, orig.dados.opcoes, 'opções da cópia');
    igual([copia.etapa, copia.views], ['aberta', 0], 'etapa e views da cópia');
  });

  // ---------- excluir ----------
  await rel.etapa('proposta fechada não se exclui ("Reabra antes de excluir")', async () => {
    await naLista(); await aba('clientes');
    await cartao('#clientes', 'Beatriz & Thiago').locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    await abrirMaisOpcoes();
    await page.click('#edExcluir');
    await A.esperarToast(page, 'Reabra antes de excluir');
    verdade((await sandbox()).propostas.some(p => p.id === A.idDemo(2)), 'a fechada sumiu do sandbox');
    await naLista();
  });

  await rel.etapa('exclui a proposta criada: some da lista, entra em "removidos" e o link fica indisponível', async () => {
    verdade(slugNovo, 'sem a proposta criada antes');
    await naLista(); await aba('propostas');
    await cartao('#lista', 'Teste Visitante & Par').locator('.abrir').click();
    await A.esperarVisivel(page, '#vEditor');
    await abrirMaisOpcoes();
    await page.click('#edExcluir');
    await A.esperarToast(page, 'excluída');
    await A.esperarVisivel(page, '#vLista');
    await aba('propostas');
    verdade(!(await A.texto(page, '#lista')).includes('Teste Visitante & Par'), 'ainda aparece na lista');
    const sb = await sandbox();
    verdade((sb.removidos || []).includes(slugNovo), 'slug não entrou em removidos');
    verdade(!sb.propostas.some(p => p.slug === slugNovo), 'ainda está no sandbox');
    const p2 = await context.newPage();
    try {
      await p2.goto(`${A.SITE}/proposta/?p=${slugNovo}`, { waitUntil: 'domcontentloaded' });
      await A.esperarVisivel(p2, '#erro', 10000);
    } finally { await p2.close(); }
  });

  await rel.etapa('a frase de adaptação ("…são um exemplo: na sua versão, vêm os seus") aparece para o visitante', async () => {
    verdade(fraseAdaptacao, 'não apareceu nem em Propostas nem no editor');
  });

  // ---------- proposta padrão ----------
  await rel.etapa('edita a proposta padrão pelo cartão e a proposta nova já vem com ela', async () => {
    await naLista(); await aba('propostas');
    const bt = page.locator('#cartaoModelo button, #cartaoModelo a');
    if (await bt.count()) await bt.first().click(); else await page.click('#cartaoModelo');
    await A.esperarVisivel(page, '#vEditor');
    const tit = (await A.texto(page, '#edTitulo')).toLowerCase();
    verdade(/padrão|modelo/.test(tit), `título do editor do modelo: ${tit}`);
    const dicas = norm(await page.locator('.dica-visitante:visible').allInnerTexts().then(x => x.join(' ')));
    contem(dicas, 'proposta padrão', 'dica do editor do modelo');
    await abrirMaisOpcoes();
    const cond = await page.inputValue('#fCondicoes');
    await page.fill('#fCondicoes', cond + '\nCondição de teste do visitante');
    await page.click('#btSalvar');
    await A.esperarVisivel(page, '#vLista');
    await A.esperarToast(page, 'salv');   // "Proposta padrão salva" (o original dizia "Modelo salvo")
    contem((await sandbox()).modelo.condicoes, 'Condição de teste do visitante', 'modelo no sandbox');
    await aba('propostas');
    await page.click('#btNova');
    await A.esperarVisivel(page, '#vEditor');
    contem(await page.inputValue('#fCondicoes'), 'Condição de teste do visitante', 'proposta nova partindo do modelo');
    await page.click('#btVoltar');
    await A.esperarVisivel(page, '#vLista');
  });

  // ---------- recomeçar e sair ----------
  await rel.etapa('"Recomeçar" apaga tudo o que o visitante fez e recarrega os dados de exemplo', async () => {
    await naLista();
    await page.click('#btRecomecar');
    await page.waitForFunction(n => {
      try {
        const s = JSON.parse(localStorage.getItem('rk_demo_sandbox_v1') || 'null');
        return !!(s && s.propostas && s.propostas.length === n && !(s.removidos || []).length && !/Condição de teste/.test(s.modelo && s.modelo.condicoes || ''));
      } catch (e) { return false; }
    }, antes.length, { timeout: 12000 });
    const sb = await sandbox();
    const p11 = sb.propostas.find(p => p.id === A.idDemo(11)), p12 = sb.propostas.find(p => p.id === A.idDemo(12));
    igual(p11.etapa, 'aberta', 'Isabela voltou a ficar em aberto');
    igual([p12.etapa, p12.dados.local], ['aberta', porId(A.idDemo(12)).dados.local], 'Cláudia voltou ao original');
    if (await A.visivel(page, '#folhaGuia')) await page.click('#guiaComecar');
    await A.esperarVisivel(page, '#vLista');
    await aba('clientes');
    igual(await A.texto(page, '#rTotal'), A.fmtReais(totalBase), '#rTotal depois de recomeçar');
  });

  await rel.etapa('"Sair" volta ao login e apaga sandbox e sessão', async () => {
    await naLista();
    await page.click('#btSair');
    await A.esperarVisivel(page, '#vLogin');
    igual(await A.lerLS(page, 'rk_demo_sandbox_v1'), null, 'rk_demo_sandbox_v1');
    igual(await A.lerLS(page, 'rk_painel_sessao'), null, 'rk_painel_sessao');
  });

  await rel.etapa('entrar de novo digitando " Visitante " no campo de senha', async () => {
    await page.fill('#senha', ' Visitante ');
    await page.click('#btEntrar');
    await A.esperarVisivel(page, '#vLista', 15000);
    igual((await A.lerJsonLS(page, 'rk_painel_sessao') || {}).papel, 'visitante', 'papel');
    await A.dormir(800);
    if (await A.visivel(page, '#folhaGuia')) { rel.aviso('o guia apareceu de novo na 2ª entrada (rk_demo_guia_visto já era "1")'); await page.click('#guiaComecar'); }
    await page.click('#btSair');
    await A.esperarVisivel(page, '#vLogin');
  });

  // ---------- celular ----------
  const cel = await A.novoContexto(browser, { celular: true });
  const redeCel = A.gravarRedeApi(cel);
  const vigCel = A.vigiar(cel);
  const pc = await cel.newPage();
  await rel.etapa('celular (375 px): guia, agenda, propostas, "Fechou?" e editor sem rolar para o lado', async () => {
    rel.pagina = pc;
    await pc.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(pc, '#vLogin');
    await A.semRolagemLateral(pc);
    await A.print(pc, 'visitante-celular-login');
    await pc.fill('#senha', 'visitante');
    await pc.click('#btEntrar');
    await A.esperarVisivel(pc, '#vLista', 15000);
    await A.esperarVisivel(pc, '#folhaGuia', 6000);
    await A.print(pc, 'visitante-celular-guia');
    await pc.click('#guiaComecar');
    await A.esperarOculto(pc, '#folhaGuia');
    await A.semRolagemLateral(pc);
    await A.print(pc, 'visitante-celular-agenda', { fullPage: true });
    await pc.click('#abas [data-aba="propostas"]');
    await A.esperarVisivel(pc, '#abaPropostas');
    await pc.waitForFunction(() => document.querySelectorAll('#lista .pcard').length > 0, null, { timeout: 8000 });
    await A.semRolagemLateral(pc);
    await A.print(pc, 'visitante-celular-propostas', { fullPage: true });
    await pc.locator('#lista .pcard').filter({ hasText: 'Marina & Rafael' }).first().locator('.b-verde').click();
    await A.esperarVisivel(pc, '#folhaFechou');
    await A.print(pc, 'visitante-celular-fechou');
    await pc.keyboard.press('Escape');
    await A.esperarOculto(pc, '#folhaFechou');
    await pc.click('#btNova');
    await A.esperarVisivel(pc, '#vEditor');
    await A.semRolagemLateral(pc);
    await A.print(pc, 'visitante-celular-editor');
    await pc.click('#btVoltar');
    await A.esperarVisivel(pc, '#vLista');
    await pc.click('#abas [data-aba="clientes"]');
    await A.esperarVisivel(pc, '#abaClientes');
    await A.semRolagemLateral(pc);
    await A.print(pc, 'visitante-celular-clientes', { fullPage: true });
    await pc.click('#btSair');
    await A.esperarVisivel(pc, '#vLogin');
  });
  rel.pagina = page;

  // ---------- rede, banco e console ----------
  await rel.etapa('rede: o visitante só fez GET, OPTIONS e POST /login para a API', async () => {
    const todas = rede.concat(redeCel);
    verdade(todas.some(r => r.metodo === 'GET' && r.caminho === '/admin/propostas'), 'o sandbox não buscou GET /admin/propostas');
    verdade(todas.some(r => r.metodo === 'POST' && r.caminho === '/login'), 'não houve POST /login');
    const fora = todas.filter(r => r.host === A.HOST_API_PUBLICADA);
    igual(fora, [], 'requisições para a API publicada (deviam ir para a local)');
    const proibidas = todas.filter(r => !(r.metodo === 'GET' || r.metodo === 'OPTIONS' || (r.metodo === 'POST' && r.caminho === '/login')));
    igual(proibidas, [], 'requisições de escrita do visitante');
    const cont = {};
    todas.forEach(r => { const k = `${r.metodo} ${r.caminho.replace(/\/[0-9a-f-]{36}/, '/:id').replace(/\/p\/[a-z0-9-]+/, '/p/:slug')}`; cont[k] = (cont[k] || 0) + 1; });
    console.log('          requisições: ' + Object.entries(cont).map(([k, n]) => `${k} ×${n}`).join(' · '));
  });

  await rel.etapa('banco igual antes e depois (GET /admin/propostas com token de admin)', async () => {
    const depois = await ctx.listar(tokenAdmin);
    igual(A.diferencasBanco(antes, depois), [], 'diferenças no banco');
    igual(depois, antes, 'lista do banco');
  });

  await rel.etapa('zero erros de console e de rede nas páginas', async () => {
    const erros = vig.erros.concat(vigCel.erros);
    vig.avisos.concat(vigCel.avisos).forEach(a => rel.aviso(a));
    igual(erros, [], 'erros');
  });
  if (context._dialogos.length) console.log('          confirmações aceitas: ' + context._dialogos.join(' | ').replace(/\s+/g, ' ').slice(0, 400));

  await cel.close();
  await context.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
