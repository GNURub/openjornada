import { expect, test, type Page } from '@playwright/test';
import { otpFromMessage, startSmtpServer, type SmtpTestServer } from './helpers/smtp';

const operatorPassword = 'PlatformE2EPassword123!';

interface PlatformOrganizationApi {
  id: string;
  name: string;
  accessStatus: string;
  accessOverride: string;
}

interface PlatformApiResponse<T> {
  status: number;
  body: T;
}

async function platformApi<T>(
  page: Page,
  path: string,
  method = 'GET',
  body?: Record<string, string>,
): Promise<PlatformApiResponse<T>> {
  const response = await page.evaluate(
    async (request) => {
      const stored = localStorage.getItem('openjornada_platform_auth');
      const auth = stored ? (JSON.parse(stored) as { token?: string }) : null;
      if (!auth?.token) throw new Error('No existe una sesión de proveedor para la prueba.');
      const result = await fetch(request.path, {
        method: request.method,
        headers: {
          Authorization: auth.token,
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
      });
      return {
        status: result.status,
        body: await result.json(),
      };
    },
    { path, method, body },
  );
  return response as PlatformApiResponse<T>;
}

async function organizationByName(page: Page, name: string): Promise<PlatformOrganizationApi> {
  const response = await platformApi<PlatformOrganizationApi[]>(
    page,
    '/api/openjornada/platform/v1/organizations',
  );
  expect(response.status).toBe(200);
  const organization = response.body.find((item) => item.name === name);
  expect(organization).toBeDefined();
  return organization!;
}

function updateAccess(
  page: Page,
  organizationId: string,
  accessStatus: 'automatic' | 'suspended',
  reason: string,
): Promise<PlatformApiResponse<PlatformOrganizationApi>> {
  return platformApi(
    page,
    `/api/openjornada/platform/v1/organizations/${organizationId}/access`,
    'PATCH',
    { accessStatus, reason },
  );
}

async function loginPlatform(page: Page, smtp: SmtpTestServer, email: string): Promise<void> {
  await page.goto('/proveedor/login');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(operatorPassword);
  const otpMessage = smtp.message();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible();
  await page.getByLabel('Código de un solo uso').fill(otpFromMessage(await otpMessage));
  await page.getByRole('button', { name: 'Verificar código' }).click();
  await expect(page).toHaveURL(/\/proveedor$/);
  await expect(page.getByRole('heading', { name: 'Empresas y acceso' })).toBeVisible();
}

test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop-chromium', 'El flujo MFA se ejecuta una vez.');
});

test('administración entra con MFA y controla el ciclo de acceso', async ({ page }) => {
  const smtp = await startSmtpServer();
  let organizationId = '';
  try {
    await loginPlatform(page, smtp, 'platform-admin@example.com');
    await expect(page.getByText('Operaciones E2E · Administración')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva empresa' })).toBeVisible();

    const organization = await organizationByName(page, 'Centro Aura Test');
    organizationId = organization.id;
    const normalized = await updateAccess(
      page,
      organizationId,
      'automatic',
      'Preparación idempotente de la prueba E2E',
    );
    expect(normalized.status).toBe(200);
    await page.reload();

    const row = page.getByRole('row').filter({ hasText: 'Centro Aura Test' });
    const access = row.getByLabel('Cambiar estado de acceso');
    page.once('dialog', (dialog) => dialog.accept('Suspensión validada mediante prueba E2E'));
    await access.selectOption('suspended');
    await expect(page.getByRole('status')).toContainText('Acceso de Centro Aura Test actualizado');
    await expect(access).toHaveValue('suspended');

    page.once('dialog', (dialog) => dialog.accept('Retorno al ciclo automático validado por E2E'));
    await access.selectOption('automatic');
    await expect(access).toHaveValue('automatic');
    await expect(row.getByRole('cell').nth(1).getByText('Activo', { exact: true })).toBeVisible();
  } finally {
    if (organizationId) {
      const restored = await updateAccess(
        page,
        organizationId,
        'automatic',
        'Restauración final de la prueba E2E',
      ).catch(() => null);
      if (restored) expect.soft(restored.status).toBe(200);
    }
    await smtp.close();
  }
});

test('soporte entra con MFA y permanece estrictamente en lectura', async ({ page }) => {
  const smtp = await startSmtpServer();
  try {
    await loginPlatform(page, smtp, 'platform-support@example.com');
    await expect(page.getByText('Soporte E2E · Soporte en lectura')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nueva empresa' })).toHaveCount(0);
    await expect(page.getByLabel('Cambiar estado de acceso')).toHaveCount(0);
    const row = page.getByRole('row').filter({ hasText: 'Centro Aura Test' });
    await expect(
      row.getByRole('cell').last().getByText('Sólo lectura', { exact: true }),
    ).toBeVisible();

    const before = await organizationByName(page, 'Centro Aura Test');
    const denied = await updateAccess(
      page,
      before.id,
      'suspended',
      'Intento de escritura del rol soporte',
    );
    expect(denied.status).toBe(403);
    const after = await organizationByName(page, 'Centro Aura Test');
    expect({ status: after.accessStatus, override: after.accessOverride }).toEqual({
      status: before.accessStatus,
      override: before.accessOverride,
    });
  } finally {
    await smtp.close();
  }
});
