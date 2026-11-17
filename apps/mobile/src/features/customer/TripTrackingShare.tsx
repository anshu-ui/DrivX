import { useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { Button, Card, Text, useTheme } from '@drivx/ui';
import { callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

type ShareResult = { url: string; expiresAtMs: number };

/** Mint a short-lived, token-protected public map link for an active trip. */
export function TripTrackingShare({ bookingId }: { bookingId: string }) {
  const theme = useTheme();
  const [share, setShare] = useState<ShareResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const createAndShare = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    let result: ShareResult;
    try {
      result = share ?? await callFunction<{ bookingId: string }, ShareResult>(
        firebase(),
        'createTripTrackingShare',
        { bookingId },
      );
      setShare(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create a live tracking link.');
      setBusy(false);
      return;
    }

    try {
      const message = `Track my DrivX trip live: ${result.url}`;
      if (Platform.OS === 'web') {
        const webNavigator = typeof navigator === 'undefined' ? null : navigator as Navigator & {
          share?: (data: ShareData) => Promise<void>;
        };
        if (webNavigator?.share) {
          await webNavigator.share({ title: 'Track my DrivX trip', text: message, url: result.url });
        } else if (webNavigator?.clipboard?.writeText) {
          await webNavigator.clipboard.writeText(result.url);
          setNotice('Live link copied. Send it to anyone you want to keep updated.');
        } else {
          setNotice('Link ready. Select and copy it above to share.');
        }
      } else {
        await Share.share({ message });
      }
    } catch (reason) {
      // The OS share sheet can be dismissed. The already-created link remains
      // visible and selectable, so this is not a link-creation failure.
      if (!(reason instanceof Error && reason.name === 'AbortError')) {
        setNotice('Link ready. Select and copy it above to share.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: theme.spacing.sm }}>
      <Text variant="subheading" tone="brand">Share live trip</Text>
      <Text variant="caption" tone="muted">
        Share a private map link with family. It shows the vehicle’s latest location and stops working when the trip ends or the link expires.
      </Text>
      {share ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="caption" selectable accessibilityRole="link">{share.url}</Text>
          <Text variant="caption" tone="faint">Link expires {new Date(share.expiresAtMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} if the trip is still active.</Text>
        </View>
      ) : null}
      {notice ? <Text variant="caption" tone="muted">{notice}</Text> : null}
      <Button
        label={share ? 'Share live link' : 'Create and share live link'}
        appearance="secondary"
        onPress={() => void createAndShare()}
        loading={busy}
      />
      {error ? <Text variant="caption" tone="danger" accessibilityRole="alert">{error}</Text> : null}
    </Card>
  );
}
