/**
 * Cashfree's hosted checkout (sandbox). The card, UPI and net-banking forms live on Cashfree's
 * side; SeatLock never sees payment details. Cashfree requires its script to be loaded from
 * its own CDN (PCI compliance), so it's added on demand rather than bundled.
 */
const SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

interface CashfreeCheckout {
  checkout(options: {
    paymentSessionId: string;
    redirectTarget: '_modal' | '_self' | '_blank';
  }): Promise<{ error?: { message?: string }; paymentDetails?: unknown; redirect?: boolean }>;
}

declare global {
  interface Window {
    Cashfree?: (options: { mode: 'sandbox' | 'production' }) => CashfreeCheckout;
  }
}

let loading: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (window.Cashfree) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      reject(new Error('Couldn’t load Cashfree’s checkout. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Sends the customer to Cashfree's hosted checkout page (in the same tab). Cashfree brings
 * them back to SeatLock's checkout page (the order's return URL, with ?order_id=...) whether
 * they paid or not; that page then asks SeatLock for the real outcome, which only Cashfree's
 * server-side confirmation decides.
 *
 * A full page rather than a popup: a card's bank OTP page opens a new window from inside a
 * popup, which browsers block (found in the first live test).
 */
export async function openCashfreeCheckout(paymentSessionId: string): Promise<void> {
  await loadSdk();
  const cashfree = window.Cashfree!({ mode: 'sandbox' });
  const result = await cashfree.checkout({ paymentSessionId, redirectTarget: '_self' });
  if (result.error && !result.paymentDetails) {
    // Cancelling or abandoning lands here too; the page shows "Finish your payment" instead
    const message = result.error.message ?? '';
    if (!/closed|cancel|abort/i.test(message))
      throw new Error(message || 'Cashfree checkout failed');
  }
}
