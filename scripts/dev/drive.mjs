// Drives the web app in headless Chrome, for checking a change and taking screenshots.
// For development only; it is not part of the office and nothing runs it by itself.
//
//   BASE=http://localhost:8790 node scripts/dev/drive.mjs <width> <height> '<json steps>'
//
// Point it at a demo office (BUREAU_DEMO=1 on another port), not the real one: each run is a
// new browser, which the real office would list as another "This Mac" device.
// Steps are arrays: ["goto","/path"] ["wait",ms] ["shot","name"] ["shot","name","full"]
// ["click","selector"] ["clickText","text"] ["role","button","name"] ["fill","selector","text"]
// ["files","input[type=file]","/path"] ["clip","selector","name"] ["type","text"] ["press","Enter"]
// ["eval","js expression"]. Screenshots are written as <name>.png in the current directory.
// A width under 500 is treated as a phone. Needs Google Chrome installed.
import { chromium } from 'playwright-core';
const [w, h, json] = process.argv.slice(2);
const steps = JSON.parse(json);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1, hasTouch: +w < 500, isMobile: +w < 500 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
const base = process.env.BASE || 'http://localhost:8790';
for (const [op, a, b] of steps) {
  try {
    if (op === 'goto') { await page.goto(base + a, { waitUntil: 'networkidle' }); await page.waitForTimeout(350); }
    else if (op === 'shot') await page.screenshot({ path: `${a}.png`, fullPage: b === 'full' });
    else if (op === 'click') await page.click(a, { timeout: 4000 });
    else if (op === 'clickText') await page.getByText(a, { exact: b !== 'loose' }).first().click({ timeout: 4000 });
    else if (op === 'role') await page.getByRole(a, { name: b }).first().click({ timeout: 4000 });
    else if (op === 'fill') await page.fill(a, b, { timeout: 4000 });
    else if (op === 'files') await page.setInputFiles(a, b);
    else if (op === 'clip') { const el = await page.$(a); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(200); await el.screenshot({ path: `${b}.png` }); }
    else if (op === 'type') await page.keyboard.type(a);
    else if (op === 'press') await page.keyboard.press(a);
    else if (op === 'wait') await page.waitForTimeout(a);
    else if (op === 'eval') console.log('eval:', JSON.stringify(await page.evaluate(a)));
  } catch (e) { console.log(`STEP FAILED ${op} ${a}: ${String(e.message).split('\n')[0]}`); }
}
if (errors.length) console.log('CONSOLE ERRORS:\n' + [...new Set(errors)].join('\n'));
await browser.close();
