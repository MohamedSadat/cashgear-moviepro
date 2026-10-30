import { expect, test, type Page } from '@playwright/test';
import { startLicensing, type TestLicensing } from './licensing';

// Phase 11: Pro licence keys activate against the licence server, hold across
// reloads and through the offline grace period, and give way to the free edition
// when deactivated, revoked or not checked for 14 days. Every browser context is a
// machine of its own.

let licensing: TestLicensing;

test.beforeAll(async () => {
  licensing = await startLicensing();
});

test.afterAll(async () => {
  await licensing?.stop();
});

const DAY = 86_400_000;

async function open(page: Page, query = licensing.query) {
  await page.goto('/?diagnostic=1' + query);
  await expect(page.getByTestId('open-licence')).toBeVisible();
}

async function activate(page: Page, key: string) {
  await page.getByTestId('open-licence').click();
  await page.getByTestId('licence-key').fill(key);
  await page.getByTestId('licence-activate').click();
}

const edition = (page: Page) => page.getByTestId('open-licence');

test('a key activates Pro, which holds across reloads until deactivated', async ({
  page,
  browser,
}) => {
  const { key } = await licensing.issue({ machines: 1 });
  await open(page);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toContainText('Free edition');
  // Typed carelessly: lower case and spaces for dashes.
  await page.getByTestId('licence-key').fill(key.toLowerCase().replace(/-/g, ' '));
  await page.getByTestId('licence-activate').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('licence-status')).toContainText('Pro is active on this browser');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  await page.reload();
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  // The licence allows one machine: another browser is refused until this one lets go.
  const other = await browser.newContext();
  const second = await other.newPage();
  await open(second);
  await activate(second, key);
  await expect(second.getByTestId('licence-error')).toContainText('as many computers');
  await expect(edition(second)).toHaveAttribute('data-edition', 'free');

  await page.getByTestId('open-licence').click();
  await page.getByTestId('licence-deactivate').click();
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await second.getByTestId('licence-activate').click();
  await expect(edition(second)).toHaveAttribute('data-edition', 'pro');
  await other.close();
});

test('wrong keys are refused with the reason', async ({ page }) => {
  await open(page);
  await activate(page, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  await expect(page.getByTestId('licence-error')).toHaveText('That licence key is not valid.');
  await page.getByTestId('licence-key').fill('not a key');
  await page.getByTestId('licence-activate').click();
  await expect(page.getByTestId('licence-error')).toHaveText('The request is not valid.');
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
});

test('a revoked licence becomes the free edition at its next check', async ({ page }) => {
  const { id, key } = await licensing.issue();
  await open(page);
  await activate(page, key);
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  await licensing.revoke(id);
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByTestId('licence-error')).toHaveText('That licence has been withdrawn.');
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
});

test('offline, Pro holds for 14 days after the last check, and a clock set back does not help', async ({
  page,
}) => {
  const { key } = await licensing.issue();
  await open(page);
  await activate(page, key);
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  const offline = licensing.query.replace(
    encodeURIComponent(licensing.base),
    'http%3A%2F%2F127.0.0.1%3A9',
  );
  const now = Date.now();

  await page.clock.setFixedTime(now + 8 * DAY);
  await open(page, offline);
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'offline');
  await expect(page.getByTestId('licence-status')).toContainText('Connect to the internet by');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');

  await page.clock.setFixedTime(now + 15 * DAY);
  await open(page, offline);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'lapsed');

  await page.clock.setFixedTime(now);
  await open(page, offline);
  await expect(edition(page)).toHaveAttribute('data-edition', 'free');

  // Back online, a check brings Pro back.
  await open(page);
  await page.getByTestId('open-licence').click();
  await page.getByRole('button', { name: 'Check now' }).first().click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-edition', 'pro');
});

test('builds that are not releases are Pro without a licence server', async ({ page }) => {
  await open(page, '');
  await expect(edition(page)).toHaveAttribute('data-edition', 'pro');
  await page.getByTestId('open-licence').click();
  await expect(page.getByTestId('licence-status')).toHaveAttribute('data-state', 'development');
});
