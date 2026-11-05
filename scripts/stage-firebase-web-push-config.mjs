import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const envFile = path.join(root, 'apps/mobile/.env');
const text = fs.readFileSync(envFile, 'utf8');
const values = Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
  const match = line.match(/^\s*(EXPO_PUBLIC_FIREBASE_[A-Z_]+)\s*=\s*(.*)\s*$/);
  return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
}));

const config = {
  apiKey: values.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: values.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: values.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: values.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: values.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: values.EXPO_PUBLIC_FIREBASE_APP_ID,
  vapidKey: values.EXPO_PUBLIC_FIREBASE_VAPID_KEY || null,
};
const requiredConfig = [config.apiKey, config.authDomain, config.projectId, config.storageBucket, config.messagingSenderId, config.appId];
if (config.projectId !== 'drivx-116de' || requiredConfig.some((value) => !value)) {
  throw new Error('Production Firebase web config is incomplete or targets the wrong project.');
}
const destinations = process.argv.slice(2);
if (!destinations.length) throw new Error('Pass one or more generated web output directories.');
const content = `self.DRIVX_FIREBASE_CONFIG = ${JSON.stringify(config)};\n`;
for (const destination of destinations) {
  const file = path.join(root, destination, 'firebase-config.js');
  fs.writeFileSync(file, content, { mode: 0o644 });
  const indexFile = path.join(root, destination, 'index.html');
  let html = fs.readFileSync(indexFile, 'utf8');
  if (!html.includes('firebase-config.js')) {
    html = html.replace('</head>', `    <script src="firebase-config.js"></script>\n  </head>`);
    fs.writeFileSync(indexFile, html);
  }
  console.log(`Staged Firebase public messaging config: ${destination}`);
}
