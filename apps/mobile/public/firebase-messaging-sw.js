/* Firebase Web Push worker. `firebase-config.js` is generated during web staging. */
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');
importScripts('firebase-config.js');

const firebaseConfig = { ...self.DRIVX_FIREBASE_CONFIG };
delete firebaseConfig.vapidKey;
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'DrivX update';
  const options = {
    body: payload.notification?.body || 'There is an update to your trip.',
    icon: '/favicon.ico',
    data: payload.data || {},
    tag: payload.data?.notificationId || undefined,
  };
  return self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const surface = self.location.pathname.split('/').filter(Boolean)[0];
  const base = ['customer', 'driver', 'admin'].includes(surface) ? `/${surface}` : '/customer';
  const target = new URL(data.route || `${base}/trips`, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
