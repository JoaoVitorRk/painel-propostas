'use strict';
// Roteiro ponta a ponta da aba HOJE no modo visitante (ESPEC §8.2).
//   node testes-e2e/rodar-tudo.js hoje
//
// O que prova:
//   - o painel abre na aba Hoje (6 abas), com a dica do visitante e a saudação sem nome;
//   - os números e as 5 listas do dia (com os lembretes dos contatos) batem com os dados da demo (calculados aqui a partir da API, pela mesma regra);
//   - o mês: funil, vendido × eventos do mês e comparação; setas e "Voltar para este mês";
//   - "Recebi" pela aba Hoje fica na aba e tira o pagamento da semana;
//   - no celular as abas deslizam sem a página rolar para o lado; no computador cabem as 6;
//   - nada vai para o servidor (só GET, OPTIONS e POST /login) e o banco termina igual; zero erros.

const A = require('./ambiente');
const { verdade, igual, contem } = A;

async function rodar(ctx) {
  const rel = new A.Relatorio('hoje');
  console.log('\nHoje (visitante: o dia e o mês de relance)');

  const tokenAdmin = await ctx.loginAdmin();
  const antes = await ctx.listar(tokenAdmin);
  const hoje = A.hojeBr(), fim = A.maisDias(hoje, 6), mes = hoje.slice(0, 7);
  const diaBr = s => new Date(s).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });   // AAAA-MM-DD em Brasília
  const dias = s => Math.round((Date.parse(hoje + 'T12:00:00Z') - Date.parse(diaBr(s) + 'T12:00:00Z')) / 864e5);
  const fechadas = antes.filter(p => p.etapa === 'fechada');
  const semana = fechadas.filter(p => p.dados.data && p.dados.data >= hoje && p.dados.data <= fim);
  const pags = [];
  fechadas.forEach(p => (p.fechamento.pagamentos || []).forEach(pg => { if (pg.valor > 0 && !pg.pago_em && pg.vence_em && pg.vence_em <= fim) pags.push(pg); }));
  const abertas = antes.filter(p => p.etapa === 'aberta' && p.status === 'publicada');
  const chamar = abertas.filter(p => p.views > 0 && p.primeira_vista && dias(p.primeira_vista) >= 3);
  const naoAbriram = abertas.filter(p => !p.views);
  const lembretes = (await ctx.listarContatos(tokenAdmin)).filter(c => c.lembrete_em && c.lembrete_em <= hoje);
  const soma = l => Math.round(l.reduce((s, x) => s + x.valor, 0) * 100) / 100;

  await rel.etapa('a demo enche o dia: evento na semana, pagamentos, gente para chamar e quem não abriu', async () => {
    verdade(semana.some(p => p.id === A.idDemo(5)), '#05 cai nos próximos 7 dias');
    verdade(pags.length >= 2 && chamar.length >= 1 && naoAbriram.length >= 1 && lembretes.length >= 1, `pags ${pags.length}, chamar ${chamar.length}, não abriram ${naoAbriram.length}, lembretes ${lembretes.length}`);
  }, { critica: true });

  const context = await A.novoContexto(ctx.browser, { celular: true });
  const rede = A.gravarRedeApi(context);
  const vig = A.vigiar(context);
  const page = await context.newPage();
  rel.pagina = page;
  const n = async sel => A.texto(page, sel);

  await rel.etapa('entra como visitante e o painel abre na aba Hoje', async () => {
    await page.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#btVisitante');
    await page.click('#btVisitante');
    await A.esperarVisivel(page, '#vLista', 15000);
    if (await A.visivel(page, '#folhaGuia')) {
      contem(await A.texto(page, '#folhaGuia'), 'Hoje e Agenda', 'guia cita a aba Hoje');
      await page.click('#guiaComecar'); await A.esperarOculto(page, '#folhaGuia');
    }
    igual(await page.evaluate(() => [...document.querySelectorAll('#abas [data-aba]')].map(b => b.textContent)), ['Hoje', 'Agenda', 'Contatos', 'Propostas', 'Clientes', 'Financeiro'], 'abas');
    verdade(await A.visivel(page, '#abaHoje') && !(await A.visivel(page, '#abaAgenda')), 'abre na Hoje');
    verdade(/^(Bom dia|Boa tarde|Boa noite)$/.test(await n('#hjSaudacao')), 'saudação sem nome: ' + await n('#hjSaudacao'));
    verdade(await page.locator('.dica-visitante[data-dica="hoje"]:visible').count() === 1, 'dica da aba Hoje');
  }, { critica: true });

  await rel.etapa('números e listas do dia batem com a demo', async () => {
    igual([await n('#hjEventos'), await n('#hjReceber'), await n('#hjChamar')], [String(semana.length), A.fmtReais(soma(pags)), String(chamar.length + naoAbriram.length + lembretes.length)], 'números do dia');
    igual(await page.evaluate(() => [...document.querySelectorAll('#hoje .secao')].map(s => s.firstChild.textContent)), ['Próximos 7 dias', 'Pagamentos da semana', 'Lembretes', 'Hora de chamar', 'Ainda não abriram'], 'listas');
    contem(await n('#hoje .mes-lista'), 'Lançamento Vértice Arquitetura', 'evento da semana');
    igual(await page.locator('#hoje .pagto').count(), pags.length, 'pagamentos da semana');
    contem(A.norm(await page.locator('#hoje .pagto').first().innerText()), 'Venceu', 'o atrasado vem primeiro');
    igual(await page.locator('#hoje .lembrete').count(), chamar.length + naoAbriram.length + lembretes.length, 'lembretes');
    igual(await page.locator('#hoje .lembrete.contato').count(), lembretes.length, 'lembretes dos contatos');
    contem(await n('#hoje'), 'Abriu há', 'hora de chamar');
    await A.print(page, 'hoje-celular');
    await A.print(page, 'hoje-celular-inteira', { fullPage: true });
  });

  await rel.etapa('o mês: funil, vendido × eventos do mês e comparação; setas e voltar', async () => {
    const env = antes.filter(p => p.publicada_alguma_vez && diaBr(p.criado_em).slice(0, 7) === mes);
    const vend = fechadas.filter(p => String(p.fechado_em).slice(0, 7) === mes);
    igual(await page.evaluate(() => [...document.querySelectorAll('#doMes .numeros:not(.dois) b')].map(b => b.textContent)),
      [String(env.length), String(env.filter(p => p.views > 0).length), String(env.filter(p => p.etapa === 'fechada').length)], 'funil');
    igual(await page.evaluate(() => document.querySelector('#doMes .numeros.dois b').textContent), A.fmtReais(soma(vend.map(p => ({ valor: p.valor_fechado })))), 'vendido no mês');
    igual(await page.locator('#doMes .comp-linha').count(), 7, 'linhas da comparação');
    await page.click('#dmAnt');
    verdade(await A.visivel(page, '#dmHoje'), '"Voltar para este mês" aparece');
    await page.click('#dmHoje');
    verdade(!(await A.visivel(page, '#dmHoje')), 'voltou para este mês');
  });

  await rel.etapa('"Recebi" pela aba Hoje fica na aba e tira o pagamento da semana', async () => {
    const antesN = await page.locator('#hoje .pagto').count();
    await page.locator('#hoje .pagto .lado .b').first().click();
    await A.esperarVisivel(page, '#folhaRecebi');
    await page.click('#rcSalvar');
    await A.esperarOculto(page, '#folhaRecebi');
    verdade(await A.visivel(page, '#abaHoje'), 'continua na Hoje');
    igual(await page.locator('#hoje .pagto').count(), antesN - 1, 'um pagamento a menos');
  });

  await rel.etapa('celular: as abas deslizam e a ativa fica à vista, sem a página rolar para o lado', async () => {
    const m = await page.evaluate(() => { const nav = document.getElementById('abas'); return { rola: nav.scrollWidth > nav.clientWidth }; });
    verdade(m.rola, 'as 6 abas deslizam no celular');
    await page.click('#abas [data-aba="financeiro"]');
    await A.esperarVisivel(page, '#abaFinanceiro');
    const vis = await page.evaluate(() => { const nav = document.getElementById('abas'), b = nav.querySelector('[data-aba="financeiro"]').getBoundingClientRect(), r = nav.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; });
    verdade(vis, 'a aba Financeiro ficou inteira à vista');
    await A.semRolagemLateral(page);
  });

  await rel.etapa('nada foi para o servidor e o banco está igual; zero erros', async () => {
    const escrita = rede.filter(r => !(r.metodo === 'GET' || r.metodo === 'OPTIONS' || (r.metodo === 'POST' && r.caminho === '/login')));
    igual(escrita, [], 'requisições que gravariam');
    igual(A.diferencasBanco(antes, await ctx.listar(tokenAdmin)), [], 'diferenças no banco');
    igual(vig.erros, [], 'erros no navegador');
  });
  await context.close();

  // computador: as 6 abas cabem sem deslizar
  const pc = await A.novoContexto(ctx.browser);
  const p2 = await pc.newPage();
  await rel.etapa('computador: as 6 abas cabem lado a lado', async () => {
    await p2.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(p2, '#btVisitante');
    await p2.click('#btVisitante');
    await A.esperarVisivel(p2, '#vLista', 15000);
    if (await A.visivel(p2, '#folhaGuia')) { await p2.click('#guiaComecar'); await A.esperarOculto(p2, '#folhaGuia'); }
    verdade(await p2.evaluate(() => { const nav = document.getElementById('abas'); return nav.scrollWidth <= nav.clientWidth; }), 'sem deslizar');
    await A.print(p2, 'hoje-computador');
  });
  await pc.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
