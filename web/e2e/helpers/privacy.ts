import { expect, type Page } from '@playwright/test';

export async function acknowledgePrivacyNotice(page: Page): Promise<void> {
  const modal = page.getByTestId('privacy-notice-modal');
  const visible = await modal
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) return;
  await modal
    .getByRole('button', { name: 'He recibido la información' })
    .click();
  await expect(modal).toBeHidden();
}
