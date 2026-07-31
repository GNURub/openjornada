import { expect, test } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

async function signIn(
  page: import('@playwright/test').Page,
  email = 'empleada@example.com',
  password = 'DemoPassword123!',
) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForURL(/\/$/);
  await acknowledgePrivacyNotice(page);
}

test('the annual absence overview and request modal adapt to every viewport', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await page.goto('/ausencias');

  await expect(page.getByRole('heading', { name: 'Ausencias', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saldos de' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Peticiones del equipo/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Políticas y saldos' })).toHaveCount(0);
  await expect(page.locator('section[aria-labelledby="annual-calendar-title"] article')).toHaveCount(
    12,
  );
  await expect(page.getByText(/Asuntos propios · \d{4}/)).toHaveCount(0);

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);

  await page.getByRole('button', { name: 'Solicitar ausencia' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Solicitar ausencia' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'Duración de la ausencia' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Selecciona las fechas' }).click();
  await expect(dialog.getByLabel('Desde')).toBeVisible();
  await expect(dialog.getByLabel('Hasta')).toBeVisible();

  const viewport = page.viewportSize();
  const dialogBox = await dialog.boundingBox();
  expect(viewport).not.toBeNull();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(dialogBox!.height).toBeLessThanOrEqual(viewport!.height);

  await testInfo.attach(`ausencias-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
});

test('an admin can create, edit, see and delete holidays from the calendar', async ({
  page,
}, testInfo) => {
  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/ausencias');
  await page.getByRole('button', { name: 'Políticas y saldos' }).click();

  const projectDay =
    {
      'desktop-chromium': 13,
      'tablet-chromium': 14,
      'mobile-chromium': 15,
    }[testInfo.project.name] ?? 16;
  const date = `${new Date().getFullYear()}-11-${projectDay}`;
  const originalName = `Festivo E2E ${testInfo.project.name}`;
  const updatedName = `${originalName} actualizado`;

  const createForm = page.getByRole('form', { name: 'Añadir festivo' });
  await createForm.getByLabel('Nombre').fill(originalName);
  await createForm.getByLabel('Fecha').fill(date);
  await createForm.getByRole('button', { name: 'Añadir festivo' }).click();
  await expect(page.getByRole('status')).toContainText('Festivo añadido al calendario.');

  let holiday = page.locator('article').filter({ hasText: originalName });
  await expect(holiday).toBeVisible();
  await holiday.getByRole('button', { name: `Editar festivo ${originalName}` }).click();

  const editForm = page.getByRole('form', { name: 'Editar festivo' });
  await editForm.getByLabel('Nombre').fill(updatedName);
  await editForm.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(page.getByRole('status')).toContainText('Festivo actualizado en el calendario.');
  holiday = page.locator('article').filter({ hasText: updatedName });
  await expect(holiday).toBeVisible();

  await page.getByRole('button', { name: 'Resumen anual' }).click();
  const annualCalendar = page.locator('section[aria-labelledby="annual-calendar-title"]');
  await expect(annualCalendar.locator(`[data-date="${date}"]`)).toContainText(updatedName);

  await page.getByRole('button', { name: 'Políticas y saldos' }).click();
  holiday = page.locator('article').filter({ hasText: updatedName });
  await holiday.getByRole('button', { name: `Eliminar festivo ${updatedName}` }).click();
  await holiday.getByRole('button', { name: 'Confirmar eliminación' }).click();
  await expect(page.getByRole('status')).toContainText('Festivo eliminado del calendario.');
  await expect(page.locator('article').filter({ hasText: updatedName })).toHaveCount(0);
});
