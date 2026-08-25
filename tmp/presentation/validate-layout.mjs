import { pathToFileURL } from 'node:url';
import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const htmlPath = '/home/gnurub/code/factorial/output/presentation/openjornada-presentacion.html';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];

page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const diagnostics = await page.evaluate(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const missingImages = [...document.images]
    .filter((image) => !image.complete || image.naturalWidth === 0)
    .map((image) => image.getAttribute('src'));
  const outside = [];
  const overlapTargets = 'h1, h2, h3, p, a, .screen-caption, .management-quote, .trust-bottom';

  slides.forEach((slide, slideIndex) => {
    const slideBox = slide.getBoundingClientRect();
    slide.querySelectorAll(overlapTargets).forEach((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const box = element.getBoundingClientRect();
      const tolerance = 1;
      if (
        box.left < slideBox.left - tolerance ||
        box.top < slideBox.top - tolerance ||
        box.right > slideBox.right + tolerance ||
        box.bottom > slideBox.bottom + tolerance
      ) {
        outside.push({
          slide: slideIndex + 1,
          selector: element.className || element.tagName,
          text: element.textContent?.trim().slice(0, 80),
        });
      }
    });
  });

  return { slideCount: slides.length, missingImages, outside };
});

if (diagnostics.slideCount !== 12) errors.push(`slideCount: ${diagnostics.slideCount}`);
if (diagnostics.missingImages.length) errors.push(`missingImages: ${diagnostics.missingImages.join(', ')}`);
if (diagnostics.outside.length) errors.push(`outside: ${JSON.stringify(diagnostics.outside)}`);

await browser.close();

if (errors.length) {
  throw new Error(errors.join('\n'));
}

console.log('Layout validado: 12 diapositivas, recursos cargados y texto dentro del lienzo.');
