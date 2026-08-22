import { expect, test, type Page } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@example.com');
  await page.getByLabel('Contraseña').fill('TestPassword123!');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    const authenticated = await page
      .waitForURL(/\/$/u, { timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (authenticated) {
      await acknowledgePrivacyNotice(page);
      return;
    }
    if (attempt === 3) throw new Error('No se pudo iniciar sesión como administración');
    await page.waitForTimeout(3_200);
  }
}

function browserStorage(page: Page) {
  return page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    cookie: document.cookie,
  }));
}

function currentInputValues(page: Page): Promise<string[]> {
  return page
    .locator('input')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}

test('administración aprovisiona por QR sin persistir secretos ni perder el flujo manual', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/integraciones');

  const name = `QR E2E ${testInfo.project.name} ${Date.now()}`;
  await page.getByLabel('Nombre del nuevo terminal').fill(name);
  await page.getByRole('button', { name: 'Crear terminal' }).click();

  let card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
  await expect(card).toBeVisible();
  await expect(
    card.getByText('el QR contiene la contraseña Wi-Fi y la API key completas'),
  ).toBeVisible();

  const tokenInput = card.getByLabel('API key del terminal recién emitida');
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^ojterm_[A-Za-z0-9_-]+$/u);
  await expect(tokenInput).toHaveAttribute('type', 'password');
  await expect(card.getByLabel('Contraseña de la red Wi-Fi')).toHaveAttribute('type', 'password');

  const localRequests: string[] = [];
  page.on('request', (request) => localRequests.push(request.url()));
  const storageBefore = await browserStorage(page);

  await card.getByLabel('Nombre de la red Wi-Fi').fill('Red demo efímera');
  await card.getByLabel('Contraseña de la red Wi-Fi').fill('Clave demo efímera 123!');
  await card.getByLabel('URL de OpenJornada').fill('https://jornada.example.com');
  await card.getByRole('button', { name: 'Generar QR' }).click();

  const qr = card.getByAltText('Código QR para configurar el terminal OpenJornada');
  await expect(qr).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/u);
  expect(localRequests).toEqual([]);
  expect(await browserStorage(page)).toEqual(storageBefore);

  const expand = card.getByRole('button', { name: 'Ampliar código QR' });
  await expand.click();
  const dialog = page.getByRole('dialog', { name: 'Código QR ampliado' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cerrar QR ampliado' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(expand).toBeFocused();

  await card.getByRole('button', { name: 'Ya la he guardado' }).click();
  await expect(card).toHaveCount(0);
  const valuesAfterDismiss = await currentInputValues(page);
  expect(valuesAfterDismiss).not.toContain(token);
  expect(valuesAfterDismiss).not.toContain('Red demo efímera');
  expect(valuesAfterDismiss).not.toContain('Clave demo efímera 123!');

  const row = page.locator('li').filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(token);
  await expect(row).not.toContainText('Red demo efímera');
  await expect(row).not.toContainText('Clave demo efímera 123!');

  page.once('dialog', (confirmation) => confirmation.accept());
  await row.getByRole('button', { name: 'Rotar key' }).click();
  card = page.getByRole('region', { name: 'Aprovisionar terminal con QR' });
  await expect(card).toBeVisible();

  const rotated = await card.getByLabel('API key del terminal recién emitida').inputValue();
  expect(rotated).toMatch(/^ojterm_[A-Za-z0-9_-]+$/u);
  expect(rotated).not.toBe(token);
  await expect(card.getByLabel('Nombre de la red Wi-Fi')).toHaveValue('');
  await expect(card.getByLabel('Contraseña de la red Wi-Fi')).toHaveValue('');
  await expect(card.getByLabel('URL de OpenJornada')).toHaveValue('http://127.0.0.1:4217');
  await expect(card.getByAltText('Código QR para configurar el terminal OpenJornada')).toHaveCount(
    0,
  );
  await expect(row).not.toContainText(rotated);

  await card.getByRole('button', { name: 'Ya la he guardado' }).click();
  await expect(card).toHaveCount(0);
  expect(await currentInputValues(page)).not.toContain(rotated);
  page.once('dialog', (confirmation) => confirmation.accept());
  await row.getByRole('button', { name: 'Revocar' }).click();
  await expect(row.getByText('Revocado')).toBeVisible();
});
