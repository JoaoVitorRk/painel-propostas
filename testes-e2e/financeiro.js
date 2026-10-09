'use strict';
// Roteiro ponta a ponta do FINANCEIRO no modo visitante (ESPEC §8.1).
//   node testes-e2e/rodar-tudo.js financeiro
//
// O que prova:
//   - a aba Financeiro abre com os números certos da demo (a receber, atrasado), a dica do visitante e o atrasado da #02;
//   - "Recebi" no atrasado tira ele dos atrasados e soma no "recebido", sem sair da aba;
//   - cartões de Clientes mostram "Tudo recebido" (#03, pagou adiantado) e o sinal pendente (#08);
//   - "Fechou?" numa proposta em aberto já traz o sinal (10%) e o restante (5 dias antes do evento) e entra no "a receber";
//   - nada vai para o servidor (só GET, OPTIONS e POST /login) e o banco termina igual; zero erros de console.

const A = require('./ambiente');
const { verdade, igual, contem } = A;

async function rodar(ctx) {
  const rel = new A.Relatorio('financeiro');
  console.log('\nFinanceiro (visitante: sinal, restante, a receber)');

  const tokenAdmin = await ctx.loginAdmin();
  const antes = await ctx.listar(tokenAdmin);
  const hoje = A.hojeBr();
  const reais = v => A.fmtReais(v);
  const pend = [];
  antes.filter(p => p.etapa === 'fechada').forEach(p => ((p.fechamento && p.fechamento.pagamentos) || []).forEach(pg => { if (!pg.pago_em) pend.push(pg); }));
  const soma = l => Math.round(l.reduce((s, x) => s + x.valor, 0) * 100) / 100;
  const aReceber = soma(pend), atrasado = soma(pend.filter(x => x.vence_em && x.vence_em < hoje));

  await rel.etapa('a demo tem pagamentos em todos os fechados, com um atrasado (#02)', async () => {
    const fech = antes.filter(p => p.etapa === 'fechada');
    igual(fech.filter(p => !(p.fechamento.pagamentos || []).length).map(p => p.dados.cliente), [], 'fechados sem pagamentos');
    const p2 = antes.find(p => p.id === A.idDemo(2)), r2 = p2.fechamento.pagamentos.find(x => x.tipo === 'restante');
    igual([r2.vence_em, r2.pago_em], [A.maisDias(hoje, -3), ''], '#02 restante venceu há 3 dias');
    verdade(atrasado > 0 && aReceber > atrasado, 'a receber e atrasado');
  }, { critica: true });

  const context = await A.novoContexto(ctx.browser, { celular: true });
  const rede = A.gravarRedeApi(context);
  const vig = A.vigiar(context);
  const page = await context.newPage();
  rel.pagina = page;
  page.on('dialog', d => d.accept());
  const aba = async nome => { await page.click(`#abas [data-aba="${nome}"]`); await A.esperarVisivel(page, '#aba' + nome.charAt(0).toUpperCase() + nome.slice(1)); };

  await rel.etapa('entra como visitante e acha a aba Financeiro', async () => {
    await page.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#btVisitante');
    await page.click('#btVisitante');
    await A.esperarVisivel(page, '#vLista', 15000);
    if (await A.visivel(page, '#folhaGuia')) { await page.click('#guiaComecar'); await A.esperarOculto(page, '#folhaGuia'); }
    igual(await page.evaluate(() => [...document.querySelectorAll('#abas [data-aba]')].map(b => b.textContent)), ['Hoje', 'Agenda', 'Contatos', 'Propostas', 'Clientes', 'Financeiro'], 'abas');
    await A.semRolagemLateral(page);
    await aba('financeiro');
  }, { critica: true });

  await rel.etapa('números da demo, dica do visitante e o atrasado em destaque', async () => {
    igual([await A.texto(page, '#fReceber'), await A.texto(page, '#fAtrasado')], [reais(aReceber), reais(atrasado)], 'a receber e atrasado');
    verdade(!(await page.evaluate(() => document.getElementById('fAtrasadoCx').classList.contains('zero'))), 'atrasado aceso');
    verdade(await page.locator('.dica-visitante[data-dica="financeiro"]:visible').count() === 1, 'dica do financeiro');
    const at = page.locator('#financeiro .pagto.atrasado').first();
    contem(A.norm(await at.innerText()), 'Beatriz & Thiago', 'atrasado');
    contem(A.norm(await at.innerText()), 'há 3 dias', 'atrasado');
    contem((await A.texto(page, '#financeiro')).toLowerCase(), 'mês a mês', 'mês a mês (o título vem em maiúsculas pelo CSS)');
    await A.print(page, 'financeiro-celular');
    await A.print(page, 'financeiro-celular-inteira', { fullPage: true });
  });

  await rel.etapa('"Recebi" no atrasado: some dos atrasados e entra no recebido, sem sair da aba', async () => {
    await page.locator('#financeiro .pagto.atrasado .lado .b').first().click();
    await A.esperarVisivel(page, '#folhaRecebi');
    contem(await A.texto(page, '#rcQuem'), 'Restante de Beatriz & Thiago', 'folha Recebi');
    igual(await page.inputValue('#rcData'), hoje, 'data de hoje');
    await page.click('#rcSalvar');
    await A.esperarOculto(page, '#folhaRecebi');
    await A.esperarToast(page, 'Restante recebido');
    verdade(await A.visivel(page, '#abaFinanceiro'), 'continua no Financeiro');
    igual([await A.texto(page, '#fAtrasado'), await A.texto(page, '#fReceber')], [reais(0), reais(aReceber - atrasado)], 'depois do Recebi');
    igual(await page.locator('#financeiro .pagto.atrasado').count(), 0, 'sem atrasados');
  });

  await rel.etapa('cartões de Clientes: "Tudo recebido" (#03) e o sinal pendente (#08)', async () => {
    await aba('clientes');
    const c = nome => page.locator('#clientes .pcard').filter({ hasText: nome }).first();
    contem(A.norm(await c('Formatura Medicina').innerText()), 'Tudo recebido', '#03');
    const t8 = A.norm(await c('Aline & Bruno').innerText());
    contem(t8, 'sinal vence ' + A.maisDias(hoje, 3).split('-').reverse().join('/'), '#08');
  });

  await rel.etapa('"Fechou?" de uma proposta em aberto traz o sinal e o restante e entra no "a receber"', async () => {
    const antesReceber = aReceber - atrasado;
    await aba('propostas');
    const card = page.locator('#lista .pcard').filter({ hasText: 'Isabela & Rodrigo' }).first();
    await card.locator('.b-verde').click();
    await A.esperarVisivel(page, '#folhaFechou');
    await page.locator('#fxOpcoes button').first().click();
    if (!(await page.locator('#fxPacotes [aria-pressed="true"]').count())) await page.locator('#fxPacotes button').first().click();
    const total = A.norm(await page.inputValue('#fxValor')).replace(/\./g, '').replace(',', '.') * 1;
    verdade(total > 0, 'valor da opção');
    igual(await page.inputValue('#fxSinalValor'), A.fmtNum(Math.round(total / 10)), 'sinal automático de 10%');
    igual(await page.isChecked('#fxSinalPago'), true, 'sinal recebido por padrão');
    const evento = (await ctx.listar(tokenAdmin)).find(p => p.dados.cliente === 'Isabela & Rodrigo').dados.data;
    igual(await page.inputValue('#fxRestanteVence'), A.maisDias(evento, -5), 'restante 5 dias antes do evento');
    await A.print(page, 'financeiro-fechou');
    await page.click('#fxSalvar');
    await A.esperarOculto(page, '#folhaFechou');
    await aba('financeiro');
    igual(await A.texto(page, '#fReceber'), reais(antesReceber + (total - Math.round(total / 10))), 'a receber com o restante novo');
  });

  await rel.etapa('nada foi para o servidor e o banco está igual; zero erros', async () => {
    const escrita = rede.filter(r => !(r.metodo === 'GET' || r.metodo === 'OPTIONS' || (r.metodo === 'POST' && r.caminho === '/login')));
    igual(escrita, [], 'requisições que gravariam');
    const depois = await ctx.listar(tokenAdmin);
    igual(A.diferencasBanco(antes, depois), [], 'diferenças no banco');
    igual(vig.erros, [], 'erros no navegador');
  });

  await context.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
