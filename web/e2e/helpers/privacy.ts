import { expect, type Page } from '@playwright/test';

export async function acknowledgePrivacyNotice(page: Page): Promise<void> {
  const modal = page.getByTestId('privacy-notice-modal');
  const visible = await modal
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) return;
  const acknowledge = modal.getByRole('button', { name: 'He recibido la información' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actionable = await acknowledge
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!actionable) return;
    await acknowledge.click();
    const hidden = await modal
      .waitFor({ state: 'hidden', timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (hidden) return;
    if (attempt === 2) {
      await expect(modal).toBeHidden();
      return;
    }
    await page.waitForTimeout(3_200);
  }
}
