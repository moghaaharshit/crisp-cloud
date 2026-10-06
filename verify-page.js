// Verification: load the storefront/admin page in headless Chrome and report any JS errors.
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push('CONSOLE: ' + msg.text());
  });

  await page.goto('http://localhost:5000/index.html', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));

  // The app renders #root children only after React+Babel compile the inline script.
  const rootChildren = await page.evaluate(() => document.getElementById('root').children.length);
  // Confirm our new section keys exist in the compiled script source
  const srcHasWhatsapp = await page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script[type="text/babel"]')];
    return scripts.some(s => s.textContent.includes("label: 'WhatsApp'") && s.textContent.includes('function WhatsAppSection'));
  });
  const appRendered = await page.evaluate(() => document.body.innerText.includes('CRISP'));

  console.log(JSON.stringify({ rootChildren, srcHasWhatsapp, appRendered, errors }, null, 2));
  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(2); });
