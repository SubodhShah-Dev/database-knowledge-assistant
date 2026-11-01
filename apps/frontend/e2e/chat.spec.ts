import { expect, test } from '@playwright/test';

const TEST_USER = {
  email: process.env.E2E_USER_EMAIL ?? 'demo@example.com',
  password: process.env.E2E_USER_PASSWORD ?? 'DemoPassword123!'
};

function demoConnectionName(suffix: string) {
  return `Demo Analytics ${suffix}`;
}

test.describe('database knowledge assistant flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', TEST_USER.email);
    await page.fill('input[type="password"]', TEST_USER.password);
    await page.click('button[type="submit"]');
    // Login redirects to the new-session page.
    await page.waitForURL('/');
  });

  async function goToConnections(page) {
    await page.locator('nav a:has-text("Connections")').click();
    await page.waitForURL('**/connections');
  }

  async function addDemoConnection(page, name: string) {
    await page.click('button:has-text("Add connection")');
    await expect(page.locator('role=dialog')).toBeVisible();

    await page.fill('label:has-text("Display name") input', name);
    await page.fill('label:has-text("Host") input', '127.0.0.1');
    await page.fill('label:has-text("Port") input', '5435');
    await page.fill('label:has-text("Database") input', 'demo_analytics');
    await page.fill('label:has-text("Username") input', 'demo_reader');
    await page.fill('label:has-text("Password") input', 'demo_reader_password');
    await page.selectOption('label:has-text("SSL mode") select', 'disable');
    await page.getByRole('dialog').getByRole('button', { name: 'Add connection' }).click();

    await expect(page.locator(`text=${name}`)).toBeVisible();
    return page.locator('.connection-card', { hasText: name });
  }

  test('adds a connection, tests it, and starts a chat', async ({ page }) => {
    const name = demoConnectionName(Date.now().toString());
    await goToConnections(page);

    const connectionCard = await addDemoConnection(page, name);

    await connectionCard.locator('button:has-text("Test")').click();
    await expect(connectionCard.locator('.alert-ok')).toBeVisible();
    await expect(connectionCard.locator('.alert-ok')).toContainText('Connected');

    await page.locator('nav a:has-text("New session")').click();
    await expect(page.locator('text=Tables and collections in scope')).toBeVisible();
    await page.click('button:has-text("Start session")');
    await page.waitForURL('**/c/**');

    await page.fill('textarea#question', 'How many orders are there?');
    await page.click('button[type="submit"]');
    await expect(page.getByText(/8 orders/)).toBeVisible();
  });

  test('edits a connection', async ({ page }) => {
    const name = demoConnectionName(Date.now().toString());
    await goToConnections(page);

    const connectionCard = await addDemoConnection(page, name);

    await connectionCard.locator('button:has-text("Edit")').click();
    await expect(page.locator('role=dialog')).toBeVisible();
    await page.fill('label:has-text("Display name") input', 'Updated Demo');
    await page.click('button:has-text("Save changes")');
    await expect(page.locator('text=Updated Demo')).toBeVisible();
  });
});
