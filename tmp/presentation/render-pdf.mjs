import { pathToFileURL } from 'node:url';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const htmlPath = '/home/gnurub/code/factorial/output/presentation/openjornada-presentacion.html';
const pdfPath = '/home/gnurub/code/factorial/output/pdf/openjornada-presentacion-corporativa.pdf';
const qaDir = '/home/gnurub/code/factorial/tmp/presentation/rendered-slides';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1.5,
  colorScheme: 'light',
});
const page = await context.newPage();

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await document.fonts.ready;
  await Promise.all(
    [...document.images].map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', reject, { once: true });
          }),
    ),
  );
});

const slides = page.locator('.slide');
const slideCount = await slides.count();
if (slideCount !== 12) throw new Error(`Se esperaban 12 diapositivas y se encontraron ${slideCount}.`);

for (let index = 0; index < slideCount; index += 1) {
  await slides.nth(index).screenshot({
    path: `${qaDir}/slide-${String(index + 1).padStart(2, '0')}.png`,
  });
}

await page.emulateMedia({ media: 'print' });
await page.pdf({
  path: pdfPath,
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: false,
  tagged: true,
});

await browser.close();
