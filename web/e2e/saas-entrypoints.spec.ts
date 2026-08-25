import { expect, test } from '@playwright/test';
import { startSmtpServer } from './helpers/smtp';

test('el área de proveedor está separada y protegida', async ({ page }) => {
  await page.goto('/proveedor');
  await expect(page).toHaveURL(/\/proveedor\/login$/);
  await expect(page.getByRole('heading', { name: 'Gestiona el servicio' })).toBeVisible();
  await expect(page.getByText('verificación en dos pasos')).toBeVisible();
});

test('el alta pública crea una prueba sin pedir tarjeta', async ({ page }) => {
  test.skip(
    test.info().project.name !== 'desktop-chromium',
    'El flujo completo se ejecuta una vez.',
  );
  let smtp: Awaited<ReturnType<typeof startSmtpServer>> | null = null;
  const suffix = `${Date.now()}-${test.info().project.name.replace(/\W/g, '')}`;
  const taxId = `T${Date.now().toString(36).toUpperCase()}`;
  try {
    await page.goto('/registro');
    await expect(page.getByText('14 días sin tarjeta')).toBeVisible();
    await page.getByLabel('Empresa').fill(`Empresa SaaS ${suffix}`);
    await page.getByLabel('NIF/CIF').fill(taxId);
    await page.getByLabel('Personas en plantilla').fill('4');
    await page.getByLabel('Tu nombre').fill('Responsable SaaS');
    await page.getByLabel('Correo de administración').fill(`saas-${suffix}@example.com`);
    await page.getByRole('button', { name: 'Empezar prueba' }).click();
    await expect(page.getByRole('alert')).toContainText('La empresa se ha reservado');

    smtp = await startSmtpServer();
    const message = smtp.message();
    await page.getByRole('button', { name: 'Empezar prueba' }).click();
    await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible();
    await expect(page.getByText('La prueba de 14 días empieza')).toBeVisible();
    await expect(message).resolves.toContain('/invitacion/');
  } finally {
    await smtp?.close();
  }
});
