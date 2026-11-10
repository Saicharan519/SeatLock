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
 * Opens Cashfree's checkout as a popup over the page. Resolves when the popup closes, whether
 * the customer paid, failed or gave up: the page then asks SeatLock for the real outcome,
 * which only Cashfree's server-side confirmation decides.
 */
export async function openCashfreeCheckout(paymentSessionId: string): Promise<void> {
  await loadSdk();
  const cashfree = window.Cashfree!({ mode: 'sandbox' });
  const result = await cashfree.checkout({ paymentSessionId, redirectTarget: '_modal' });
  if (result.error && !result.paymentDetails) {
    // Closing the popup also lands here; it isn't an error worth alarming anyone about
    const message = result.error.message ?? '';
    if (!/closed|cancel/i.test(message)) throw new Error(message || 'Cashfree checkout failed');
  }
}
