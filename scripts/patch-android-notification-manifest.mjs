import { readFile, writeFile } from 'node:fs/promises';

const path = process.cwd().endsWith('/apps/mobile')
  ? 'android/app/src/main/AndroidManifest.xml'
  : 'apps/mobile/android/app/src/main/AndroidManifest.xml';
let manifest = await readFile(path, 'utf8');
const overrides = [
  [
    'com.google.firebase.messaging.default_notification_channel_id',
    'android:value',
  ],
  [
    'com.google.firebase.messaging.default_notification_color',
    'android:resource',
  ],
];

for (const [name, attribute] of overrides) {
  const escapedName = name.replaceAll('.', '\\.');
  const pattern = new RegExp(`(<meta-data\\s+android:name="${escapedName}"[^>]*?)(/?>)`);
  if (!pattern.test(manifest)) throw new Error(`Missing Android manifest metadata: ${name}`);
  manifest = manifest.replace(pattern, (entry, prefix, close) =>
    prefix.includes('tools:replace=')
      ? entry
      : `${prefix} tools:replace="${attribute}"${close}`,
  );
}

if (!manifest.includes('xmlns:tools=')) {
  manifest = manifest.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
}

await writeFile(path, manifest);
