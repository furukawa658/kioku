import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export async function renderIcon(output = fileURLToPath(new URL('./media/brain.png', import.meta.url))) {
  const art = await readFile(new URL('./media/brain-art.svg', import.meta.url), 'utf8');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html, body { margin: 0; background: transparent; } svg { display: block; width: 256px; height: 256px; }</style>${art}`);
    await page.screenshot({ path: output, omitBackground: true });
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await renderIcon(process.argv[2]);
