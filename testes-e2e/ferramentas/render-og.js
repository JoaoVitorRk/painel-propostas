// Gera site/media/og-painel.jpg e site/media/og-proposta.jpg (1200x630) renderizando og.html no Chrome.
//   node testes-e2e/ferramentas/render-og.js
// Precisa de internet (fontes do Google Fonts e fotos do Unsplash). Depois, abra as duas imagens e confira.
const path = require('path');
const fs = require('fs');
const PW = process.env.PW_JS || path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', 'e41f203b7505f1fb', 'node_modules', 'playwright');
const { chromium } = require(PW);

const DESTINO = path.resolve(__dirname, '..', '..', 'site', 'media');
const PAGINA = 'file:///' + path.join(__dirname, 'og.html').replace(/\\/g, '/');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1300, height: 1400 }, deviceScaleFactor: 1 });
  const falhas = [];
  page.on('requestfailed', r => falhas.push('falhou: ' + r.url()));
  await page.goto(PAGINA, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })));
  });
  const fontes = await page.evaluate(() => [['Jost', '200'], ['Jost', '500'], ['DM Mono', '400']].map(([f, w]) => f + ' ' + w + ': ' + document.fonts.check(w + ' 20px "' + f + '"')));
  console.log('fontes', fontes.join(' | '));
  if (falhas.length) console.log(falhas.join('\n'));
  fs.mkdirSync(DESTINO, { recursive: true });
  for (const id of ['painel', 'proposta']) {
    const alvo = path.join(DESTINO, 'og-' + id + '.jpg');
    await page.locator('#' + id).screenshot({ path: alvo, type: 'jpeg', quality: 86 });
    console.log('ok', alvo, fs.statSync(alvo).size, 'bytes');
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
