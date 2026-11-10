import { randomUUID } from 'node:crypto';
import { expect, request as playwrightRequest, type Page } from '@playwright/test';
import { E2E } from '../playwright.config';

/** A fresh customer account, made through the API (fast); the tests then sign in through the UI. */
export async function newCustomer(name = 'E2E Customer') {
  const api = await playwrightRequest.newContext({ baseURL: E2E.api });
  const email = `e2e-${randomUUID().slice(0, 8)}@example.test`;
  const password = `pw-${randomUUID()}`;
  const res = await api.post('/api/auth/register', { data: { name, email, password } });
  expect(res.status()).toBe(201);
  await api.dispose();
  return { name, email, password };
}

/** An API client signed in as the e2e admin (Bearer token), for setting up test data. */
export async function adminApi() {
  const anon = await playwrightRequest.newContext({ baseURL: E2E.api });
  const login = await anon.post('/api/auth/login', {
    data: { email: E2E.adminEmail, password: E2E.adminPassword },
  });
  expect(login.status()).toBe(200);
  const { token } = await login.json();
  await anon.dispose();
  return playwrightRequest.newContext({
    baseURL: E2E.api,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

export async function signIn(page: Page, user: { email: string; password: string }, next = '/') {
  await page.goto(`/signin?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/signin/);
}

/**
 * Upcoming shows from the seeded catalogue, at least `hoursAhead` away (so a booking on them
 * can still be cancelled), every seat free. Each test takes a different one, so tests never
 * compete for the same seats.
 */
export async function freeShows(hoursAhead = 3) {
  const api = await playwrightRequest.newContext({ baseURL: E2E.api });
  const res = await api.get('/api/shows?limit=200');
  const { shows } = (await res.json()) as {
    shows: { id: string; startsAt: string; totalSeats: number; availableSeats: number }[];
  };
  await api.dispose();
  const later = Date.now() + hoursAhead * 3_600_000;
  const free = shows.filter(
    (s) => new Date(s.startsAt).getTime() > later && s.availableSeats === s.totalSeats,
  );
  expect(free.length).toBeGreaterThan(5);
  return free.map((s) => s.id);
}

/** On a seat page: pick seats by label (A1, A2...) and hold them. */
export async function holdSeats(page: Page, labels: string[]) {
  for (const label of labels) {
    await page.getByRole('button', { name: new RegExp(`^Seat ${label},.*available`) }).click();
  }
  await page.getByRole('button', { name: /^Hold \d seats?$/ }).click();
}
