const { withAndroidManifest } = require('expo/config-plugins');

/** Prefer the app's notification defaults over Firebase Messaging library defaults. */
module.exports = function withFirebaseMessagingOverrides(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return modConfig;

    manifest.$ ??= {};
    manifest.$['xmlns:tools'] ??= 'http://schemas.android.com/tools';
    const overrides = {
      'com.google.firebase.messaging.default_notification_channel_id': 'android:value',
      'com.google.firebase.messaging.default_notification_color': 'android:resource',
    };

    for (const [name, attribute] of Object.entries(overrides)) {
      const entry = application['meta-data']?.find((item) => item.$?.['android:name'] === name);
      if (!entry) continue;
      const existing = entry.$['tools:replace']?.split(',').map((value) => value.trim()) ?? [];
      if (!existing.includes(attribute)) existing.push(attribute);
      entry.$['tools:replace'] = existing.join(',');
    }

    return modConfig;
  });
};
