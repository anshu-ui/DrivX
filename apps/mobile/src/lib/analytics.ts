import { Platform } from 'react-native';
import { appSurface, type AppSurface } from './appSurface';

type ProductSurface = Exclude<AppSurface, null>;
type Gtag = (...args: unknown[]) => void;
const DRIVX_GA4_WEB_ID = 'G-5G5MVS6WR9';
type AnalyticsWindow = Window & {
  dataLayer?: unknown[];
  gtag?: Gtag;
  __drivxAnalyticsConfigured?: Set<string>;
};

const knownScreens = new Set([
  'account',
  'app-access',
  'create-profile',
  'documents',
  'earnings',
  'index',
  'rewards',
  'saved-places',
  'sign-in',
  'support',
  'trip',
  'trips',
]);

function analyticsScreen(pathname: string): string {
  const segments = pathname.toLowerCase().split('/').filter(Boolean);
  return [...segments].reverse().find((segment) => knownScreens.has(segment)) ?? 'other';
}

function webMeasurementId(surface: ProductSurface): string {
  if (surface === 'customer') {
    return process.env.EXPO_PUBLIC_GA4_CUSTOMER_WEB_ID?.trim() || DRIVX_GA4_WEB_ID;
  }
  if (surface === 'driver') {
    return process.env.EXPO_PUBLIC_GA4_DRIVER_WEB_ID?.trim() || DRIVX_GA4_WEB_ID;
  }
  return DRIVX_GA4_WEB_ID;
}

function getGtag(win: AnalyticsWindow): Gtag {
  if (win.gtag) return win.gtag;
  const dataLayer = (win.dataLayer ??= []);
  const gtag: Gtag = (...args) => dataLayer.push(args);
  win.gtag = gtag;
  return gtag;
}

function trackWebScreen(surface: ProductSurface, screen: string): void {
  if (typeof window === 'undefined') return;
  const measurementId = webMeasurementId(surface);
  if (!/^G-[A-Z0-9]+$/i.test(measurementId)) return;

  const win = window as AnalyticsWindow;
  const gtag = getGtag(win);
  const configured = (win.__drivxAnalyticsConfigured ??= new Set<string>());

  if (!configured.has(measurementId)) {
    configured.add(measurementId);
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.appendChild(script);
    gtag('js', new Date());
    gtag('config', measurementId, { send_page_view: false });
  }

  // Use a fixed route label and omit query strings, IDs, and user-provided text.
  const safePath = `/${surface}/${screen}`;
  gtag('event', 'page_view', {
    page_title: `DrivX ${surface} · ${screen}`,
    page_path: safePath,
    page_location: `${window.location.origin}${safePath}`,
  });
}

export function trackAppScreen(pathname: string, sessionSurface: AppSurface): void {
  const screen = analyticsScreen(pathname);
  const surface = appSurface ?? sessionSurface;
  if (!surface) return;

  if (Platform.OS === 'web') {
    trackWebScreen(surface, screen);
    return;
  }

  // Keep the native-only module out of the web bundle. The event contains only
  // a fixed screen label; Firebase Analytics assigns the native app stream.
  void import('@react-native-firebase/analytics')
    .then(({ getAnalytics, logScreenView }) =>
      logScreenView(getAnalytics(), {
        screen_name: `${surface}_${screen}`,
        screen_class: surface,
      }),
    )
    .catch(() => {
      // Expo Go and unconfigured development builds may not include native Analytics.
    });
}
