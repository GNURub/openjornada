import { expect, test } from '@playwright/test';

test('exposes installable PWA metadata and icons', async ({
  page,
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar los recursos PWA.',
  );

  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    'manifest.json',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    'content',
    '#1c1917',
  );
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    'apple-touch-icon.png',
  );

  const manifestResponse = await request.get('/manifest.json');
  expect(manifestResponse.ok()).toBeTruthy();
  const manifest = (await manifestResponse.json()) as {
    name: string;
    display: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  expect(manifest.name).toContain('OpenJornada');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: 'icons/icon-512x512.png',
        sizes: '512x512',
        purpose: 'any',
      }),
      expect.objectContaining({
        src: 'icons/icon-maskable-512x512.png',
        sizes: '512x512',
        purpose: 'maskable',
      }),
    ]),
  );

  for (const path of [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/icons/icon-192x192.png',
    '/icons/icon-512x512.png',
    '/icons/icon-maskable-512x512.png',
  ]) {
    const assetResponse = await request.get(path);
    expect(assetResponse.ok(), path).toBeTruthy();
  }
});
