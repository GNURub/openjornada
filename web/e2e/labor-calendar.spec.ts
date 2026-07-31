import { expect, test, type Page } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@example.com');
  await page.getByLabel('Contraseña').fill('TestPassword123!');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(/\/$/);
  await acknowledgePrivacyNotice(page);
}

test('an admin configures the workplace and reviews holidays before importing', async ({
  page,
}) => {
  let imported = false;
  let importPayload: { year: number; dates: string[] } | null = null;

  await page.route('**/api/openjornada/labor-calendar/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const provider = {
      name: 'Calendarios Nacionales',
      url: 'https://calendariosnacionales.com/es/api/',
    };
    if (url.pathname.endsWith('/communities')) {
      await route.fulfill({
        json: { items: [{ code: 'VAL', slug: 'val', name: 'Comunitat Valenciana' }], provider },
      });
      return;
    }
    if (url.pathname.endsWith('/provinces')) {
      await route.fulfill({
        json: { items: [{ code: '46', slug: 'valencia', name: 'Valencia' }], provider },
      });
      return;
    }
    if (url.pathname.endsWith('/municipalities')) {
      await route.fulfill({
        json: { items: [{ ine: '46250', slug: 'valencia', name: 'València' }], provider },
      });
      return;
    }
    if (url.pathname.endsWith('/preview')) {
      const existing = imported;
      await route.fulfill({
        json: {
          year: 2026,
          location: {
            communityName: 'Comunitat Valenciana',
            provinceName: 'Valencia',
            municipalityName: 'València',
            municipalityIne: '46250',
          },
          generatedAt: '2025-10-28T00:00:00Z',
          confidence: 'verified',
          warnings: [],
          disclaimer: 'Consulta siempre las fuentes oficiales.',
          provider,
          items: [
            {
              date: '2026-01-01',
              name: 'Año Nuevo',
              scope: 'nacional',
              source: 'BOE',
              sourceUrl: 'https://www.boe.es/',
              existing,
              existingName: existing ? 'Año Nuevo' : '',
            },
            {
              date: '2026-04-13',
              name: 'San Vicente Ferrer',
              scope: 'autonomico',
              source: 'DOGV',
              sourceUrl: 'https://dogv.gva.es/',
              existing: true,
              existingName: 'San Vicente Ferrer',
            },
            {
              date: '2026-10-09',
              name: 'Día de la Comunitat Valenciana',
              scope: 'local',
              source: 'DOGV',
              sourceUrl: 'https://dogv.gva.es/',
              existing,
              existingName: existing ? 'Día de la Comunitat Valenciana' : '',
            },
          ],
        },
      });
      return;
    }
    if (url.pathname.endsWith('/import') && request.method() === 'POST') {
      importPayload = request.postDataJSON() as { year: number; dates: string[] };
      imported = true;
      await route.fulfill({ status: 201, json: { year: 2026, imported: 2, skipped: 0 } });
      return;
    }
    await route.abort();
  });

  await signIn(page);
  await page.goto('/ajustes');
  await expect(page.getByRole('heading', { name: 'Dirección y calendario laboral' })).toBeVisible();

  await page.getByLabel('Dirección', { exact: true }).fill('Carrer de Colón, 1');
  await page.getByLabel('Código postal').fill('46004');
  await page.getByLabel('Comunidad autónoma').selectOption('val');
  await page.getByLabel('Provincia').selectOption('valencia');
  await page.getByLabel('Municipio').selectOption('valencia');

  await expect(page.getByText('València · Valencia · Comunitat Valenciana')).toBeVisible();
  await page.getByRole('button', { name: 'Guardar y revisar festivos' }).click();
  await expect(page.getByText('Propuesta para València · 2026')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /San Vicente Ferrer/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Importar 2 festivos' })).toBeEnabled();

  await page.getByRole('button', { name: 'Importar 2 festivos' }).click();
  await expect(page.getByText('2 festivos importados.')).toBeVisible();
  expect(importPayload).toEqual({
    year: 2026,
    dates: ['2026-01-01', '2026-10-09'],
  });
  await expect(page.getByRole('button', { name: 'Importar 0 festivos' })).toBeDisabled();

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});
