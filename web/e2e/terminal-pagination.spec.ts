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
    if (attempt === 3) throw new Error('No se pudo iniciar sesión como admin@example.com');
    await page.waitForTimeout(3_200);
  }
}

function terminal(id: number, revoked = false) {
  const day = String(22 - id).padStart(2, '0');
  return {
    id: `terminal-${id}`,
    organization: 'organization-1',
    name: `${revoked ? 'Revocado' : 'Activo'} ${id}`,
    prefix: `prefix${id}`,
    protocolVersion: 1,
    clientVersion: 'e2e-pagination',
    cacheRevision: 0,
    lastSeenAt: '',
    lastPendingCount: 0,
    revokedAt: revoked ? '2026-08-22 12:00:00.000Z' : '',
    connectionStatus: revoked ? 'revoked' : 'offline',
    lastHeartbeatAt: '',
    lastAttendanceSyncAt: '',
    lastClockStatus: '',
    lastNtpSyncAt: '',
    lastWifiRssiDbm: null,
    lastUptimeSeconds: null,
    createdBy: 'admin-1',
    created: `2026-08-${day} 10:00:00.000Z`,
  };
}

test('pagina los terminales con activos y creación reciente primero', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 320, height: 720 });
  }
  await signIn(page);

  const requestedPages: number[] = [];
  await page.route('**/api/openjornada/terminals?page=*', async (route) => {
    const requestedPage = Number(new URL(route.request().url()).searchParams.get('page'));
    requestedPages.push(requestedPage);
    const items =
      requestedPage === 2
        ? [terminal(11, true), terminal(12, true)]
        : Array.from({ length: 10 }, (_, index) => terminal(index + 1));
    await route.fulfill({
      contentType: 'application/json',
      json: {
        items,
        adminPinConfigured: true,
        page: requestedPage,
        perPage: 10,
        totalItems: 12,
        totalPages: 2,
      },
    });
  });

  await page.goto('/integraciones');
  const terminalList = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Terminales RFID' }),
  });
  await expect(terminalList.getByText('Activo 1', { exact: true })).toBeVisible();
  await expect(terminalList.getByText('Activo 10', { exact: true })).toBeVisible();
  await expect(terminalList.locator('ul > li p.font-semibold')).toHaveText(
    Array.from({ length: 10 }, (_, index) => `Activo ${index + 1}`),
  );
  await expect(terminalList.getByText('Creado', { exact: false }).first()).toBeVisible();
  await expect(terminalList.getByText('Mostrando 1–10 de 12 terminales')).toBeVisible();
  await expect(terminalList.getByText('Página 1 de 2')).toBeVisible();

  await terminalList.getByRole('button', { name: 'Siguiente' }).click();

  await expect(terminalList.getByText('Revocado 11', { exact: true })).toBeVisible();
  await expect(terminalList.getByText('Revocado 12', { exact: true })).toBeVisible();
  await expect(terminalList.locator('ul > li p.font-semibold')).toHaveText([
    'Revocado 11',
    'Revocado 12',
  ]);
  await expect(terminalList.getByText('Mostrando 11–12 de 12 terminales')).toBeVisible();
  await expect(terminalList.getByText('Página 2 de 2')).toBeVisible();
  await expect(terminalList.getByRole('button', { name: 'Siguiente' })).toBeDisabled();

  await terminalList.getByRole('button', { name: 'Anterior' }).click();
  await expect(terminalList.getByText('Página 1 de 2')).toBeVisible();
  const sectionBox = await terminalList.boundingBox();
  const paginatorBox = await terminalList
    .getByRole('navigation', { name: 'Paginación de terminales RFID' })
    .boundingBox();
  expect(sectionBox).not.toBeNull();
  expect(paginatorBox).not.toBeNull();
  if (sectionBox && paginatorBox) {
    expect(paginatorBox.x).toBeGreaterThanOrEqual(sectionBox.x);
    expect(paginatorBox.x + paginatorBox.width).toBeLessThanOrEqual(
      sectionBox.x + sectionBox.width + 0.5,
    );
  }
  expect(requestedPages).toEqual([1, 2, 1]);
});
