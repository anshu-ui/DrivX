(() => {
  const id = window.DRIVX_GA4_MARKETING_ID || '';
  if (!/^G-[A-Z0-9]+$/i.test(id)) return;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(script);

  window.gtag('js', new Date());
  window.gtag('config', id, { send_page_view: false });
  // Never send query strings, account details, bookings, addresses, or locations.
  window.gtag('event', 'page_view', {
    page_title: 'DrivX marketing website',
    page_path: '/',
    page_location: window.location.origin + '/',
  });
})();

