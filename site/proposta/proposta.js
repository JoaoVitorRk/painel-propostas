(function () {
  // ============================================================
  // CONFIG — o que muda de um cliente da RK para outro (para clonar a base)
  // ============================================================
  var CONFIG = {
    DEMO: true,                               // página modelo da RK: botões de WhatsApp abrem a folha da demonstração
    MARCA: 'Aurora Studio',                   // nome que assina a página (exemplo fictício)
    MARCA_CURTA: 'Aurora',                    // como o cliente chama no WhatsApp ("Oi, Aurora!")
    WHATSAPP: '',                             // WhatsApp do dono (só usado com DEMO: false), ex.: '5542999999999'
    API_LOCAL: 'http://127.0.0.1:8792',
    API: 'https://rk-painel-demo.joao-vitor-kos.workers.dev',
    CHAVE_SESSAO: 'rk_painel_sessao',         // { token, exp, papel }
    CHAVE_SANDBOX: 'rk_demo_sandbox_v1',      // sandbox do visitante (painel em modo visitante)
    SANDBOX_HORAS: 6,
    SLUG_PADRAO: 'exemplo',                   // sem ?p= abre a proposta de exemplo
    RK_WHATSAPP: '5542999246208',
    RK_MENSAGEM: 'Oi, João! Vi a página modelo de proposta da RK e quero uma assim para o meu trabalho.',
    TITULO: 'Proposta · página modelo · RK Performance'
  };

  var LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var API = LOCAL ? CONFIG.API_LOCAL : CONFIG.API;
  var ORDEM = ['simples', 'media', 'completa'];
  // rótulos dos dois valores de cada opção quando a proposta não traz os seus (dado antigo)
  var ROTULOS_PADRAO = { pacote_a: 'Cerimônia', pacote_b: 'Cerimônia + recepção', nota_b: '' };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };

  // ---------- formatação ----------
  function dataLonga(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
    return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
  }
  function numero(v) {
    v = num(v);
    var inteiro = Math.round(v * 100) % 100 === 0;
    return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: inteiro ? 0 : 2, maximumFractionDigits: 2 }).format(v);
  }
  function num(v) { return typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? parseFloat(v) : v; }
  function valorOk(v) { v = num(v); return typeof v === 'number' && isFinite(v) && v > 0; }
  function hojeISO() { var d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function txt(v) { return typeof v === 'string' ? v.trim() : ''; }
  function meio(s) { return s.replace(/\s+·\s+/g, ' · '); }   // a quebra de linha cai depois do "·", nunca antes
  function linhas(v) { return txt(v).split('\n').map(function (x) { return x.replace(/^[-–•✦\s]+/, '').trim(); }).filter(Boolean); }
  function el(tag, cls, texto) { var e = document.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function waLink(numeroWa, msg) { return 'https://wa.me/' + numeroWa + '?text=' + encodeURIComponent(msg); }
  function seta() { return $('tSeta').content.firstElementChild.cloneNode(true); }
  function oi(resto) { return 'Oi, ' + CONFIG.MARCA_CURTA + '! ' + resto; }
  function lerJSON(chave) { try { return JSON.parse(localStorage.getItem(chave) || 'null'); } catch (e) { return null; } }

  // ---------- textos fixos que dependem do CONFIG ----------
  document.querySelectorAll('[data-marca]').forEach(function (x) { x.textContent = CONFIG.MARCA; });
  $('erroWaTxt').textContent = 'Falar com ' + (/a$/i.test(CONFIG.MARCA_CURTA) ? 'a ' : 'o ') + CONFIG.MARCA_CURTA;
  $('waFloat').setAttribute('aria-label', 'Falar com ' + CONFIG.MARCA_CURTA + ' no WhatsApp');
  var linkRk = waLink(CONFIG.RK_WHATSAPP, CONFIG.RK_MENSAGEM);
  $('faixaModeloCta').href = linkRk;
  document.querySelectorAll('[data-rk]').forEach(function (a) { a.href = linkRk; });
  if (!CONFIG.DEMO) {
    document.querySelectorAll('.so-demo, .nota-modelo, .ex').forEach(function (x) { x.hidden = true; });
    $('rodapeRk').textContent = 'Site por RK Performance';
  }

  // ---------- WhatsApp: na demonstração, abre a folha com a mensagem; na versão real, o WhatsApp do dono ----------
  function ligarWa(a, msg) {
    a.setAttribute('data-msg', msg);
    if (CONFIG.DEMO) { a.href = '#folhaWa'; a.removeAttribute('target'); a.removeAttribute('rel'); }
    else { a.href = waLink(CONFIG.WHATSAPP, msg); a.target = '_blank'; a.rel = 'noopener'; }
  }
  var ultimoFoco = null;
  function abrirFolha(d) {
    ultimoFoco = document.activeElement;
    document.documentElement.classList.add('travado');
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    var foco = d.querySelector('.sheet-acoes .btn');
    if (foco) foco.focus({ preventScroll: true });
  }
  function fecharFolha(d) {
    if (typeof d.close === 'function' && d.open) d.close(); else d.removeAttribute('open');
  }
  ['folhaWa', 'folhaVideo'].forEach(function (id) {
    var d = $(id);
    d.addEventListener('close', function () {
      document.documentElement.classList.remove('travado');
      if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus({ preventScroll: true });
    });
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('[data-fechar]')) fecharFolha(d);   // fora da folha ou "Fechar"
    });
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-msg]');
    if (!a || !CONFIG.DEMO) return;
    e.preventDefault();
    $('folhaWaMsg').textContent = a.getAttribute('data-msg');
    abrirFolha($('folhaWa'));
  });

  // ---------- carregar: sandbox do visitante → prévia do administrador → link público ----------
  var slug = (new URLSearchParams(location.search).get('p') || CONFIG.SLUG_PADRAO).toLowerCase().replace(/[^a-z0-9-]/g, '');
  var sessao = lerJSON(CONFIG.CHAVE_SESSAO);
  var admin = !!(sessao && sessao.token && sessao.exp > Date.now() / 1000 && sessao.papel === 'admin');
  var sandbox = CONFIG.DEMO ? lerJSON(CONFIG.CHAVE_SANDBOX) : null;
  var sandboxOk = !!(sandbox && sandbox.v === 1 && Array.isArray(sandbox.propostas) &&
    Date.now() - Date.parse(sandbox.criado_em) < CONFIG.SANDBOX_HORAS * 3600000);

  function mostrarErro() {
    $('carregando').hidden = true;
    $('proposta').hidden = true;
    $('erro').hidden = false;
    ligarWa($('erroWa'), oi('Tentei abrir o link da minha proposta e não funcionou.'));
  }
  function publica() {
    return fetch(API + '/p/' + slug).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function buscar() {
    if (!slug) return Promise.reject(new Error('sem link'));
    // (1) modo visitante: o que ele criou ou apagou no painel vale só neste aparelho
    if (sandboxOk) {
      if (Array.isArray(sandbox.removidos) && sandbox.removidos.indexOf(slug) >= 0) return Promise.reject(new Error('removida'));
      var achou = sandbox.propostas.filter(function (x) { return x && x.slug === slug; })[0];
      if (achou) {
        var copia = JSON.parse(JSON.stringify(achou));
        copia._sandbox = true;
        return Promise.resolve(copia);
      }
    }
    // (2) o administrador logado vê a prévia (inclusive rascunho) e não conta como abertura do cliente
    if (admin) {
      return fetch(API + '/admin/p/' + slug, { headers: { authorization: 'Bearer ' + sessao.token } }).then(function (r) {
        if (r.ok) return r.json().then(function (p) { p._previa = true; return p; });
        return publica();
      }, publica);
    }
    // (3) o link público
    return publica();
  }

  medirFaixas();
  window.addEventListener('resize', medirFaixas);

  buscar().then(function (p) {
    if (p && typeof p.dados === 'string') p.dados = JSON.parse(p.dados);
    if (!p || typeof p.dados !== 'object' || !p.dados) throw new Error('sem dados');
    render(p);
  }).catch(mostrarErro);

  // a faixa "página modelo" fica no fluxo; a capa ocupa o resto da primeira tela
  function medirFaixas() {
    var fm = $('faixaModelo'), raiz = document.documentElement.style;
    raiz.setProperty('--fm-h', (fm && !fm.hidden ? fm.offsetHeight : 0) + 'px');
    var pv = !$('faixaSandbox').hidden ? $('faixaSandbox') : (!$('previa').hidden ? $('previa') : null);
    raiz.setProperty('--pv-h', pv ? (pv.offsetHeight + 22) + 'px' : '0px');
  }

  // ---------- montar a página ----------
  function render(p) {
    var d = p.dados;
    var cliente = txt(d.cliente);
    var hora = /^\d{2}:\d{2}$/.test(d.hora || '') ? Number(d.hora.slice(0, 2)) + 'h' + (d.hora.slice(3) === '00' ? '' : d.hora.slice(3)) : '';
    var dataEvento = dataLonga(d.data);
    var dataHora = dataEvento && hora ? dataEvento + ', às ' + hora : dataEvento;
    var local = meio(txt(d.local)), tipo = meio(txt(d.tipo));
    var rot = d.rotulos && typeof d.rotulos === 'object' ? d.rotulos : {};
    var ROT_A = txt(rot.pacote_a) || ROTULOS_PADRAO.pacote_a, ROT_B = txt(rot.pacote_b) || ROTULOS_PADRAO.pacote_b, NOTA_B = txt(rot.nota_b);
    document.title = cliente ? 'Proposta · ' + cliente + ' · página modelo · RK Performance' : CONFIG.TITULO;
    if (!CONFIG.DEMO) document.title = 'Proposta' + (cliente ? ' · ' + cliente : '') + ' · ' + CONFIG.MARCA;

    if (p._sandbox) {
      $('faixaSandbox').hidden = false;
      if (p.status !== 'publicada') $('faixaSandboxTxt').insertBefore(el('b', null, 'Rascunho · '), $('faixaSandboxTxt').firstChild);
    } else if (p._previa) {
      $('previa').hidden = false;
      $('previaTxt').textContent = p.status === 'publicada' ? 'Prévia · não conta como abertura' : 'Rascunho · o cliente ainda não vê';
    }

    // capa: nome do cliente em duas linhas, com o "&" (ou "e") em destaque
    var h1 = $('pCliente');
    var m = cliente.match(/^(.+?)\s+(&|e)\s+(.+)$/i);
    var maior;
    if (m) {
      h1.appendChild(el('span', 'l', m[1]));
      h1.appendChild(document.createTextNode(' '));
      var l2 = el('span', 'l');
      l2.appendChild(el('em', null, m[2]));
      l2.appendChild(document.createTextNode(' ' + m[3]));
      h1.appendChild(l2);
      maior = Math.max(m[1].length, m[3].length + 2);
    } else {
      h1.textContent = cliente || 'vocês';
      // sem "&" o título quebra nos espaços: o que manda é a palavra mais longa
      maior = Math.max.apply(null, (cliente || 'vocês').split(/\s+/).map(function (w) { return w.length; }));
    }
    h1.setAttribute('data-tam-base', maior <= 8 ? 'g' : maior <= 14 ? 'm' : 'p');
    var meta = $('pMeta');
    [dataHora, local, tipo].forEach(function (x) { if (x) meta.appendChild(el('span', null, x)); });
    if (!meta.children.length) meta.hidden = true;

    // carta
    var msg = txt(d.mensagem);
    if (msg) {
      $('secMensagem').hidden = false;
      $('pMensagem').textContent = msg;
      if (msg.length > 280 || msg.split('\n').length > 4) $('carta').classList.add('longa');
    }

    // seções opcionais
    var s = d.secoes || {};
    if (s.videos === false) $('secVideos').hidden = true;
    if (s.depoimentos === false) $('secDepoimentos').hidden = true;

    // WhatsApp com a proposta identificada
    var ref = [cliente, dataEvento].filter(Boolean).join(' · ') || slug;
    var reservar = oi('Vi a proposta (' + ref + ') e quero reservar a minha data.');
    ligarWa($('waReservar'), reservar);
    ligarWa($('waFloat'), reservar);
    ligarWa($('waDuvida'), oi('Vi a proposta (' + ref + ') e fiquei com uma dúvida:'));

    // resumo
    var resumo = $('pResumo');
    [['Para', cliente], ['Evento', tipo], ['Data', dataHora], ['Local', local]].forEach(function (par) {
      if (!par[1]) return;
      var g = el('div'); g.appendChild(el('dt', null, par[0])); g.appendChild(el('dd', null, par[1])); resumo.appendChild(g);
    });
    if (!resumo.children.length) resumo.hidden = true;

    // as opções ligadas, na ordem montada no painel; cada uma mostra o valor do jeito escolhido
    // (junto: só o pacote B · separado: os dois · só o pacote A). Proposta antiga, sem isso por opção:
    // as chaves globais de antes valem para todas; ordem "cara" = a de maior valor à mostra primeiro; sem ordem = simples → completa.
    var ops = d.opcoes || {};
    function verCer(o) { return typeof o.ver_cerimonia === 'boolean' ? o.ver_cerimonia : (d.mostrar_cerimonia !== false || d.mostrar_recepcao === false); }
    function verRec(o) { return typeof o.ver_recepcao === 'boolean' ? o.ver_recepcao : d.mostrar_recepcao !== false; }
    var ordem = ORDEM.slice();
    if (Array.isArray(d.ordem)) {
      ordem = d.ordem.filter(function (k, i) { return ORDEM.indexOf(k) >= 0 && d.ordem.indexOf(k) === i; });
      ORDEM.forEach(function (k) { if (ordem.indexOf(k) < 0) ordem.push(k); });
    } else if (d.ordem === 'cara') {
      var maiorValor = function (k) {
        var o = ops[k] || {}, vs = [];
        if (verCer(o) && valorOk(o.cerimonia)) vs.push(num(o.cerimonia));
        if (verRec(o) && valorOk(o.cerimonia_recepcao)) vs.push(num(o.cerimonia_recepcao));
        return vs.length ? Math.max.apply(null, vs) : -1;
      };
      ordem.sort(function (a, b) { return (maiorValor(b) - maiorValor(a)) || (ORDEM.indexOf(b) - ORDEM.indexOf(a)); });
    }
    var ligadas = ordem.filter(function (k) { return ops[k] && ops[k].on; });
    var n = ligadas.length;
    var sugestao = ligadas.indexOf(d.sugestao) >= 0 ? d.sugestao : '';
    var alvo = $('pOpcoes');
    alvo.setAttribute('data-n', n);
    if (!sugestao) alvo.classList.add('sem-sugestao');
    $('pOpcoesTitulo').appendChild(el('span', null, n === 1 ? 'A proposta para vocês' : (n === 2 ? 'Duas' : 'Três') + ' opções para vocês'));
    var evento = tipo ? tipo.toLowerCase() : 'projeto';
    $('pIntro').textContent = 'Cada ' + evento + ' pede um formato diferente. ' + (n > 1
      ? 'Por isso, separei algumas possibilidades para vocês escolherem a que mais combina com o que imaginaram.'
      : 'O valor é definido de acordo com a opção escolhida e os detalhes do que for contratado.');
    if (!n) { $('pOpcoesTitulo').hidden = true; alvo.hidden = true; }

    function preco(rotulo, v, nota) {
      var box = el('div', 'preco');
      box.appendChild(el('span', 'rot', rotulo));
      var val = el('p', 'valor');
      val.appendChild(el('span', 'rs', 'R$'));
      val.appendChild(el('span', 'num', numero(v)));
      box.appendChild(val);
      if (nota) box.appendChild(el('p', 'nota', nota));
      return box;
    }

    ligadas.forEach(function (k, i) {
      var o = ops[k];
      var nome = txt(o.nome) || 'Opção ' + (i + 1);
      var nomeWa = txt(o.nome) || String(i + 1);   // na mensagem: "com a opção Completa." ou "com a opção 2."
      var card = el('article', 'opcao' + (k === sugestao ? ' sugestao' : ''));
      card.setAttribute('data-k', k);
      if (k === sugestao) card.appendChild(el('span', 'selo', 'Minha sugestão para vocês'));
      if (n > 1) card.appendChild(el('p', 'op-ord', 'Opção ' + (i + 1)));
      card.appendChild(el('h4', 'op-nome' + (nome.length > 20 ? ' longo' : nome.length > 12 ? ' medio' : ''), nome));
      if (txt(o.clima)) card.appendChild(el('p', 'op-clima', txt(o.clima)));
      var itens = linhas(o.itens);
      if (itens.length) {
        card.appendChild(el('span', 'op-fio'));
        var ul = el('ul', 'op-itens');
        itens.forEach(function (x) { ul.appendChild(el('li', null, x)); });
        card.appendChild(ul);
      }
      var precos = el('div', 'op-precos');
      if (verCer(o) && valorOk(o.cerimonia)) precos.appendChild(preco(ROT_A, o.cerimonia));
      if (verRec(o) && valorOk(o.cerimonia_recepcao)) precos.appendChild(preco(ROT_B, o.cerimonia_recepcao, NOTA_B));
      if (!precos.children.length) { var sem = el('div', 'preco'); sem.appendChild(el('p', 'sem', 'Valor sob consulta')); precos.appendChild(sem); }
      card.appendChild(precos);
      var cta = el('a', 'btn btn-mini op-cta');
      ligarWa(cta, oi('Vi a proposta (' + ref + ') e quero reservar com a opção ' + nomeWa + '.'));
      cta.setAttribute('data-opcao', nomeWa);
      cta.appendChild(el('span', null, 'Quero esta opção'));
      cta.appendChild(seta());
      card.appendChild(cta);
      alvo.appendChild(card);
      if (i < n - 1) {
        var prox = el('button', 'op-prox'); prox.type = 'button';
        prox.appendChild(el('span', null, 'Ver a próxima opção')); prox.appendChild(el('i', null, '↓'));
        prox.addEventListener('click', function () {
          var alvoCard = alvo.querySelectorAll('.opcao')[i + 1];
          if (alvoCard) alvoCard.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: alvoCard.offsetHeight < innerHeight - 40 ? 'center' : 'start' });
        });
        alvo.appendChild(prox);
      }
    });

    // em todas as opções
    var inclui = linhas(d.inclui);
    inclui.forEach(function (x) { $('pInclui').appendChild(el('li', null, x)); });
    if (!inclui.length) $('blocoInclui').hidden = true;
    if (n === 1) $('pIncluiTitulo').textContent = 'O que está incluso';

    // adicionais: lista corrida quando são só nomes; linhas quando há descrição ou valor
    var adic = (Array.isArray(d.adicionais) ? d.adicionais : []).filter(function (a) { return a && txt(a.nome); });
    var alvoAdic = $('pAdic');
    if (!adic.length) $('blocoAdic').hidden = true;
    else if (adic.every(function (a) { return !txt(a.descricao) && !valorOk(a.valor); })) {
      var corrido = el('p', 'adic-inline');
      adic.forEach(function (a, i) { if (i) corrido.appendChild(document.createTextNode(' ')); corrido.appendChild(el('span', null, txt(a.nome))); });
      alvoAdic.appendChild(corrido);
    } else {
      adic.forEach(function (a) {
        var row = el('div', 'adic-linha');
        row.appendChild(el('b', null, txt(a.nome)));
        if (valorOk(a.valor)) row.appendChild(el('span', 'v', '+ R$ ' + numero(a.valor)));
        if (txt(a.descricao)) row.appendChild(el('small', null, txt(a.descricao)));
        alvoAdic.appendChild(row);
      });
    }

    // condições
    var cond = linhas(d.condicoes);
    cond.forEach(function (x) { $('pCond').appendChild(el('li', null, x)); });
    if (!cond.length) $('blocoCond').hidden = true;

    // observações
    if (txt(d.observacoes)) $('pObs').textContent = txt(d.observacoes);
    else $('blocoObs').hidden = true;
    var colunas = 0;
    $('pDetalhes').querySelectorAll('.col').forEach(function (c) { if (c.querySelector('.bloco:not([hidden])')) colunas++; else c.hidden = true; });
    if (!colunas) $('pDetalhes').hidden = true;
    else if (colunas === 1) $('pDetalhes').classList.add('uma');

    // validade
    var val = $('pValidade'), validade = dataLonga(d.validade);
    if (!validade) val.hidden = true;
    else if (d.validade < hojeISO()) {
      val.className = 'validade expirou';
      val.appendChild(el('span', null, 'Esta proposta expirou em ' + validade + '. Me chama no WhatsApp que eu atualizo para vocês.'));
      // o botão principal da folha (e o flutuante) passam a pedir a proposta atualizada, em vez de "reservar" uma proposta vencida
      var pedir = oi('Vi a proposta (' + ref + '), mas ela já expirou. Pode me enviar atualizada?');
      $('waReservar').querySelector('span').textContent = 'Pedir a proposta atualizada';
      ligarWa($('waReservar'), pedir);
      ligarWa($('waFloat'), pedir);
      document.querySelectorAll('.op-cta').forEach(function (b) {
        ligarWa(b, oi('Vi a proposta (' + ref + '), mas ela já expirou. Pode me enviar atualizada? Tenho interesse na opção ' + b.getAttribute('data-opcao') + '.'));
        b.querySelector('span').textContent = 'Pedir atualizada';
      });
    } else val.textContent = 'Proposta válida até ' + validade + '.';

    $('carregando').hidden = true;
    $('proposta').hidden = false;
    medirFaixas();
    ajustarTitulo();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { ajustarTitulo(); medirFaixas(); });
    window.addEventListener('resize', ajustarTitulo);
    iniciarCapa();
    iniciarStrip();
    iniciarCards();
    iniciarReveal();
    iniciarFlutuante();
  }

  // ---------- capa: o nome do cliente nunca passa de duas linhas ----------
  // o tamanho por contagem de caracteres (data-tam-base) é o ponto de partida; depois mede o que coube e rebaixa g → m → p
  var TAMS = ['g', 'm', 'p'];
  function ajustarTitulo() {
    var h1 = $('pCliente');
    var i = TAMS.indexOf(h1.getAttribute('data-tam-base'));
    if (i < 0) return;
    h1.setAttribute('data-tam', TAMS[i]);
    while (i < 2) {
      var lh = parseFloat(getComputedStyle(h1).lineHeight);
      var larga = h1.scrollWidth > h1.clientWidth + 1;   // palavra que não cabe na largura também rebaixa
      if (!(lh > 0) || (h1.getBoundingClientRect().height <= lh * 2.4 && !larga)) break;
      h1.setAttribute('data-tam', TAMS[++i]);
    }
  }

  // ---------- flutuante do WhatsApp: some enquanto a capa, os depoimentos ou a folha estão na tela ----------
  function iniciarFlutuante() {
    var fl = $('waFloat');
    if (!('IntersectionObserver' in window)) { fl.classList.remove('oculto'); return; }
    var dentro = [];
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var i = dentro.indexOf(e.target);
        if (e.isIntersecting && i < 0) dentro.push(e.target); else if (!e.isIntersecting && i >= 0) dentro.splice(i, 1);
      });
      fl.classList.toggle('oculto', dentro.length > 0);
    }, { threshold: 0 });
    io.observe(document.querySelector('.capa'));
    io.observe($('investimento'));
    io.observe($('secDepoimentos'));
  }

  // ---------- capa: o zoom lento das janelas pausa fora da tela ----------
  function iniciarCapa() {
    var capa = document.querySelector('.capa');
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (es) { capa.classList.toggle('parada', !es[0].isIntersecting); }, { threshold: 0.02 }).observe(capa);
    document.addEventListener('visibilitychange', function () { capa.classList.toggle('parada', document.hidden); });
  }

  // ---------- faixa de trabalhos: setas, arrastar com o mouse, barra de progresso ----------
  var arrastou = false;
  function iniciarStrip() {
    var strip = $('strip'), bar = $('stripBar');
    if (!strip) return;
    var passo = function () { var c = strip.querySelector('.card'); return c ? c.getBoundingClientRect().width + parseFloat(getComputedStyle(strip).columnGap || 22) : 300; };
    var atualizar = function () {
      var max = strip.scrollWidth - strip.clientWidth; if (max <= 0) return;
      var razao = strip.clientWidth / strip.scrollWidth, pos = strip.scrollLeft / max;
      bar.style.width = (razao * 100) + '%'; bar.style.transform = 'translateX(' + (pos * (100 / razao - 100)) + '%)';
      document.querySelector('.strip-btn[data-dir="-1"]').disabled = strip.scrollLeft <= 2;
      document.querySelector('.strip-btn[data-dir="1"]').disabled = strip.scrollLeft >= max - 2;
    };
    strip.addEventListener('scroll', atualizar, { passive: true });
    window.addEventListener('resize', atualizar);
    atualizar();
    document.querySelectorAll('.strip-btn').forEach(function (b) {
      b.addEventListener('click', function () { strip.scrollBy({ left: passo() * parseInt(b.getAttribute('data-dir'), 10), behavior: reduce ? 'auto' : 'smooth' }); });
    });
    var x0 = 0, s0 = 0, baixo = false;
    strip.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') return; baixo = true; arrastou = false; x0 = e.clientX; s0 = strip.scrollLeft; });
    window.addEventListener('pointermove', function (e) { if (!baixo) return; var dx = e.clientX - x0; if (Math.abs(dx) > 6) { arrastou = true; strip.classList.add('dragging'); } if (arrastou) strip.scrollLeft = s0 - dx; });
    window.addEventListener('pointerup', function () { if (!baixo) return; baixo = false; setTimeout(function () { strip.classList.remove('dragging'); arrastou = false; }, 50); });
  }

  // ---------- cards de trabalho: na página modelo, abrem a folha que explica onde entra o vídeo ou a galeria ----------
  function iniciarCards() {
    document.querySelectorAll('.card').forEach(function (c) {
      c.addEventListener('click', function () {
        if (arrastou) return;
        var capaImg = c.querySelector('img');
        $('folhaVideoImg').src = capaImg ? (capaImg.currentSrc || capaImg.src) : '';
        $('folhaVideoTrabalho').textContent = 'Exemplo: ' + c.getAttribute('data-title') + '.';
        abrirFolha($('folhaVideo'));
      });
    });
  }

  function iniciarReveal() {
    var itens = document.querySelectorAll('.reveal');
    if (!('IntersectionObserver' in window)) { itens.forEach(function (x) { x.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
    itens.forEach(function (x) { io.observe(x); });
  }
})();
