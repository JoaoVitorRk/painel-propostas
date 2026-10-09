'use strict';
// Auditoria: nenhum dado de cliente real dentro do repositório.
//   node testes-e2e/auditoria.js
//
// A lista de termos proibidos (nomes, telefones e textos do cliente de origem) NÃO fica no repositório público.
// Para auditar, crie testes-e2e/termos-proibidos.txt (um termo por linha; o arquivo está no .gitignore).
// Sem o arquivo, a auditoria só avisa e passa.

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const LISTA = path.join(__dirname, 'termos-proibidos.txt');
const PROIBIDOS = fs.existsSync(LISTA)
  ? fs.readFileSync(LISTA, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  : [];

const PULAR_PASTAS = new Set(['node_modules', '.git', '.wrangler', 'prints']);
const PULAR_ARQUIVOS = new Set(['.dev.vars', 'termos-proibidos.txt']);
const BINARIOS = /\.(png|jpe?g|webp|gif|ico|svgz|mp4|webm|mov|mp3|woff2?|ttf|otf|sqlite|sqlite-wal|sqlite-shm|zip|pdf)$/i;

function arquivos(dir, lista = []) {
  for (const nome of fs.readdirSync(dir)) {
    const p = path.join(dir, nome);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (!PULAR_PASTAS.has(nome)) arquivos(p, lista); }
    else if (!PULAR_ARQUIVOS.has(nome) && !BINARIOS.test(nome) && st.size < 5 * 1024 * 1024) lista.push(p);
  }
  return lista;
}

// devolve [{arquivo, linha, termo}] (vazio = repositório limpo)
function auditar() {
  const achados = [];
  if (!PROIBIDOS.length) return achados;
  for (const arq of arquivos(BASE_DIR)) {
    fs.readFileSync(arq, 'utf8').split(/\r?\n/).forEach((l, i) => {
      const baixa = l.toLowerCase();
      for (const termo of PROIBIDOS) {
        if (baixa.includes(termo.toLowerCase())) achados.push({ arquivo: path.relative(BASE_DIR, arq), linha: i + 1, termo });
      }
    });
  }
  return achados;
}

// para a página da proposta: algum termo proibido no texto?
function termosNoTexto(texto) {
  const baixa = String(texto || '').toLowerCase();
  return PROIBIDOS.filter(t => baixa.includes(t.toLowerCase()));
}

function rodar() {
  console.log('\nAuditoria (nenhum dado de cliente real no repositório)');
  const r = { nome: 'auditoria', ok: 0, falhas: [], avisos: [] };
  if (!PROIBIDOS.length) {
    r.ok = 1;
    r.avisos.push('sem testes-e2e/termos-proibidos.txt: auditoria pulada');
    console.log('  aviso   sem testes-e2e/termos-proibidos.txt: auditoria pulada');
    return r;
  }
  const achados = auditar();
  if (!achados.length) { r.ok = 1; console.log('  ok      nenhum termo proibido nos arquivos de texto'); }
  else {
    achados.forEach(a => r.falhas.push(`${a.arquivo}:${a.linha} tem um termo proibido (${a.termo.length} letras)`));
    console.log(`  FALHOU  ${achados.length} ocorrência(s):\n          ` + r.falhas.join('\n          '));
  }
  return r;
}

module.exports = { auditar, termosNoTexto, rodar };
if (require.main === module) process.exit(rodar().falhas.length ? 1 : 0);
