// Dados fictícios da demonstração pública (painel.rkperformance.com.br, "entrar como visitante").
//
// gerarDemo(hojeISO) devolve as 18 linhas prontas para a tabela `propostas` (todas as colunas), com as
// datas contadas a partir de "hoje" (data de Brasília, AAAA-MM-DD): a agenda sempre parece viva, com
// eventos chegando, propostas aguardando resposta e vendas recentes. A API só usa isto com DEMO = "1"
// e só mexe nas linhas cujo id começa com DEMO_PREFIXO (as propostas criadas no painel ficam).
//
//   d(n)   = hoje + n dias
//   sab(n) = o primeiro sábado em hoje + n dias ou depois; com n negativo, o último sábado em hoje + n ou antes
//   dia(n) = hoje + n dias, em qualquer dia da semana (eventos corporativos caem em dia útil)
//
// O negócio de exemplo é o Aurora Studio, um estúdio fictício de foto e vídeo de eventos: casamentos,
// formaturas, aniversários, eventos corporativos, batizados e bodas. Tudo aqui é inventado (clientes,
// locais, mensagem). Nenhum dado de cliente real. As cidades variam de estado (SP, RJ, MG, SC, PR) para
// a agenda não parecer regional. A 11 (Isabela & Rodrigo) fica em sab(13): a primeira tela (agenda do
// mês atual, ou do próximo no fim do mês) mostra os três estados: evento fechado, proposta aguardando
// resposta e sábado livre.

export const DEMO_PREFIXO = '00000000-0000-4000-8000-';

// Colunas da tabela `propostas`, na ordem do schema.sql
export const COLUNAS = ['id', 'slug', 'status', 'etapa', 'cliente', 'data_evento', 'dados', 'fechamento', 'valor_fechado',
  'fechado_em', 'criado_em', 'atualizado_em', 'views', 'primeira_vista', 'ultima_vista'];

// Modelo padrão genérico (ESPEC §7, o mesmo do schema.sql), sem validade_dias: é a base dos dados de cada proposta.
const MODELO = {
  tipo: 'Casamento',
  rotulos: { pacote_a: 'Evento', pacote_b: 'Evento + ensaio', nota_b: 'Inclui um ensaio fotográfico antes do evento, no lugar que vocês escolherem' },
  opcoes: {
    simples: { on: true, nome: 'Essencial', clima: 'O essencial, bem feito', itens: '1 fotógrafo\n6 horas de cobertura\n300 fotos editadas\nGaleria online', cerimonia: 2400, cerimonia_recepcao: 3100, ver_cerimonia: true, ver_recepcao: true },
    media: { on: true, nome: 'Completa', clima: 'Foto e vídeo do começo ao fim', itens: '2 fotógrafos\n10 horas de cobertura\n600 fotos editadas\nVídeo resumo de 3 minutos', cerimonia: 4200, cerimonia_recepcao: 4900, ver_cerimonia: true, ver_recepcao: true },
    completa: { on: true, nome: 'Premium', clima: 'O dia inteiro, em foto e filme', itens: '2 fotógrafos e 1 videomaker\nDia inteiro\n900 fotos editadas\nFilme de 10 minutos e teaser', cerimonia: 6800, cerimonia_recepcao: 7500, ver_cerimonia: false, ver_recepcao: true },
  },
  ordem: ['completa', 'media', 'simples'],
  inclui: 'Galeria online com download em alta\nEdição de cor em todas as fotos\nReunião de alinhamento antes do evento',
  adicionais: [
    { nome: 'Álbum impresso 30×30', descricao: '40 páginas, capa em linho', valor: 900 },
    { nome: 'Imagens de drone', descricao: '', valor: 600 },
    { nome: 'Segundo videomaker', descricao: '', valor: 1200 },
    { nome: 'Entrega expressa em 7 dias', descricao: '', valor: null },
  ],
  condicoes: '30% na reserva da data\nRestante até 7 dias antes do evento\nPix ou cartão em até 10x',
};

const MENSAGEM_EXEMPLO = 'Marina e Rafael, que alegria receber o pedido de vocês! Montei esta proposta pensando no que me '
  + 'contaram: a cerimônia no fim da tarde, a luz do bosque e a festa até de madrugada. Vejam com calma e me chamem '
  + 'se quiserem ajustar qualquer detalhe. Vai ser lindo.';

// A tabela da ESPEC §8. Campos:
//   sab: n do sábado do evento · dia: n de um dia qualquer (vale no lugar de sab)
//   fechou/perdeu: n do dia do fechamento ou do "não fechou"
//   criado/atualizado: n dos dias (quando a tabela não diz, vêm de regras coerentes, ver linhaDe)
//   views: [quantas, n da primeira, n da última] · validade: n do dia em que a proposta vence
const PROPOSTAS = [
  { nn: 1, cliente: 'Marina & Rafael', tipo: 'Casamento', slug: 'exemplo', etapa: 'aberta', sab: 230, hora: '16:00', local: 'Capela do Bosque · Campinas',
    sugestao: 'media', mensagem: MENSAGEM_EXEMPLO, criado: -9, atualizado: -3, validade: 21, views: [4, -3, -1] },
  { nn: 2, cliente: 'Beatriz & Thiago', tipo: 'Casamento', etapa: 'fechada', sab: 20, hora: '16:00', local: 'Igreja Matriz · Niterói',
    fechou: -140, fech: ['completa', 'cerimonia_recepcao', 7500, [['Álbum impresso 30×30', 900]]], vistas: 5,
    pag: { restanteVence: -3 } },   // restante combinado para antes e ainda não pago: aparece em Atrasados
  { nn: 3, cliente: 'Formatura Medicina · Turma 48', tipo: 'Formatura', etapa: 'fechada', sab: 20, hora: '20:00', local: 'Clube Curitibano · Curitiba',
    fechou: -95, fech: ['simples', 'cerimonia', 2400], vistas: 3,
    pag: { restantePago: -10 } },   // pagou o restante adiantado: tudo recebido
  { nn: 4, cliente: 'Helena · 15 anos', tipo: 'Aniversário de 15 anos', etapa: 'fechada', sab: 48, hora: '19:00', local: 'Espaço Villa · Florianópolis',
    fechou: -60, fech: ['media', 'cerimonia_recepcao', 4900], vistas: 4 },
  { nn: 5, cliente: 'Lançamento Vértice Arquitetura', tipo: 'Evento corporativo', etapa: 'fechada', dia: 5, hora: '19:30', local: 'Hotel Nacional · Belo Horizonte',
    fechou: -33, fech: ['media', 'cerimonia', 4200], vistas: 2 },
  { nn: 6, cliente: 'Fernanda & Caetano', tipo: 'Casamento', etapa: 'fechada', sab: 120, hora: '15:00', local: 'Paróquia Nossa Senhora · Londrina',
    fechou: -12, fech: ['completa', 'cerimonia_recepcao', 7500, [['Imagens de drone', 600], ['Segundo videomaker', 1200]]], vistas: 6 },
  { nn: 7, cliente: 'Batizado do Miguel', tipo: 'Batizado', etapa: 'fechada', sab: 190, hora: '10:00', local: 'Capela São Francisco · Campinas',
    fechou: -5, fech: ['simples', 'cerimonia_recepcao', 3100], vistas: 3 },
  { nn: 8, cliente: 'Aline & Bruno', tipo: 'Casamento', etapa: 'fechada', sab: 260, hora: '17:30', local: 'Igreja Matriz · São Paulo',
    fechou: -2, fech: ['completa', 'cerimonia', 6800], vistas: 2,
    pag: { sinalVence: 3, sinalPendente: true } },   // fechou há 2 dias e o sinal vence daqui a 3
  { nn: 9, cliente: 'Bodas de prata · Lúcia & Antônio', tipo: 'Bodas', etapa: 'fechada', sab: -30, hora: '16:00', local: 'Capela do Bosque · Campinas',
    fechou: -200, fech: ['media', 'cerimonia_recepcao', 4900], vistas: 4 },
  { nn: 10, cliente: 'Formatura Direito · Turma 2026', tipo: 'Formatura', etapa: 'fechada', sab: -75, hora: '20:00', local: 'Teatro Municipal · Belo Horizonte',
    fechou: -230, fech: ['simples', 'cerimonia', 2400], vistas: 2 },
  { nn: 11, cliente: 'Isabela & Rodrigo', tipo: 'Casamento', etapa: 'aberta', sab: 13, hora: '16:00', local: 'Igreja Matriz · São Paulo',
    criado: -18, validade: 12, views: [2, -17, -6] },
  { nn: 12, cliente: 'Cláudia · 50 anos', tipo: 'Aniversário', etapa: 'aberta', sab: 160, hora: '17:00', local: 'Espaço Jardim · Campinas',
    criado: -3, validade: 27, views: [0] },
  { nn: 13, cliente: 'Vanessa & Leonardo', tipo: 'Casamento', etapa: 'aberta', sab: 48, hora: '11:00', local: 'Capela Santa Luzia · Florianópolis',
    criado: -27, validade: 3, views: [1, -25, -25] },
  { nn: 14, cliente: 'Convenção Prisma 2027', tipo: 'Evento corporativo', etapa: 'aberta', dia: 100, hora: '09:00', local: 'Centro de Eventos · Curitiba',
    criado: -34, validade: -4, views: [3, -33, -20] },
  { nn: 15, cliente: 'Sofia & Daniel', tipo: 'Casamento', etapa: 'aberta', rascunho: true, sab: 400, hora: '', local: '',
    criado: -1, validade: 29, views: [0] },
  { nn: 16, cliente: 'Carolina & Eduardo', tipo: 'Casamento', etapa: 'perdida', sab: 140, hora: '16:00', local: 'Igreja Matriz · Niterói',
    perdeu: -20, motivo: 'Fechou com outro fornecedor', vistas: 3 },
  { nn: 17, cliente: 'Formatura Engenharia · Turma 12', tipo: 'Formatura', etapa: 'perdida', sab: 210, hora: '20:00', local: 'Clube Curitibano · Curitiba',
    perdeu: -45, motivo: 'Achou o valor alto', vistas: 2 },
  { nn: 18, cliente: 'Priscila & Marcelo', tipo: 'Casamento', etapa: 'perdida', sab: 90, hora: '15:30', local: 'Espaço Jardim · Maringá',
    perdeu: -70, motivo: 'Mudou os planos', vistas: 1 },
];

// Horários (UTC) dos carimbos: todos entre 12h e 24h UTC, então o dia em UTC é o mesmo dia em Brasília (UTC−3).
const H_CRIADO = 'T13:00:00.000Z';      // 10h em Brasília
const H_EDITADO = 'T14:20:00.000Z';     // última edição antes de mandar
const H_PRIMEIRA = 'T23:15:00.000Z';    // o cliente abre à noite
const H_ULTIMA = 'T22:40:00.000Z';
const H_FECHOU = 'T19:30:00.000Z';      // quando o dono marcou "fechou" / "não fechou"

export function gerarDemo(hojeISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hojeISO))) throw new Error('gerarDemo: data inválida');
  const d = n => somarDias(hojeISO, n);
  return PROPOSTAS.map(c => linhaDe(c, d, n => sabado(hojeISO, n), hojeISO));
}

function linhaDe(c, d, sab, hojeISO) {
  const nn = String(c.nn).padStart(2, '0');
  const status = c.rascunho ? 'rascunho' : 'publicada';
  const data = c.dia !== undefined ? d(c.dia) : sab(c.sab);

  // Fechadas: proposta criada 12 dias antes do fechamento. Perdidas: 15 dias antes do "não fechou".
  // Validade = criação + 30 dias (o validade_dias do modelo), a não ser que a tabela diga outra.
  const fim = c.etapa === 'fechada' ? c.fechou : c.etapa === 'perdida' ? c.perdeu : null;
  const criado = c.criado ?? (c.etapa === 'fechada' ? fim - 12 : fim - 15);
  const validade = c.validade ?? criado + 30;

  // aberturas: nas abertas vêm da tabela; nas outras, a primeira no dia seguinte à criação e a última
  // pouco antes do fechamento (fechadas) ou 4 dias depois da criação (perdidas)
  let views, primeira = null, ultima = null;
  if (c.views) {
    [views] = c.views;
    if (views > 0) { primeira = c.views[1]; ultima = c.views[2]; }
  } else {
    views = c.vistas;
    primeira = criado + 1;
    ultima = views > 1 ? (c.etapa === 'fechada' ? fim - 1 : criado + 4) : primeira;
  }

  let fechamento = null, valor_fechado = null, fechado_em = null, atualizado_em;
  if (c.etapa === 'fechada') {
    const [opcao, pacote, valor, adicionais = []] = c.fech;
    fechado_em = d(fim);
    fechamento = { opcao, pacote, valor, data: fechado_em, obs: '' };
    if (adicionais.length) fechamento.adicionais = adicionais.map(([nome, v]) => ({ nome, valor: v }));
    valor_fechado = valor + adicionais.reduce((s, [, v]) => s + v, 0);
    fechamento.pagamentos = pagamentosDemo(c.pag || {}, d, data, fechado_em, valor_fechado, hojeISO);
    atualizado_em = d(fim) + H_FECHOU;        // marcar a etapa atualiza a proposta, como na API
  } else if (c.etapa === 'perdida') {
    fechado_em = d(fim);
    fechamento = { motivo: c.motivo };
    atualizado_em = d(fim) + H_FECHOU;
  } else {
    atualizado_em = c.atualizado !== undefined ? d(c.atualizado) + H_EDITADO : d(criado) + H_CRIADO;
  }

  // mesmo formato e mesma ordem de chaves que limpar() devolve, mais a marca interna de "já foi publicada"
  const dados = {
    cliente: c.cliente,
    tipo: c.tipo || MODELO.tipo,
    rotulos: copia(MODELO.rotulos),
    data,
    hora: c.hora,
    local: c.local,
    mensagem: c.mensagem || '',
    opcoes: copia(MODELO.opcoes),
    ordem: [...MODELO.ordem],
    sugestao: c.sugestao || '',
    inclui: MODELO.inclui,
    adicionais: copia(MODELO.adicionais),
    condicoes: MODELO.condicoes,
    validade: d(validade),
    observacoes: '',
    secoes: { videos: true, depoimentos: true },
  };
  if (status === 'publicada') dados._publicada_alguma_vez = true;

  const primeira_vista = primeira === null ? null : d(primeira) + H_PRIMEIRA;
  const ultima_vista = primeira === null ? null : views === 1 ? primeira_vista : d(ultima) + H_ULTIMA;

  return {
    id: `${DEMO_PREFIXO}0000000000${nn}`,
    slug: c.slug || slugDe(c.cliente),
    status,
    etapa: c.etapa,
    cliente: c.cliente,
    data_evento: data,
    dados: JSON.stringify(dados),
    fechamento: fechamento && JSON.stringify(fechamento),
    valor_fechado,
    fechado_em,
    criado_em: d(criado) + H_CRIADO,
    atualizado_em,
    views,
    primeira_vista,
    ultima_vista,
  };
}

// "Débora & Henrique" → "debora-e-henrique" · "Helena · 15 anos" → "helena-15-anos" (sem sufixo aleatório: o prefixo do id já separa a demo)
function slugDe(cliente) {
  return cliente.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' e ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// sábado: n ≥ 0 → o primeiro em hoje + n ou depois; n < 0 → o último em hoje + n ou antes
export function sabado(hojeISO, n) {
  const alvo = somarDias(hojeISO, n);
  const dia = new Date(`${alvo}T12:00:00Z`).getUTCDay();   // 0 = domingo … 6 = sábado
  return n >= 0 ? somarDias(alvo, (6 - dia + 7) % 7) : somarDias(alvo, -((dia + 1) % 7));
}

// Financeiro da demo (ESPEC §8.1): sinal de 10% recebido no dia em que fechou; restante 5 dias antes do evento,
// já recebido quando o evento passou. `pag` troca um caso para a aba Financeiro mostrar atrasado, pago antes e sinal pendente.
function pagamentosDemo(pag, d, dataEvento, fechadoEm, total, hojeISO) {
  const sinal = Math.round(total * 10 / 100);
  const venceRestante = pag.restanteVence !== undefined ? d(pag.restanteVence) : somarDias(dataEvento, -5);
  const restantePago = pag.restantePago !== undefined ? d(pag.restantePago) : (dataEvento < hojeISO ? venceRestante : '');
  return [
    { tipo: 'sinal', valor: sinal, vence_em: pag.sinalVence !== undefined ? d(pag.sinalVence) : fechadoEm, pago_em: pag.sinalPendente ? '' : fechadoEm },
    { tipo: 'restante', valor: total - sinal, vence_em: venceRestante, pago_em: restantePago },
  ];
}

// ---------- contatos (ESPEC §8.3) ----------
// Quem pediu preço: 12 contatos fictícios, 10 ligados a propostas da tabela acima (nn) e 2 ainda sem proposta,
// com lembrete. As origens contam uma história no relatório "De onde vêm": o Instagram traz mais e fecha mais.
// O WhatsApp é fictício (DDD da cidade + 90000-01NN); o visitante nunca abre o wa.me, só vê a mensagem.
export const COLUNAS_CONTATO = ['id', 'nome', 'whatsapp', 'origem', 'data_evento', 'obs', 'lembrete_em', 'lembrete_txt',
  'proposta_id', 'criado_em', 'atualizado_em'];

//   p: nn da proposta · ddd: DDD do WhatsApp ('' = sem WhatsApp) · lembrete: [n do dia, texto]
//   sem proposta: sab/dia do evento e criado (n)
const CONTATOS = [
  { nn: 1, nome: 'Marina & Rafael', origem: 'instagram', p: 1, ddd: '19', obs: 'Viram o filme do casamento no bosque',
    lembrete: [0, 'Perguntar se ficou alguma dúvida'] },
  { nn: 2, nome: 'Beatriz & Thiago', origem: 'portal', p: 2, ddd: '21', obs: '' },
  { nn: 3, nome: 'Formatura Medicina · Turma 48', origem: 'indicacao', p: 3, ddd: '41', obs: 'Indicação da comissão da Turma 47' },
  { nn: 4, nome: 'Helena · 15 anos', origem: 'instagram', p: 4, ddd: '48', obs: 'Quem falou foi a mãe, Patrícia' },
  { nn: 5, nome: 'Lançamento Vértice Arquitetura', origem: 'google', p: 5, ddd: '31', obs: 'Precisa de nota fiscal' },
  { nn: 6, nome: 'Fernanda & Caetano', origem: 'instagram', p: 6, ddd: '43', obs: '' },
  { nn: 7, nome: 'Isabela & Rodrigo', origem: 'portal', p: 11, ddd: '11', obs: 'Querem o álbum, mas acham o prazo curto',
    lembrete: [-1, 'Responder a dúvida sobre o álbum'] },
  { nn: 8, nome: 'Vanessa & Leonardo', origem: 'instagram', p: 13, ddd: '48', obs: '' },
  { nn: 9, nome: 'Carolina & Eduardo', origem: 'portal', p: 16, ddd: '21', obs: '' },
  { nn: 10, nome: 'Formatura Engenharia · Turma 12', origem: 'google', p: 17, ddd: '41', obs: '' },
  { nn: 11, nome: 'Rafaela & Otávio', origem: 'whatsapp', sab: 320, criado: -2, ddd: '11', obs: 'Casamento na praia, ainda sem local fechado',
    lembrete: [2, 'Mandar a proposta'] },
  { nn: 12, nome: 'Clínica Ser · confraternização', origem: 'indicacao', dia: 60, criado: 0, ddd: '', obs: 'Falar com a Renata, do RH. Pediu por e-mail',
    lembrete: [0, 'Mandar a proposta'] },
];

// `linhas` = o que gerarDemo devolveu para o mesmo dia (o contato nasce 1 dia antes da proposta dele)
export function gerarContatosDemo(hojeISO, linhas = gerarDemo(hojeISO)) {
  const d = n => somarDias(hojeISO, n);
  const porNn = n => linhas[n - 1];
  return CONTATOS.map(c => {
    const nn = String(c.nn).padStart(2, '0');
    const prop = c.p ? porNn(c.p) : null;
    const criado = prop ? somarDias(prop.criado_em.slice(0, 10), -1) + H_CRIADO : d(c.criado) + H_CRIADO;
    return {
      id: `${DEMO_PREFIXO}0000000001${nn}`,
      nome: c.nome,
      whatsapp: c.ddd ? `${c.ddd}900000${String(100 + c.nn)}` : '',
      origem: c.origem,
      data_evento: prop ? prop.data_evento : c.dia !== undefined ? d(c.dia) : sabado(hojeISO, c.sab),
      obs: c.obs,
      lembrete_em: c.lembrete ? d(c.lembrete[0]) : null,
      lembrete_txt: c.lembrete ? c.lembrete[1] : '',
      proposta_id: prop ? prop.id : null,
      criado_em: criado,
      atualizado_em: criado,
    };
  });
}

export function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const copia = v => JSON.parse(JSON.stringify(v));
