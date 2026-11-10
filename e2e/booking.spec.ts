import { expect, test } from '@playwright/test';
import { freeShows, holdSeats, newCustomer, signIn } from './helpers';

/**
 * The customer's journey through the real UI: hold, pay, ticket, cancel and refund, plus
 * the concurrency guarantee seen from two browsers at once.
 */
let shows: string[];
test.beforeAll(async () => {
  shows = await freeShows();
});

test('book seats: hold, pay with the simulated gateway, get a ticket', async ({ page }) => {
  const user = await newCustomer();
  await signIn(page, user);

  await page.goto(`/shows/${shows[0]}`);
  await holdSeats(page, ['A1', 'A2']);

  // Checkout: the hold's countdown is running and the total is shown
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByText('left to pay')).toBeVisible();
  await page.getByRole('button', { name: /^Pay ₹/ }).click();

  // The gateway's signed webhook confirms the booking; the page flips to the ticket
  await expect(page.getByText(/You.re in/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel('Ticket QR code')).toBeVisible();

  // It's in My bookings, confirmed
  await page.goto('/bookings');
  await expect(page.getByText('Confirmed').first()).toBeVisible();
  await expect(page.getByText('A1, A2').first()).toBeVisible();
});

test('two people, one seat: exactly one gets it, the other is told clearly', async ({
  browser,
}) => {
  const [alice, bob] = [await newCustomer('Alice'), await newCustomer('Bob')];
  const contexts = [await browser.newContext(), await browser.newContext()];
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await signIn(pages[0]!, alice);
  await signIn(pages[1]!, bob);

  // Both pick the same seat on the same show, then press Hold at the same moment
  for (const page of pages) {
    await page.goto(`/shows/${shows[1]}`);
    await page.getByRole('button', { name: /^Seat C5,.*available/ }).click();
  }
  await Promise.all(
    pages.map((page) => page.getByRole('button', { name: /^Hold 1 seat$/ }).click()),
  );

  // One reaches checkout; the other stays, with the explanation and an updated map
  const outcome = async (page: (typeof pages)[number]) => {
    await expect
      .poll(
        async () =>
          page.url().includes('/checkout/')
            ? 'won'
            : (await page.getByText(/Someone else got one of those seats first/).isVisible())
              ? 'lost'
              : 'pending',
        { timeout: 15_000 },
      )
      .not.toBe('pending');
    return page.url().includes('/checkout/') ? 'won' : 'lost';
  };
  const results = await Promise.all(pages.map(outcome));
  // (a sorted copy: sort() in place would scramble which page is which)
  expect([...results].sort()).toEqual(['lost', 'won']);

  const loser = pages[results.indexOf('lost')]!;
  await expect(
    loser.getByRole('button', { name: /^Seat C5,.*held by someone else/ }),
  ).toBeVisible();
  await Promise.all(contexts.map((c) => c.close()));
});

test('cancel a confirmed booking: the refund goes through', async ({ page }) => {
  const user = await newCustomer();
  await signIn(page, user);
  await page.goto(`/shows/${shows[2]}`);
  await holdSeats(page, ['B3']);
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await expect(page.getByText(/You.re in/)).toBeVisible({ timeout: 20_000 });

  await page.goto('/bookings');
  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await page.getByRole('button', { name: 'Yes, cancel' }).click();

  // Cancelled at once (it moves to "Past & cancelled"); the worker then asks the gateway for
  // the refund through the outbox, and the booking shows Refunded
  const past = page.getByRole('tab', { name: /Past & cancelled/ });
  await past.click();
  await expect(page.getByText(/Refund on its way|Refunded/).first()).toBeVisible();
  await expect
    .poll(
      async () => {
        await page.reload();
        await past.click();
        return page.getByText('Refunded').first().isVisible();
      },
      { timeout: 20_000, intervals: [1000] },
    )
    .toBe(true);
});

test('signing out ends the session; a private page then asks you to sign in', async ({ page }) => {
  const user = await newCustomer();
  await signIn(page, user, '/bookings');
  await expect(page.getByRole('heading', { name: /My bookings/i })).toBeVisible();

  // The session is a cookie page scripts can't read, and nothing is kept in localStorage
  expect(await page.evaluate('document.cookie')).toBe('');
  expect(await page.evaluate("localStorage.getItem('seatlock.token')")).toBeNull();

  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/bookings');
  await expect(page).toHaveURL(/\/signin\?next=%2Fbookings/);
});
