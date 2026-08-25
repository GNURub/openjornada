import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const presentationDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(presentationDir, '../..');
const htmlPath = path.join(presentationDir, 'openjornada-presentacion.html');
const pdfPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'output/pdf/openjornada-presentacion-corporativa.pdf');
const qaDir = path.join(repoRoot, 'tmp/presentation/rendered-slides');
const playwrightModule = path.join(repoRoot, 'web/node_modules/@playwright/test/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

await mkdir(path.dirname(pdfPath), { recursive: true });
await mkdir(qaDir, { recursive: true });

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
    path: path.join(qaDir, `slide-${String(index + 1).padStart(2, '0')}.png`),
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
console.log(`PDF creado: ${pdfPath}`);
