'use strict';
// Roteiro ponta a ponta da PÁGINA DA PROPOSTA (o que o cliente recebe) — ESPEC §6, §7, §9 e §10.
//   node testes-e2e/proposta.js        (sobe API 8792 + site 8126 do zero, roda e encerra tudo)
//
// O que prova (sem login, como um cliente):
//   - proposta/?p=exemplo abre com a faixa #faixaModelo ("Quero a minha" em #faixaModeloCta) e as .nota-modelo;
//   - as opções saem na ordem do modelo (§7: Premium, Completa, Essencial), com os rótulos de dados.rotulos e os
//     valores de cada modo (Premium só "Evento + ensaio"; Completa e Essencial os dois), a sugestão na Completa,
//     "Ver a próxima opção";
//   - inclui, adicionais, condições, validade, resumo e recado;
//   - todo botão de WhatsApp abre a folha #folhaWa com a mensagem que iria para o prestador (#folhaWaMsg) e o CTA da RK
//     (#folhaWaRk → wa.me/5542999246208 com o texto da ESPEC §6.3), sem abrir o WhatsApp nem outra aba;
//   - os cards de vídeo abrem #folhaVideo; nenhum dado da cliente de origem nem número que pareça real;
//   - proposta vencida troca os botões por "Pedir atualizada"; sem ?p mostra o exemplo; rascunho e link inexistente
//     ficam indisponíveis (#erro), e o botão do erro também abre a folha;
//   - celular (375 px) sem rolagem lateral; prints de celular e computador em testes-e2e/prints/; zero erros de console.
//
// SUPOSIÇÕES (escritas antes de a página ficar pronta; numa rodada prévia em 06/10/2026, contra as versões em andamento, todas valeram):
//   1. Os rótulos dos preços vêm de dados.rotulos (no modelo, "Evento" e "Evento + ensaio"; proposta sem rótulos
//      lê "Cerimônia" e "Cerimônia + recepção"); os cards de opção mostram "Opção 1/2/3" em .op-ord e
//      "Quero esta opção" em .op-cta; o título diz "Três opções".
//   2. Mensagens do WhatsApp no formato de hoje, trocando só o nome da marca:
//      "Oi, <marca>! Vi a proposta (<cliente> · <data longa>) e quero reservar a minha data." / "… com a opção Completa." /
//      "… e fiquei com uma dúvida:" / vencida: "… mas ela já expirou …".
//   3. #folhaWa e #folhaVideo usam hidden (ou display none) quando fechadas e ficam fora de #proposta
//      (a folha também precisa abrir no estado de erro).
//   4. O botão flutuante #waFloat aparece ao rolar até os vídeos (some na capa, no investimento e nos depoimentos).
//   5. Os cards de vídeo são #secVideos .card (ou #secVideos article).
//   6. A frase "Página modelo criada pela RK Performance" fica no fecho ou no rodapé.

const A = require('./ambiente');
const { verdade, igual, contem, norm } = A;
const auditoria = require('./auditoria');

const TEXTO_RK = 'Oi, João! Vi a página modelo de proposta da RK e quero uma assim para o meu trabalho.';
const linhas = v => String(v || '').split('\n').map(x => x.replace(/^[-–•✦\s]+/, '').trim()).filter(Boolean);

async function rodar(ctx) {
  const rel = new A.Relatorio('proposta');
  console.log('\nPágina da proposta (cliente, sem login)');

  const token = await ctx.loginAdmin();
  const ex = (await ctx.apiReq('GET', '/admin/p/exemplo', { token })).json;   // prévia: não conta abertura
  const venc = (await ctx.apiReq('GET', '/admin/p/convencao-prisma-2027', { token })).json;

  await rel.etapa('a proposta de exemplo segue o modelo §7 e a demo §8', async () => {
    verdade(ex && ex.dados, 'GET /admin/p/exemplo não trouxe a proposta');
    const d = ex.dados, o = d.opcoes;
    igual(d.ordem, ['completa', 'media', 'simples'], 'ordem');
    igual(['completa', 'media', 'simples'].map(k => [o[k].on, o[k].nome, o[k].cerimonia, o[k].cerimonia_recepcao, o[k].ver_cerimonia, o[k].ver_recepcao]),
      [[true, 'Premium', 6800, 7500, false, true], [true, 'Completa', 4200, 4900, true, true], [true, 'Essencial', 2400, 3100, true, true]], 'opções');
    igual(d.rotulos, { pacote_a: 'Evento', pacote_b: 'Evento + ensaio', nota_b: 'Inclui um ensaio fotográfico antes do evento, no lugar que vocês escolherem' }, 'rótulos');
    igual([d.cliente, d.tipo, d.sugestao, d.hora, d.local], ['Marina & Rafael', 'Casamento', 'media', '16:00', 'Capela do Bosque · Campinas'], 'campos do exemplo');
    igual([d.data, d.validade], [A.sab(230), A.maisDias(A.hojeBr(), 21)], 'data e validade do exemplo');
    verdade(String(d.mensagem || '').trim().length > 10, 'o exemplo não tem recado');
    verdade(venc && venc.dados && venc.dados.validade < A.hojeBr(), 'a proposta 14 (Convenção Prisma 2027) devia estar vencida');
  }, { critica: true });

  const browser = ctx.browser;
  const p404 = (u, s) => s === 404 && /^\/p\/(sofia-e-daniel|nao-existe-e2e)$/.test(new URL(u).pathname);
  const context = await A.novoContexto(browser);
  const vig = A.vigiar(context, { permitir: p404 });
  const whats = [];
  context.on('request', r => { if (/wa\.me|whatsapp\.com/.test(r.url())) whats.push(r.url()); });
  const page = await context.newPage();
  rel.pagina = page;

  // abre a folha do WhatsApp por um botão e confere mensagem + CTA da RK; fecha no fim
  async function conferirFolhaWa(pg, seletor, trechos, nomePrint) {
    const abas0 = pg.context().pages().length;
    const bt = pg.locator(seletor).first();
    await bt.scrollIntoViewIfNeeded();
    await bt.click();
    await A.esperarVisivel(pg, '#folhaWa', 5000);
    const msg = await A.texto(pg, '#folhaWaMsg');
    verdade(/^[“"']?Oi, /.test(msg), `a mensagem devia começar com "Oi, <marca>!": ${msg}`);
    for (const t of trechos) contem(msg, t, `mensagem de ${seletor}`);
    igual(auditoria.termosNoTexto(msg), [], 'termos proibidos na mensagem');
    contem(await A.texto(pg, '#folhaWa'), 'Na proposta de verdade', '#folhaWa');
    const href = await pg.locator('#folhaWaRk').getAttribute('href');
    verdade(String(href).startsWith(`https://wa.me/${A.WA_RK}?text=`), `#folhaWaRk: ${href}`);
    igual(decodeURIComponent(String(href).split('?text=')[1].replace(/\+/g, ' ')), TEXTO_RK, 'texto do CTA da RK');
    contem((await A.texto(pg, '#folhaWaRk')).toLowerCase(), 'quero uma página assim', '#folhaWaRk');   // o CSS põe em maiúsculas
    if (nomePrint) await A.print(pg, nomePrint);
    igual(pg.context().pages().length, abas0, 'o botão abriu outra aba');
    await pg.click('#folhaWaFechar');
    await A.esperarOculto(pg, '#folhaWa');
    return msg;
  }

  await rel.etapa('abre proposta/?p=exemplo sem login', async () => {
    await page.goto(A.SITE + '/proposta/?p=exemplo', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#proposta', 15000);
    verdade(!(await A.visivel(page, '#carregando')), '#carregando continua visível');
    const capa = await A.texto(page, '#pCliente');
    contem(capa, 'Marina', 'capa'); contem(capa, 'Rafael', 'capa');
    verdade(!(await A.visivel(page, '#faixaSandbox')), '#faixaSandbox para um cliente');
    verdade(!(await A.visivel(page, '#previa')), '#previa para um cliente');
    const titulo = await page.title();
    if (!/RK Performance/.test(titulo)) rel.aviso(`o título da aba não cita a RK Performance: "${titulo}"`);
    const robots = await page.$eval('meta[name="robots"]', m => m.getAttribute('content')).catch(() => '');
    verdade(/noindex/.test(robots || ''), 'falta <meta name="robots" content="noindex">');
  }, { critica: true });

  await rel.etapa('faixa "Página modelo" no topo com "Quero a minha"', async () => {
    await A.esperarVisivel(page, '#faixaModelo');
    const t = await A.texto(page, '#faixaModelo');
    contem(t, 'Página modelo', '#faixaModelo'); contem(t, 'exemplo fictício', '#faixaModelo');
    await A.esperarVisivel(page, '#faixaModeloCta');
    contem((await A.texto(page, '#faixaModeloCta')).toLowerCase(), 'quero a minha', '#faixaModeloCta');   // o CSS põe em maiúsculas
  });

  await rel.etapa('notas de modelo nas seções', async () => {
    const notas = await page.locator('.nota-modelo').allInnerTexts();
    verdade(notas.length >= 4, `só ${notas.length} .nota-modelo`);
    const t = norm(notas.join(' | ')).toLowerCase();
    for (const x of ['sua foto', 'seus trabalhos', 'depoimentos de exemplo', 'entregáveis de exemplo']) contem(t, x, '.nota-modelo');
    contem(norm(await page.locator('body').innerText()).toLowerCase(), 'página modelo criada pela rk performance', 'fecho/rodapé');
  });

  await rel.etapa('opções na ordem do modelo, com os rótulos e valores de cada modo', async () => {
    const cards = await page.$$eval('#pOpcoes .opcao', els => els.map(e => {
      const t = s => (e.querySelector(s) || { textContent: '' }).textContent.replace(/\s+/g, ' ').trim();
      return {
        k: e.getAttribute('data-k'), ord: t('.op-ord'), nome: t('.op-nome'), sug: e.classList.contains('sugestao'), cta: t('.op-cta'),
        rots: Array.from(e.querySelectorAll('.preco .rot')).map(x => x.textContent.trim()),
        nums: Array.from(e.querySelectorAll('.preco .num')).map(x => x.textContent.replace(/[  ]/g, ' ').trim()),
      };
    }));
    igual(cards.map(c => c.k), ['completa', 'media', 'simples'], 'ordem dos cards (data-k)');
    igual(cards.map(c => c.ord), ['Opção 1', 'Opção 2', 'Opção 3'], '.op-ord');
    igual(cards.map(c => c.nome), ['Premium', 'Completa', 'Essencial'], '.op-nome');
    // esperado a partir dos dados (Junto = só o pacote B; Separado = os dois; "Só <pacote A>" = só o pacote A),
    // com os nomes dos pacotes vindos de dados.rotulos
    const o = ex.dados.opcoes, rot = ex.dados.rotulos || { pacote_a: 'Cerimônia', pacote_b: 'Cerimônia + recepção' };
    const esp = ex.dados.ordem.filter(k => o[k].on).map(k => {
      const r = [];
      if (o[k].ver_cerimonia && o[k].cerimonia > 0) r.push([rot.pacote_a, A.fmtNum(o[k].cerimonia)]);
      if (o[k].ver_recepcao && o[k].cerimonia_recepcao > 0) r.push([rot.pacote_b, A.fmtNum(o[k].cerimonia_recepcao)]);
      return r;
    });
    igual(cards.map(c => c.rots), esp.map(r => r.map(x => x[0])), '.preco .rot');
    igual(cards.map(c => c.nums), esp.map(r => r.map(x => x[1])), '.preco .num');
    igual(cards.map(c => c.rots), [['Evento + ensaio'], ['Evento', 'Evento + ensaio'], ['Evento', 'Evento + ensaio']], 'rótulos (ESPEC §7)');
    igual(cards.map(c => c.nums), [['7.500'], ['4.200', '4.900'], ['2.400', '3.100']], 'valores (ESPEC §7)');
    igual(cards.map(c => c.sug), [false, true, false], 'sugestão na Completa');
    cards.forEach(c => contem(c.cta, 'Quero esta opção', `.op-cta de ${c.nome}`));
    igual(await page.locator('#pOpcoes .op-prox').count(), 2, '.op-prox');
    contem((await A.texto(page, '#pOpcoesTitulo')).toLowerCase(), 'três opções', '#pOpcoesTitulo');   // o CSS põe em maiúsculas
  });

  await rel.etapa('inclui, adicionais, condições, validade, resumo e recado', async () => {
    const d = ex.dados;
    igual((await page.locator('#pInclui li').allInnerTexts()).map(norm), linhas(d.inclui), '#pInclui');
    igual((await page.locator('#pCond li').allInnerTexts()).map(norm), linhas(d.condicoes), '#pCond');
    const adic = await A.texto(page, '#pAdic');
    for (const x of ['Álbum impresso 30×30', '900', 'Imagens de drone', 'Segundo videomaker', 'Entrega expressa em 7 dias']) contem(adic, x, '#pAdic');
    const dl = await page.evaluate(iso => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z')), d.validade);
    contem(await A.texto(page, '#pValidade'), 'válida até ' + dl, '#pValidade');
    const resumo = await A.texto(page, '#pResumo');
    contem(resumo, 'Marina & Rafael', '#pResumo'); contem(resumo, 'Capela do Bosque', '#pResumo');
    contem(await A.texto(page, '#pMensagem'), norm(d.mensagem).slice(0, 25), '#pMensagem');
    await A.esperarVisivel(page, '#secVideos');
    await A.esperarVisivel(page, '#secDepoimentos');
    contem((await A.texto(page, '#secDepoimentos')).toLowerCase(), 'exemplo', 'depoimentos sem o selo de exemplo');
  });

  await rel.etapa('"Ver a próxima opção" leva até a opção seguinte', async () => {
    const bt = page.locator('#pOpcoes .op-prox').first();
    await bt.scrollIntoViewIfNeeded();
    await bt.click();
    await page.waitForFunction(() => {
      const c = document.querySelectorAll('#pOpcoes .opcao')[1];
      if (!c) return false;
      const r = c.getBoundingClientRect();
      return r.top < innerHeight * 0.6 && r.bottom > innerHeight * 0.2;
    }, null, { timeout: 5000 });
  });

  await rel.etapa('WhatsApp na demonstração: cada botão abre a folha com a mensagem certa e o CTA da RK', async () => {
    const dl = await page.evaluate(iso => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z')), ex.dados.data);
    const ref = `Vi a proposta (Marina & Rafael · ${dl})`;
    await conferirFolhaWa(page, '#waReservar', [ref, 'quero reservar a minha data'], 'proposta-computador-folha-wa');
    await conferirFolhaWa(page, '#waDuvida', [ref, 'fiquei com uma dúvida']);
    await conferirFolhaWa(page, '#pOpcoes .opcao[data-k="media"] .op-cta', [ref, 'quero reservar com a opção Completa']);
    await conferirFolhaWa(page, '#pOpcoes .opcao[data-k="completa"] .op-cta', [ref, 'quero reservar com a opção Premium']);
    igual(whats, [], 'requisições para o WhatsApp');
  });

  await rel.etapa('"Quero a minha" e o botão flutuante também levam ao CTA da RK', async () => {
    await page.evaluate(() => scrollTo(0, 0));
    const href = await page.locator('#faixaModeloCta').getAttribute('href');
    if (!/wa\.me\/5542999246208/.test(href || '')) {
      await page.click('#faixaModeloCta');
      await A.esperarVisivel(page, '#folhaWa', 5000);
      await page.click('#folhaWaFechar');
      await A.esperarOculto(page, '#folhaWa');
    }
    await page.locator('#secVideos').scrollIntoViewIfNeeded();
    await A.dormir(700);
    if (await A.visivel(page, '#waFloat')) {
      const box = await page.locator('#waFloat').boundingBox();
      const naTela = box && box.y < 860 && box.y + box.height > 0;
      const opaco = await page.locator('#waFloat').evaluate(e => getComputedStyle(e).opacity !== '0' && getComputedStyle(e).visibility !== 'hidden');
      if (naTela && opaco) await conferirFolhaWa(page, '#waFloat', ['quero reservar a minha data']);
      else rel.aviso('o botão flutuante não estava visível ao rolar até os vídeos');
    } else rel.aviso('o botão flutuante (#waFloat) não apareceu ao rolar até os vídeos');
    igual(whats, [], 'requisições para o WhatsApp');
  });

  await rel.etapa('vídeos: tocar num card abre a folha "Na sua versão…"', async () => {
    const card = page.locator('#secVideos .card, #secVideos article').first();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    await A.esperarVisivel(page, '#folhaVideo', 5000);
    contem(await A.texto(page, '#folhaVideo'), 'Na sua versão', '#folhaVideo');
    await page.click('#folhaVideoFechar');
    await A.esperarOculto(page, '#folhaVideo');
  });

  await rel.etapa('nenhum dado da cliente de origem nem número que pareça real', async () => {
    const corpo = await page.locator('body').innerText();
    igual(auditoria.termosNoTexto(corpo), [], 'termos proibidos no texto da página');
    igual(auditoria.termosNoTexto(await page.content()), [], 'termos proibidos no HTML da página');
    verdade(!/casamentos\.com\.br/i.test(corpo), 'selo "casamentos.com.br" na página');
  });

  await rel.etapa('computador: print da página inteira', async () => {
    await A.rolarTudo(page);
    await A.semRolagemLateral(page);
    await A.print(page, 'proposta-computador', { fullPage: true });
  });

  await rel.etapa('proposta vencida: botões viram "Pedir atualizada"', async () => {
    await page.goto(A.SITE + '/proposta/?p=convencao-prisma-2027', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#proposta', 15000);
    contem((await A.texto(page, '#pValidade')).toLowerCase(), 'expirou', '#pValidade');
    const ctas = (await page.locator('#pOpcoes .op-cta').allInnerTexts()).map(t => norm(t).toLowerCase());   // o CSS põe em maiúsculas
    verdade(ctas.length > 0 && ctas.every(t => t.includes('pedir atualizada')), `.op-cta: ${ctas.join(' | ')}`);
    await conferirFolhaWa(page, '#waReservar', ['já expirou']);
  });

  await rel.etapa('sem ?p a página mostra a proposta de exemplo', async () => {
    await page.goto(A.SITE + '/proposta/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#proposta', 15000);
    contem(await A.texto(page, '#pCliente'), 'Marina', 'capa');
  });

  await rel.etapa('rascunho e link inexistente ficam indisponíveis; o botão do erro abre a folha', async () => {
    for (const slug of ['sofia-e-daniel', 'nao-existe-e2e']) {
      await page.goto(`${A.SITE}/proposta/?p=${slug}`, { waitUntil: 'domcontentloaded' });
      await A.esperarVisivel(page, '#erro', 12000);
      verdade(!(await A.visivel(page, '#proposta')), `#proposta visível para ${slug}`);
    }
    await page.click('#erroWa');
    await A.esperarVisivel(page, '#folhaWa', 5000);
    const href = await page.locator('#folhaWaRk').getAttribute('href');
    verdade(String(href).startsWith(`https://wa.me/${A.WA_RK}?text=`), `#folhaWaRk no erro: ${href}`);
    await page.click('#folhaWaFechar');
    await A.esperarOculto(page, '#folhaWa');
    igual(whats, [], 'requisições para o WhatsApp');
  });

  // ---------- celular ----------
  const cel = await A.novoContexto(browser, { celular: true });
  const vigCel = A.vigiar(cel, { permitir: p404 });
  const pc = await cel.newPage();
  await rel.etapa('celular (375 px): sem rolagem lateral; prints da capa, da página inteira e da folha', async () => {
    rel.pagina = pc;
    await pc.goto(A.SITE + '/proposta/?p=exemplo', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(pc, '#proposta', 15000);
    await A.dormir(600);
    await A.print(pc, 'proposta-celular-capa');
    await A.rolarTudo(pc);
    await A.semRolagemLateral(pc);
    const direita = await pc.$$eval('#pOpcoes .opcao, .folha, section', els => Math.max(0, ...els.map(e => e.getBoundingClientRect().right)));
    verdade(direita <= 376, `algum bloco passa da largura da tela (direita = ${direita})`);
    await A.print(pc, 'proposta-celular', { fullPage: true });
    await conferirFolhaWa(pc, '#waReservar', ['quero reservar a minha data'], 'proposta-celular-folha-wa');
    await A.semRolagemLateral(pc);
  });
  rel.pagina = page;

  await rel.etapa('zero erros de console e de rede nas páginas', async () => {
    vig.avisos.concat(vigCel.avisos).forEach(a => rel.aviso(a));
    igual(vig.erros.concat(vigCel.erros), [], 'erros');
  });

  await cel.close();
  await context.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
