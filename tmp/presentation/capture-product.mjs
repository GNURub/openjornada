import { chromium } from '../../web/node_modules/@playwright/test/index.mjs';

const baseURL = 'http://127.0.0.1:8090';
const outputDir = '/home/gnurub/code/factorial/output/playwright/deck';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1.25,
  colorScheme: 'light',
});
const page = await context.newPage();

async function waitForApp() {
  await page.waitForLoadState('networkidle');
  await page.locator('main').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
}

async function capture(pathname, heading, filename, prepare) {
  await page.goto(`${baseURL}${pathname}`);
  await waitForApp();
  await page.addStyleTag({
    content:
      'div:has(> [data-testid="privacy-notice-modal"]) { display: none !important; }',
  });
  const brandLabel = page.locator('aside > a').first().locator('span > span').first();
  if (await brandLabel.isVisible().catch(() => false)) {
    await brandLabel.evaluate((element) => {
      element.textContent = 'OpenJornada';
    });
  }
  if (heading) {
    await page.getByRole('heading', { name: heading, exact: false }).first().waitFor();
  }
  if (prepare) {
    await prepare(page);
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${outputDir}/${filename}`, fullPage: false });
}

await page.goto(`${baseURL}/login`);
await page.getByLabel('Correo electrónico').fill('admin@example.com');
await page.getByLabel('Contraseña').fill('TestPassword123!');
await page.getByRole('button', { name: 'Entrar', exact: true }).click();
await page.waitForURL(`${baseURL}/`);

await capture('/', /Buenos|Buenas/, '01-panel-principal.png');
await capture('/registros', 'Mi control horario', '02-control-horario.png');
await capture('/ausencias', 'Ausencias', '03-ausencias.png');
await capture('/informes', 'Informe mensual', '04-informes.png');
await capture('/equipo', 'Tu equipo', '05-equipo.png');
await capture('/tareas', 'Tareas del equipo', '06-tareas.png', async (currentPage) => {
  await currentPage.getByRole('button', { name: 'Asignar tarea' }).click();
  await currentPage.getByRole('heading', { name: 'Nueva tarea' }).waitFor();
});
await capture('/documentos', 'Documentos', '07-documentos.png', async (currentPage) => {
  await currentPage.getByRole('button', { name: 'Subir documento' }).click();
  await currentPage.getByRole('heading', { name: 'Nuevo documento' }).waitFor();
});
await capture('/gastos', 'Gastos del equipo', '08-gastos.png');

await browser.close();
