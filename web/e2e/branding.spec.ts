import { expect, test } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = 'http://127.0.0.1:8090/api';

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    try {
      await expect(page).toHaveURL(/\/$/, { timeout: 2_500 });
      await acknowledgePrivacyNotice(page);
      return;
    } catch {
      if (attempt === 2) throw new Error(`No se pudo iniciar sesión como ${email}`);
      await page.waitForTimeout(3_200);
    }
  }
}

async function apiSignIn(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<{
  token: string;
  record: { organization: string };
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
    if (response.ok()) {
      return (await response.json()) as {
        token: string;
        record: { organization: string };
      };
    }
    if (attempt === 2) {
      throw new Error(
        `No se pudo autenticar ${email}: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

test('admin configures and applies corporate branding and PWA metadata', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar la identidad corporativa.',
  );

  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/ajustes');
  await expect(page.getByRole('heading', { name: 'Identidad corporativa' })).toBeVisible();

  await page.getByLabel('Color principal hexadecimal').fill('#2457c5');
  await page.getByLabel('Color secundario hexadecimal').fill('#172554');
  await page.getByLabel('Nombre de la PWA').fill('Jornada Centro Aura');
  await page.getByLabel('Nombre corto de la PWA').fill('Aura Jornada');

  const fileInputs = page.locator('input[type="file"]');
  await expect(fileInputs).toHaveCount(1);
  await expect(page.getByText('Icono de la PWA y favicon')).toHaveCount(0);
  await fileInputs.setInputFiles('public/brand/openjornada-mark.png');
  await expect(page.getByAltText('Vista previa del icono PWA')).toHaveAttribute(
    'src',
    /^data:image\/png/,
  );

  await page.getByRole('button', { name: 'Guardar cambios' }).click();
  await expect(
    page.getByText('Configuración guardada. La identidad corporativa ya está aplicada.'),
  ).toBeVisible();

  await expect(page).toHaveTitle('Jornada Centro Aura · Gestión laboral');
  await expect(page.locator('aside').first().getByText('Jornada Centro Aura')).toBeVisible();
  await expect(page.locator('aside').first().locator('img').first()).toHaveAttribute(
    'src',
    /\/api\/files\/.+\/openjornada_mark/,
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#172554');
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--brand-primary').trim(),
    ),
  ).toBe('#2457c5');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    /\/api\/openjornada\/branding\/.+\/manifest\.json$/,
  );
  expect(
    await page.evaluate(async () => {
      const href = document
        .querySelector<HTMLLinkElement>('link[rel="manifest"]')
        ?.getAttribute('href');
      if (!href) return '';
      const manifest = (await fetch(href).then((response) => response.json())) as { name: string };
      return manifest.name;
    }),
  ).toBe('Jornada Centro Aura');
  await expect(page.locator('link[rel="icon"][sizes="32x32"]')).toHaveAttribute(
    'href',
    /pwa_icon.*thumb=32x32/,
  );
  expect(
    await page.evaluate(
      () =>
        new Promise<{ width: number; height: number }>((resolve, reject) => {
          const source = document
            .querySelector<HTMLLinkElement>('link[rel="icon"][sizes="32x32"]')
            ?.getAttribute('href');
          if (!source) {
            reject(new Error('Falta el favicon corporativo.'));
            return;
          }
          const image = new Image();
          image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
          image.onerror = () => reject(new Error('No se pudo cargar el favicon.'));
          image.src = source;
        }),
    ),
  ).toEqual({ width: 32, height: 32 });

  const admin = await apiSignIn(request, 'admin@example.com', 'TestPassword123!');
  const manifestResponse = await request.get(
    `http://127.0.0.1:8090/api/openjornada/branding/${admin.record.organization}/manifest.json`,
  );
  expect(manifestResponse.ok(), await manifestResponse.text()).toBeTruthy();
  expect(manifestResponse.headers()['cache-control']).toBe('no-store');
  const manifest = (await manifestResponse.json()) as {
    name: string;
    short_name: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  expect(manifest).toMatchObject({
    name: 'Jornada Centro Aura',
    short_name: 'Aura Jornada',
    theme_color: '#172554',
  });
  expect(manifest.icons).toEqual([
    expect.objectContaining({
      sizes: '192x192',
      purpose: 'any maskable',
    }),
    expect.objectContaining({
      sizes: '512x512',
      purpose: 'any maskable',
    }),
  ]);
  for (const icon of manifest.icons) {
    const publicIcon = await request.get(new URL(icon.src, 'http://127.0.0.1:8090').toString());
    expect(publicIcon.ok()).toBeTruthy();
  }

  const employee = await apiSignIn(request, 'empleada@example.com', 'DemoPassword123!');
  const forbiddenUpdate = await request.patch(
    `${apiBase}/collections/organizations/records/${employee.record.organization}`,
    {
      headers: { Authorization: employee.token },
      data: { brandPrimaryColor: '#000000' },
    },
  );
  expect([403, 404]).toContain(forbiddenUpdate.status());
});
