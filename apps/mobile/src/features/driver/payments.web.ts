import { formatINR } from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

/** Cashfree's browser checkout SDK; this file replaces the native module on web. */
const CHECKOUT_SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

type CashfreeCheckout = {
  checkout: (options: { paymentSessionId: string; redirectTarget: string }) => Promise<unknown> | unknown;
};

type CashfreeFactory = (options: { mode: 'production' | 'sandbox' }) => CashfreeCheckout;

export type PayResult = { ok: true; amountPaise: number } | { ok: false; message: string };

function loadCheckoutSdk(): Promise<CashfreeFactory> {
  const scope = globalThis as unknown as { Cashfree?: CashfreeFactory };
  if (scope.Cashfree) return Promise.resolve(scope.Cashfree);
  return new Promise((resolve, reject) => {
    const document = (globalThis as unknown as { document?: Document }).document;
    if (!document) {
      reject(new Error('No browser document to load the payment page from.'));
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SDK_URL}"]`);
    const script: HTMLScriptElement = existing ?? document.createElement('script');
    script.addEventListener('load', () => {
      if (scope.Cashfree) resolve(scope.Cashfree);
      else reject(new Error('The payment SDK loaded without exposing a checkout.'));
    });
    script.addEventListener('error', () => reject(new Error('The payment page could not be loaded.')));
    if (!existing) {
      script.src = CHECKOUT_SDK_URL;
      document.head.appendChild(script);
    }
  });
}

/** Creates the server-priced order, then opens the browser checkout. */
export async function payDriverDue(dueId: string): Promise<PayResult> {
  let order;
  try {
    order = await callFunction<
      { dueId: string },
      { orderId: string; paymentSessionId: string | null; amountPaise: number; environment: 'production' | 'sandbox' }
    >(firebase(), 'createPaymentOrder', { dueId });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof FunctionCallError ? error.message : 'The payment page could not be reached.',
    };
  }
  if (!order.paymentSessionId) {
    return { ok: false, message: `Cashfree returned the ${formatINR(order.amountPaise)} order without a payment session.` };
  }
  try {
    const Cashfree = await loadCheckoutSdk();
    const cashfree = Cashfree({ mode: order.environment === 'sandbox' ? 'sandbox' : 'production' });
    await cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' });
    return { ok: true, amountPaise: order.amountPaise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Cashfree checkout did not open.' };
  }
}
