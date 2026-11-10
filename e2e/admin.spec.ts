import { expect, test } from '@playwright/test';
import { E2E } from '../playwright.config';
import { adminApi, newCustomer, signIn } from './helpers';

/** The admin dashboard: scheduling a show, a clash refused, and customers kept out. */
test('an admin schedules a show; a clashing one is refused with a clear message', async ({
  page,
}) => {
  // A theatre with one empty screen, so the schedule starts blank
  const admin = await adminApi();
  const theatre = await (
    await admin.post('/api/admin/theatres', {
      data: { name: `E2E Hall ${Date.now()}`, city: 'Testville', address: '' },
    })
  ).json();
  const screen = await admin.post(`/api/admin/theatres/${theatre.theatre.id}/screens`, {
    data: {
      name: 'Screen 1',
      layout: { rows: [{ label: 'A', category: 'CLASSIC', seats: 10, aisleAfter: [5] }] },
    },
  });
  expect(screen.status()).toBe(201);
  await admin.dispose();

  await signIn(page, { email: E2E.adminEmail, password: E2E.adminPassword });
  await page.goto(`/admin/showtimes?theatre=${theatre.theatre.id}`);
  // Tomorrow, so the default 18:30 is always in the future
  await page.getByRole('tab', { name: /^Tomorrow/ }).click();
  await expect(page.getByText('Nothing scheduled this day.')).toBeVisible();

  const movie = page.getByLabel('Movie');
  await expect(movie).toContainText('min)'); // the movie list has loaded
  await movie.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Add showtime' }).click();
  await expect(page.getByText(/^Scheduled .+ on Screen 1 at 6:30 pm\.$/)).toBeVisible();
  await expect(page.getByText(/6:30 pm–/)).toBeVisible();
  await expect(page.getByText('0/10 sold')).toBeVisible();

  // The same slot again: the database's exclusion constraint refuses it
  await movie.selectOption({ index: 2 });
  await page.getByRole('button', { name: 'Add showtime' }).click();
  await expect(page.getByText(/Clash on Screen 1\./)).toBeVisible();
});

test('a customer who opens /admin is told it is for admins only', async ({ page }) => {
  const user = await newCustomer();
  await signIn(page, user, '/admin');
  await expect(page.getByText('Admins only')).toBeVisible();
});
