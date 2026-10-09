'use strict';
// Roda todos os testes ponta a ponta de uma vez, com um ambiente só (banco local novo + API 8792 + site 8126):
//   node testes-e2e/rodar-tudo.js                 auditoria + visitante + proposta + admin
//   node testes-e2e/rodar-tudo.js proposta admin  só os roteiros escolhidos (a auditoria roda sempre; não precisa de servidor)
//   VER=1 node testes-e2e/rodar-tudo.js           abre o Chrome na tela
//
// Ordem: visitante primeiro (ele confere que o banco fica igual antes e depois do que o visitante faz), depois a
// página da proposta (só leitura, conta aberturas) e por último o administrador (grava e depois apaga o que gravou).
// Prints em testes-e2e/prints/ (os de falha começam com "falha-"). Sai com código 1 se algo falhar.

const fs = require('fs');
const path = require('path');
const A = require('./ambiente');
const auditoria = require('./auditoria');

const ROTEIROS = { visitante: './visitante', proposta: './proposta', admin: './admin', financeiro: './financeiro', hoje: './hoje', contatos: './contatos' };

(async () => {
  const pedidos = process.argv.slice(2).filter(x => ROTEIROS[x]);
  const escolhidos = pedidos.length ? Object.keys(ROTEIROS).filter(k => pedidos.includes(k)) : Object.keys(ROTEIROS);
  const resumos = [auditoria.rodar()];

  // prints de falha de rodadas anteriores saem (os outros são sobrescritos)
  if (fs.existsSync(A.PRINTS)) for (const f of fs.readdirSync(A.PRINTS)) if (/^falha-/.test(f)) fs.rmSync(path.join(A.PRINTS, f));

  let ctx = null, codigo = 1;
  const inicio = Date.now();
  try {
    console.log('');
    ctx = await A.subirTudo();
    for (const nome of escolhidos) {
      try {
        resumos.push(await require(ROTEIROS[nome]).rodar(ctx));
      } catch (e) {
        console.log(`  ERRO no roteiro ${nome}: ${A.redigir((e && e.message) || e)}`);
        resumos.push({ nome, ok: 0, falhas: [`o roteiro parou: ${A.redigir((e && e.message) || e).split('\n')[0]}`], avisos: [] });
      }
    }
  } catch (e) {
    console.error('\nERRO ao montar o ambiente: ' + A.redigir((process.env.PILHA ? e && e.stack : e && e.message) || e));
    resumos.push({ nome: 'ambiente', ok: 0, falhas: [A.redigir((e && e.message) || e).split('\n')[0]], avisos: [] });
  } finally {
    if (ctx) await ctx.fechar(); else A.encerrar();
  }
  codigo = A.imprimirResumo(resumos) ? 1 : 0;
  console.log(`(${Math.round((Date.now() - inicio) / 1000)} s; servidores encerrados; banco local em ${A.PERSIST})`);
  process.exit(codigo);
})();
