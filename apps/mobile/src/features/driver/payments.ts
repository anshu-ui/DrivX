import { Platform } from 'react-native';
import { CFEnvironment, CFSession } from 'cashfree-pg-api-contract';
import { CFPaymentGatewayService, type CFCallback } from 'react-native-cashfree-pg-sdk';
import { formatINR } from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

/** Cashfree's browser checkout SDK; loaded only when the app runs in a browser. */
const CHECKOUT_SDK_URL = 'https://sdk.cashfree.com/js/v3/cashfree.js';

type CashfreeCheckout = {
  checkout: (options: { paymentSessionId: string; redirectTarget: string }) => void;
};

type PayResult = { ok: true; amountPaise: number } | { ok: false; message: string };

function loadCheckoutSdk(): Promise<CashfreeCheckout> {
  const scope = globalThis as unknown as { Cashfree?: CashfreeCheckout };
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

/**
 * Asks the server for a Cashfree order against one of this driver's own dues and
 * opens the gateway's payment page for it.
 *
 * The app never names an amount: `createPaymentOrder` reads the due row and bills
 * exactly what the ledger says, which is why the number on this button and the
 * number charged cannot drift apart. The due only becomes `paid` when Cashfree's
 * own webhook confirms the order — nothing here reports success on the strength
 * of the page opening.
 *
 * The order's environment is returned by the server so a sandbox order can
 * never be opened in production checkout (or the other way around).
 */
export async function payDriverDue(dueId: string): Promise<PayResult> {
  let order;
  try {
    order = await callFunction<
      { dueId: string },
      {
        orderId: string;
        paymentSessionId: string | null;
        amountPaise: number;
        environment: 'production' | 'sandbox';
      }
    >(
      firebase(),
      'createPaymentOrder',
      { dueId },
    );
  } catch (error) {
    const message =
      error instanceof FunctionCallError ? error.message : 'The payment page could not be reached.';
    return { ok: false, message };
  }

  if (!order.paymentSessionId) {
    return {
      ok: false,
      message: `Cashfree returned the ${formatINR(order.amountPaise)} order without a payment session, so nothing can be charged.`,
    };
  }

  try {
    if (Platform.OS === 'web') {
      const cashfree = await loadCheckoutSdk();
      cashfree.checkout({ paymentSessionId: order.paymentSessionId, redirectTarget: '_self' });
      return { ok: true, amountPaise: order.amountPaise };
    }

    const environment = order.environment === 'sandbox' ? CFEnvironment.SANDBOX : CFEnvironment.PRODUCTION;
    const session = new CFSession(order.paymentSessionId, order.orderId, environment);
    return await new Promise<PayResult>((resolve) => {
      let complete = false;
      const finish = (result: PayResult) => {
        if (complete) return;
        complete = true;
        CFPaymentGatewayService.removeCallback();
        resolve(result);
      };
      const callback: CFCallback = {
        onVerify: (orderId) => {
          if (orderId !== order.orderId) {
            finish({ ok: false, message: 'Cashfree returned a different order. Your due was not cleared.' });
            return;
          }
          finish({ ok: true, amountPaise: order.amountPaise });
        },
        onError: (error, orderId) => {
          finish({
            ok: false,
            message: orderId !== order.orderId
              ? 'Cashfree returned a different order. Your due was not cleared.'
              : error.getMessage() || 'Cashfree could not complete the payment.',
          });
        },
      };
      CFPaymentGatewayService.setCallback(callback);
      try {
        CFPaymentGatewayService.doWebPayment(session);
      } catch (error) {
        finish({ ok: false, message: error instanceof Error ? error.message : 'Cashfree checkout did not open.' });
      }
    });
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
