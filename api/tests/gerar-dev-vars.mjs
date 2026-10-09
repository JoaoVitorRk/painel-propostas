// Gera os segredos de TESTE LOCAL em api/.dev.vars (fora do git):
//   ADMIN_SENHA   senha do painel (o administrador grava de verdade)
//   SESSAO_CHAVE  chave que assina as sessões do modo visitante (só leitura)
//
//   node tests/gerar-dev-vars.mjs            cria o que faltar (mantém o que já existe)
//   node tests/gerar-dev-vars.mjs --forcar   troca as duas por valores novos
//
// Os valores são aleatórios e nunca são impressos: os testes leem direto do arquivo.
// Não têm relação com os secrets de verdade do Worker publicado (wrangler secret put).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arquivo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars');
const NOMES = ['ADMIN_SENHA', 'SESSAO_CHAVE'];
const forcar = process.argv.includes('--forcar');

const atual = !forcar && fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8') : '';
const tem = nome => new RegExp(`^\\s*${nome}\\s*=\\s*\\S`, 'm').test(atual);
const faltam = NOMES.filter(n => !tem(n));

if (!faltam.length) {
  console.log('.dev.vars já tem ADMIN_SENHA e SESSAO_CHAVE (use --forcar para trocar os dois).');
} else {
  const linhas = atual.split(/\r?\n/).filter(l => l.trim() && !faltam.some(n => new RegExp(`^\\s*${n}\\s*=`).test(l)));
  for (const n of faltam) linhas.push(`${n}=${randomBytes(n === 'SESSAO_CHAVE' ? 32 : 24).toString('base64url')}`);
  fs.writeFileSync(arquivo, `${linhas.join('\n')}\n`, { mode: 0o600 });
  console.log(`.dev.vars gravado (${faltam.join(' e ')} ${faltam.length > 1 ? 'novos' : 'novo'}, valores não exibidos).`);
}
