'use strict';
// Roteiro ponta a ponta da aba CONTATOS (ESPEC §8.3): visitante no celular e administrador no computador.
//   node testes-e2e/rodar-tudo.js contatos
//
// O que prova:
//   - os 12 contatos de exemplo chegam ao visitante; números, listas, "De onde vêm" e o lembrete atrasado batem com a API;
//   - no modo visitante, todo botão WhatsApp abre a folha "Mensagem pronta" (nada de wa.me com número fictício), e o
//     "Testar no meu WhatsApp" abre o WhatsApp sem destinatário, só com a mensagem;
//   - Feito, Novo contato (validação de nome e WhatsApp, origem, atalho de lembrete), Fazer proposta a partir do contato
//     (a proposta fica ligada), contato no editor, Excluir, "Por que não fechou" e Recomeçar;
//   - nada vai para o servidor no modo visitante e o banco (propostas e contatos) termina igual; zero erros;
//   - celular: as 6 abas deslizam sem a página rolar para o lado; de 520 px para cima, cabem todas sem cortar;
//   - administrador: o WhatsApp abre direto a conversa (wa.me/55<número>), e criar/excluir contato grava de verdade
//     sem aparecer para o visitante.

const A = require('./ambiente');
const { verdade, igual, contem, norm } = A;

async function rodar(ctx) {
  const rel = new A.Relatorio('contatos');
  console.log('\nContatos (visitante no celular + administrador)');

  const tokenAdmin = await ctx.loginAdmin();
  const propostasAntes = await ctx.listar(tokenAdmin);
  const contatosAntes = await ctx.listarContatos(tokenAdmin);
  const hoje = A.hojeBr();
  const prop = c => propostasAntes.find(p => p.id === c.proposta_id);
  const esperado = {
    chamar: contatosAntes.filter(c => c.lembrete_em && c.lembrete_em <= hoje),
    semProp: contatosAntes.filter(c => !prop(c)),
    fecharam: contatosAntes.filter(c => prop(c) && prop(c).etapa === 'fechada'),
    futuros: contatosAntes.filter(c => c.lembrete_em && c.lembrete_em > hoje),
  };
  const numeros = e => [String(e.chamar.length), String(e.semProp.length), String(e.fecharam.length)];

  await rel.etapa('a API tem os 12 contatos de exemplo, com lembrete atrasado, sem proposta e fechados', async () => {
    igual(contatosAntes.length, 12, 'contatos da demo');
    verdade(contatosAntes.every(c => c.id.startsWith('00000000-0000-4000-8000-0000000001')), 'só contatos de exemplo');
    igual(numeros(esperado), ['3', '2', '5'], 'chamar hoje, sem proposta, fecharam');
    verdade(esperado.chamar.some(c => c.lembrete_em < hoje), 'um lembrete atrasado');
  }, { critica: true });

  const context = await A.novoContexto(ctx.browser, { celular: true });
  const rede = A.gravarRedeApi(context);
  const vig = A.vigiar(context);
  const page = await context.newPage();
  rel.pagina = page;
  const n = async sel => A.texto(page, sel);
  const aba = async nome => { await page.click(`#abas [data-aba="${nome}"]`); await A.esperarVisivel(page, '#aba' + nome.charAt(0).toUpperCase() + nome.slice(1)); };
  const secoes = sel => page.evaluate(s => [...document.querySelectorAll(s + ' .secao')].map(x => x.firstChild.textContent), sel);
  const linha = (escopo, nome) => page.locator(`${escopo} .lembrete`).filter({ hasText: nome }).first();
  const sandbox = () => A.lerSandbox(page);
  const txt = async sel => norm(await page.textContent(sel));   // texto sem o text-transform do CSS
  async function naLista() {   // volta para a lista de qualquer lugar (folha aberta, editor)
    for (let i = 0; i < 4; i++) {
      if (await A.visivel(page, '#vLista') && !(await page.locator('.folha-fundo:visible').count())) return;
      if (await page.locator('.folha-fundo:visible').count()) { await page.keyboard.press('Escape'); await A.dormir(250); if (await page.locator('.folha-fundo:visible').count()) await page.locator('.folha-fundo:visible [data-cancelar]').first().click().catch(() => {}); continue; }
      if (await A.visivel(page, '#vEditor')) { await page.click('#btVoltar'); await A.dormir(400); continue; }
    }
  }
  let paginasNovas = 0;
  context.on('page', () => { paginasNovas++; });
  async function fecharWhats() {
    await page.locator('#folhaWhats [data-cancelar]').click();
    await A.esperarOculto(page, '#folhaWhats');
  }

  await rel.etapa('entra como visitante: o guia cita Contatos e são 6 abas', async () => {
    await page.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(page, '#btVisitante');
    await page.click('#btVisitante');
    await A.esperarVisivel(page, '#vLista', 15000);
    await A.esperarVisivel(page, '#folhaGuia');
    contem(await n('#folhaGuia'), 'Contatos', 'guia');
    contem(await n('#folhaGuia'), 'você só aperta enviar', 'guia explica o WhatsApp');
    igual(await page.locator('#folhaGuia .passos li').count(), 5, 'passos do guia');
    await page.click('#guiaComecar'); await A.esperarOculto(page, '#folhaGuia');
    igual(await page.evaluate(() => [...document.querySelectorAll('#abas [data-aba]')].map(b => b.textContent)), ['Hoje', 'Agenda', 'Contatos', 'Propostas', 'Clientes', 'Financeiro'], 'abas');
  }, { critica: true });

  await rel.etapa('aba Contatos: dica, números, listas, lembrete atrasado e "De onde vêm"', async () => {
    await aba('contatos');
    verdade(await page.locator('.dica-visitante[data-dica="contatos"]:visible').count() === 1, 'dica da aba Contatos');
    contem(await n('.dica-visitante[data-dica="contatos"]'), 'você só aperta enviar', 'a dica explica o WhatsApp');
    igual([await n('#ctChamar'), await n('#ctSemProposta'), await n('#ctFecharam')], numeros(esperado), 'números');
    igual(await secoes('#contatos'), ['Chamar hoje', 'Sem proposta ainda', 'Próximos lembretes', 'De onde vêm'], 'listas');
    const isa = linha('#contatos', 'Isabela & Rodrigo');
    contem(norm(await isa.innerText()), 'era para', 'Isabela: lembrete atrasado');
    verdade(await isa.locator('span.atraso').count() === 1, 'atraso em vermelho');
    contem(norm(await isa.innerText()), '(11) 90000-0107', 'WhatsApp com máscara');
    contem(norm(await isa.innerText()), 'Portal de eventos', 'origem genérica');
    igual(await linha('#contatos', 'Clínica Ser').locator('a[data-whats]').count(), 0, 'sem WhatsApp, sem botão de WhatsApp');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#contatos .mes-a-mes .linha-mes')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    igual(rows.length, 5, 'origens');
    verdade(/^Instagram 4 contatos 2 fecharam \(50%\)$/.test(rows[0]), 'Instagram primeiro: ' + rows[0]);
    verdade(/^Portal de eventos 3 contatos 1 fechou \(33%\)$/.test(rows[1]), 'Portal depois: ' + rows[1]);
    contem(await n('#contatos details.passados summary'), '12 contatos', 'todos os contatos');
    verdade(!/casamentos\.com\.br|casamento /i.test(await page.evaluate(() => document.getElementById('abaContatos').textContent)), 'vocabulário genérico (evento, portal)');
    await A.semRolagemLateral(page);
    await A.print(page, 'contatos-celular');
    await A.print(page, 'contatos-celular-inteira', { fullPage: true });
  }, { critica: true });

  await rel.etapa('visitante: o WhatsApp abre "Mensagem pronta" (sem sair do painel); o teste vai sem destinatário', async () => {
    const antesPag = paginasNovas, url = page.url();
    await linha('#contatos', 'Marina & Rafael').locator('a[data-whats]').click();
    await A.esperarVisivel(page, '#folhaWhats');
    igual(paginasNovas, antesPag, 'nenhuma aba nova');
    igual(page.url(), url, 'continua no painel');
    igual(await n('#wzPara'), 'Para: Marina & Rafael', 'para quem');
    const msg = await n('#wzMsg');
    igual(msg, 'Oi, Marina e Rafael! Tudo bem? Deu para ver a proposta? Qualquer dúvida, estou por aqui.', 'mensagem');
    contem(await n('#wzExplica'), 'Você confere e aperta enviar', 'explicação');
    contem(await n('#wzExplica'), 'não precisa conectar nada', 'sem conexão');
    const href = await page.getAttribute('#wzTestar', 'href');
    verdade(href.startsWith('https://wa.me/?text='), 'teste sem número: ' + href);
    igual(decodeURIComponent(href.split('?text=')[1]), msg, 'o teste leva a mesma mensagem');
    await A.semRolagemLateral(page);
    await A.print(page, 'contatos-mensagem-pronta');
    await fecharWhats();
  });

  await rel.etapa('"Feito" tira o lembrete de Chamar hoje e da aba Hoje', async () => {
    await linha('#contatos', 'Marina & Rafael').getByRole('button', { name: 'Feito' }).click();
    await A.esperarToast(page, 'Lembrete feito');
    igual(await n('#ctChamar'), String(esperado.chamar.length - 1), 'para chamar hoje');
    await aba('hoje');
    const lembretes = await page.evaluate(() => [...document.querySelectorAll('#hoje .lembrete.contato')].map(r => r.innerText.replace(/\s+/g, ' ')));
    igual(lembretes.length, esperado.chamar.length - 1, 'lembretes na aba Hoje');
    verdade(!lembretes.some(l => /Marina/.test(l)) && lembretes.some(l => /Isabela/.test(l)), JSON.stringify(lembretes));
    verdade((await secoes('#hoje')).includes('Lembretes'), 'seção Lembretes na Hoje');
    await aba('contatos');
  });

  const NOVO = 'Teste Visitante & Par';
  await rel.etapa('Novo contato: pede nome e WhatsApp com DDD; origem e atalho de lembrete; aparece nas listas', async () => {
    await page.click('#btNovoContato');
    await A.esperarVisivel(page, '#folhaContato');
    igual(await n('#ctTit'), 'Novo contato', 'título');
    await page.click('#ctSalvar');
    igual(await n('#ctErro'), 'Coloque o nome.', 'sem nome');
    await page.fill('#ctNome', NOVO);
    await page.fill('#ctWhats', '123');
    await page.click('#ctSalvar');
    contem(await n('#ctErro'), 'Coloque o WhatsApp com DDD', 'WhatsApp curto');
    await page.fill('#ctWhats', '(11) 98888-7777');
    await page.click('#ctOrigens [data-v="instagram"]');
    igual(await page.getAttribute('#ctOrigens [data-v="instagram"]', 'aria-pressed'), 'true', 'origem marcada');
    await page.locator('#ctAtalhos button', { hasText: 'Amanhã' }).click();
    igual([await page.inputValue('#ctLembEm'), await page.inputValue('#ctLembTxt')], [A.maisDias(hoje, 1), 'Mandar a proposta'], 'atalho');
    await A.semRolagemLateral(page);
    await A.print(page, 'contatos-novo');
    await page.click('#ctSalvar');
    await A.esperarOculto(page, '#folhaContato');
    await A.esperarToast(page, 'Contato salvo');
    igual(await n('#ctSemProposta'), String(esperado.semProp.length + 1), 'sem proposta');
    verdade(await linha('#contatos', NOVO).count() === 1, 'na lista');
    const sb = await sandbox();
    const c = sb.contatos.find(x => x.nome === NOVO);
    igual([c.whatsapp, c.origem, c.lembrete_em, c.lembrete_txt, c.proposta_id], ['11988887777', 'instagram', A.maisDias(hoje, 1), 'Mandar a proposta', null], 'gravado no sandbox');
  });

  await rel.etapa('"Fazer proposta" a partir do contato: nasce com o nome, fica ligada, e o WhatsApp leva o link', async () => {
    await linha('#contatos', NOVO).getByRole('button', { name: 'Fazer proposta' }).click();
    await A.esperarVisivel(page, '#vEditor');
    igual(await page.inputValue('#fCliente'), NOVO, 'nome no editor');
    await page.click('#btSalvar');
    await A.esperarVisivel(page, '#folhaPronta');
    const link = await n('#prontaLink');
    verdade(/\/proposta\/\?p=teste-visitante-e-par-[a-z0-9]{4}$/.test(link), 'link: ' + link);
    await page.waitForFunction(nome => {
      const s = JSON.parse(localStorage.getItem('rk_demo_sandbox_v1') || 'null');
      const c = s && s.contatos.find(x => x.nome === nome);
      return !!(c && c.proposta_id);
    }, NOVO, { timeout: 8000 });
    await page.click('#prontaWhats');
    await A.esperarVisivel(page, '#folhaWhats');
    verdade(await A.visivel(page, '#folhaPronta') === false, 'a folha da proposta pronta dá lugar à mensagem');
    igual(await n('#wzPara'), 'Para: ' + NOVO, 'para quem');
    igual(await n('#wzMsg'), 'Oi, Teste Visitante e Par! Aqui está a proposta que preparei: ' + link, 'mensagem com o link');
    await A.print(page, 'contatos-mensagem-proposta');
    await fecharWhats();
    igual(await txt('#edContato'), 'Contato: ' + NOVO + ' · (11) 98888-7777 · editar', 'contato no editor');
    await page.click('#btVoltar');
    await A.esperarVisivel(page, '#vLista');
    await aba('contatos');
    igual(await n('#ctSemProposta'), String(esperado.semProp.length), 'sem proposta voltou');
  });

  await rel.etapa('contato com proposta: "Abrir a proposta", contato no editor e "Enviar no WhatsApp"', async () => {
    await naLista(); await aba('contatos');
    await page.click('#contatos details.passados summary');
    await linha('#contatos details.passados', 'Marina & Rafael').locator('.q').click();
    await A.esperarVisivel(page, '#folhaContato');
    igual([await txt('#ctTit'), await txt('#ctProposta')], ['Contato', 'Abrir a proposta'], 'folha do contato');
    igual(await page.inputValue('#ctWhats'), '(19) 90000-0101', 'WhatsApp com máscara');
    await page.click('#ctProposta');
    await A.esperarVisivel(page, '#vEditor');
    igual(await page.inputValue('#fCliente'), 'Marina & Rafael', 'proposta do contato');
    igual(await txt('#edContato'), 'Contato: Marina & Rafael · (19) 90000-0101 · editar', 'contato no editor');
    await page.click('#edWhats');
    await A.esperarVisivel(page, '#folhaWhats');
    contem(await n('#wzMsg'), 'Aqui está a proposta que preparei: ' + A.SITE + '/proposta/?p=exemplo', 'mensagem com o link do exemplo');
    await fecharWhats();
    await page.click('#btVoltar');
    await A.esperarVisivel(page, '#vLista');
  });

  await rel.etapa('Excluir contato pede confirmação e tira da lista (a proposta fica)', async () => {
    await naLista(); await aba('contatos');
    if (!(await page.locator('#contatos details.passados[open]').count())) await page.click('#contatos details.passados summary');
    await linha('#contatos details.passados', NOVO).locator('.q').click();
    await A.esperarVisivel(page, '#folhaContato');
    await page.click('#ctExcluir');
    await A.esperarOculto(page, '#folhaContato');
    await A.esperarToast(page, 'Contato excluído');
    igual(await linha('#contatos', NOVO).count(), 0, 'saiu da lista');
    const sb = await sandbox();
    verdade(!sb.contatos.some(x => x.nome === NOVO) && sb.propostas.some(p => p.dados.cliente === NOVO), 'contato saiu, proposta ficou');
    verdade(context._dialogos.some(d => /Excluir este contato/.test(d)), 'pediu confirmação');
  });

  await rel.etapa('Propostas · Não fechou: relatório "Por que não fechou"', async () => {
    await naLista();
    await aba('propostas');
    await page.click('#filtros [data-filtro="perdidas"]');
    const rows = await page.evaluate(() => [...document.querySelectorAll('#lista .motivos-rel .linha-mes')].map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    igual(rows.length, 3, 'motivos');
    verdade(rows.every(r => /1 \(33%\)$/.test(r)), JSON.stringify(rows));
    contem(await txt('#lista .motivos-rel .secao'), 'Por que não fechou', 'título');
    await page.click('#filtros [data-filtro="abertas"]');
  });

  await rel.etapa('Recomeçar devolve os contatos de exemplo', async () => {
    await naLista();
    await page.click('#btRecomecar');
    await A.esperarToast(page, 'os exemplos voltaram ao início', 15000);
    await aba('contatos');
    igual([await n('#ctChamar'), await n('#ctSemProposta'), await n('#ctFecharam')], numeros(esperado), 'números de volta');
    igual((await sandbox()).contatos.length, 12, 'sandbox com os 12');
  });

  await rel.etapa('celular: as 6 abas deslizam, a ativa fica à vista e a página não rola para o lado', async () => {
    for (const w of [320, 360, 390, 430]) {
      await page.setViewportSize({ width: w, height: 800 });
      await A.dormir(150);
      await aba('financeiro'); await aba('contatos');
      const m = await page.evaluate(() => {
        const nav = document.getElementById('abas'), b = nav.querySelector('[aria-selected="true"]').getBoundingClientRect(), r = nav.getBoundingClientRect();
        return { inteira: b.left >= r.left - 1 && b.right <= r.right + 1, cortadas: [...nav.querySelectorAll('button')].filter(x => x.scrollWidth > x.clientWidth + 1).length };
      });
      verdade(m.inteira && !m.cortadas, `${w} px: ${JSON.stringify(m)}`);
      await A.semRolagemLateral(page);
    }
    await page.setViewportSize({ width: 375, height: 812 });
  });

  await rel.etapa('visitante: nada foi para o servidor, propostas e contatos iguais no banco; zero erros', async () => {
    const escrita = rede.filter(r => !(r.metodo === 'GET' || r.metodo === 'OPTIONS' || (r.metodo === 'POST' && r.caminho === '/login')));
    igual(escrita, [], 'requisições que gravariam');
    igual(A.diferencasBanco(propostasAntes, await ctx.listar(tokenAdmin)), [], 'propostas');
    igual(await ctx.listarContatos(tokenAdmin), contatosAntes, 'contatos');
    igual(vig.erros, [], 'erros no navegador');
  });
  await context.close();

  // ---------- computador: abas e administrador ----------
  const pc = await A.novoContexto(ctx.browser);
  const vigPc = A.vigiar(pc);
  // o wa.me de verdade não é aberto: a aba nova recebe uma página vazia, só para conferir o endereço
  await pc.route(/^https:\/\/wa\.me\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wa</title>' }));
  const p2 = await pc.newPage();
  rel.pagina = p2;
  const aba2 = async nome => { await p2.click(`#abas [data-aba="${nome}"]`); await A.esperarVisivel(p2, '#aba' + nome.charAt(0).toUpperCase() + nome.slice(1)); };

  await rel.etapa('administrador: entra e vê os 12 contatos; de 520 px para cima as 6 abas cabem sem cortar', async () => {
    await p2.goto(A.SITE + '/', { waitUntil: 'domcontentloaded' });
    await A.esperarVisivel(p2, '#vLogin');
    await p2.fill('#senha', ctx.senhaAdmin());
    await p2.click('#btEntrar');
    await A.esperarVisivel(p2, '#vLista', 15000);
    await aba2('contatos');
    contem(await A.texto(p2, '#contatos details.passados summary'), '12 contatos', 'todos os contatos');
    for (const w of [520, 600, 700, 1280]) {
      await p2.setViewportSize({ width: w, height: 860 });
      await A.dormir(150);
      const m = await p2.evaluate(() => { const nav = document.getElementById('abas'); return { rola: nav.scrollWidth > nav.clientWidth + 1, cortadas: [...nav.querySelectorAll('button')].filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent) }; });
      verdade(!m.rola && !m.cortadas.length, `${w} px: ${JSON.stringify(m)}`);
      await A.semRolagemLateral(p2);
    }
    await A.print(p2, 'contatos-computador');
  }, { critica: true });

  await rel.etapa('administrador: o WhatsApp abre direto a conversa do contato (wa.me/55<número>) com a mensagem', async () => {
    const isa = p2.locator('#contatos .lembrete').filter({ hasText: 'Isabela & Rodrigo' }).first().locator('a[data-whats]');
    const href = await isa.getAttribute('href');
    const msg = 'Oi, Isabela e Rodrigo! Tudo bem? Deu para ver a proposta? Qualquer dúvida, estou por aqui.';
    igual(href, 'https://wa.me/5511900000107?text=' + encodeURIComponent(msg), 'link');
    const d = await A.abrirDestino(pc, p2, () => isa.click());
    verdade(d.novaAba, 'abre em aba nova');
    verdade(d.pagina.url().startsWith('https://wa.me/5511900000107?text='), d.pagina.url());
    await d.fechar();
    verdade(!(await A.visivel(p2, '#folhaWhats')), 'o administrador não vê a folha do visitante');
  });

  await rel.etapa('administrador: criar e excluir contato grava de verdade, e o visitante não vê o do admin', async () => {
    await p2.click('#btNovoContato');
    await A.esperarVisivel(p2, '#folhaContato');
    await p2.fill('#ctNome', 'Contato do Admin E2E');
    await p2.fill('#ctWhats', '11977776666');
    await p2.click('#ctOrigens [data-v="outro"]');
    await p2.click('#ctSalvar');
    await A.esperarToast(p2, 'Contato salvo');
    const lista = await ctx.listarContatos(tokenAdmin);
    const meu = lista.find(c => c.nome === 'Contato do Admin E2E');
    verdade(meu && meu.whatsapp === '11977776666' && meu.origem === 'outro', 'gravado na API');
    const doVisitante = await ctx.apiReq('GET', '/admin/contatos', { token: await ctx.loginVisitante() });
    igual(doVisitante.json.length, 12, 'o visitante só vê os de exemplo');
    if (!(await p2.locator('#contatos details.passados[open]').count())) await p2.click('#contatos details.passados summary');
    await p2.locator('#contatos details.passados .lembrete').filter({ hasText: 'Contato do Admin E2E' }).first().locator('.q').click();
    await A.esperarVisivel(p2, '#folhaContato');
    await p2.click('#ctExcluir');
    await A.esperarToast(p2, 'Contato excluído');
    igual(await ctx.listarContatos(tokenAdmin), contatosAntes, 'banco de volta ao que era');
    igual(vigPc.erros, [], 'erros no navegador');
  });
  await pc.close();
  return rel.resumo();
}

module.exports = { rodar };
if (require.main === module) A.principal(rodar);
