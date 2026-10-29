import { test, expect } from '@playwright/test';

test('signup, connect, ask with evidence, browse history, edit scope, and sign out', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  const email = `e2e-${Date.now()}@example.com`;

  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('E2EPassword123!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Add a database first' })).toBeVisible();

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();

  await page.goto('/connections');
  await page.getByRole('button', { name: 'Add connection' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Display name').fill('E2E Demo');
  await dialog.getByLabel('Host').fill('169.254.169.254');
  await dialog.getByLabel('Port').fill('5435');
  await dialog.getByLabel('Database').fill('demo_analytics');
  await dialog.getByLabel('Username').fill('demo_reader');
  await dialog.getByLabel('Password').fill('demo_reader_password');
  await dialog.getByLabel('SSL mode').selectOption('disable');
  await dialog.getByRole('button', { name: 'Add connection' }).click();
  await expect(dialog.getByText(/not allowed/i)).toBeVisible();
  await dialog.getByLabel('Host').fill('127.0.0.1');
  await dialog.getByRole('button', { name: 'Add connection' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'E2E Demo' })).toBeVisible();
  await page.getByRole('button', { name: 'Test' }).click();
  await expect(page.getByText(/Connected\. Session is read-only/)).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('4 of 4 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/c\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Ask about E2E Demo' })).toBeVisible();

  const question = page.getByLabel('Ask about your database');

  await question.fill('How many orders are in the demo database?');
  await question.press('Enter');
  await expect(page.getByText('There are 8 orders in the demo database.')).toBeVisible({
    timeout: 15_000
  });
  await expect(question).toBeEnabled();

  const dataTurn = page.locator('.chat-turn').last();
  await expect(dataTurn.locator('.sql-block')).toContainText(
    'SELECT COUNT(*)::int AS order_count FROM public.orders'
  );
  await expect(dataTurn.locator('.result-table')).toContainText('8');
  await expect(dataTurn.getByText(/1 row/)).toBeVisible();

  await question.fill('What columns does the orders table have?');
  await question.press('Enter');
  await expect(page.getByText('The orders table has 5 columns')).toBeVisible({
    timeout: 15_000
  });
  await expect(question).toBeEnabled();

  const schemaTurn = page.locator('.chat-turn').last();
  await expect(schemaTurn.locator('.schema-evidence')).toContainText('customer_id');
  await expect(schemaTurn.locator('.sql-block')).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('There are 8 orders in the demo database.')).toBeVisible();
  await expect(page.getByText('The orders table has 5 columns')).toBeVisible();
  await expect(page.locator('.chat-meta')).toContainText('4 tables in scope');

  await page.getByRole('button', { name: 'Tables' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('4 of 4 selected')).toBeVisible();
  await drawer.getByRole('checkbox', { name: 'Include public.products' }).uncheck();
  await drawer.getByRole('button', { name: 'Save table scope' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('.chat-meta')).toContainText('3 tables in scope');

  await page.reload();
  await expect(page.locator('.chat-meta')).toContainText('3 tables in scope');

  await page.route('**/api/questions', route =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'The language model is unavailable right now.' })
    })
  );
  await question.fill('Test the error state');
  await question.press('Enter');
  await expect(page.getByText('The language model is unavailable right now.')).toBeVisible();
  await page.unroute('**/api/questions');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('There are 8 orders in the demo database.').last()).toBeVisible({
    timeout: 15_000
  });
  await expect(question).toBeEnabled();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    )
    .toBe(0);

  const menuButton = page.getByRole('button', { name: 'Open menu' });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await expect(page.getByRole('button', { name: 'Close menu' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
  await page.getByRole('button', { name: 'Close menu' }).click();

  await page.getByRole('button', { name: 'Session history' }).click();
  await expect(page.getByRole('dialog', { name: 'Recent sessions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Recent sessions' })).toBeHidden();

  await page.getByRole('button', { name: 'Tables' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();

  const sessionTitle = 'How many orders are in the demo database?';
  await page.getByRole('button', { name: 'Session history' }).click();
  await expect(page.getByRole('dialog', { name: 'Recent sessions' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText(sessionTitle)).toBeVisible();
  await page.getByRole('link', { name: 'View all sessions' }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.locator('.session-row-main').first()).toContainText(sessionTitle);

  await page.locator('.session-row-main').first().click();
  await expect(page).toHaveURL(/\/c\/\d+$/);
  await page.goto('/sessions');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: `Delete ${sessionTitle}` }).click();
  await expect(page.getByRole('heading', { name: 'No sessions yet' })).toBeVisible();

  await page.locator('.account-menu button[aria-label="Sign out"]').click();
  await expect(page).toHaveURL(/\/login$/);
  expect(pageErrors).toEqual([]);
});
