import { useEffect, useState } from 'react';
import { Image, Linking, View } from 'react-native';
import { avatarDownloadUrl } from '@drivx/firebase-client';
import type { AssignedDriverCard } from '@drivx/domain';
import { Button, Card, Tag, Text, useTheme } from '@drivx/ui';
import { firebase } from '../../lib/firebase';
import { languageLabel } from './labels';

/**
 * Who is coming to drive, in the customer's own words.
 *
 * The owner's rule of 2026-10-27: "jo driver assign hoga uski sab details
 * aaegi… name kya hai uska, number, sab kuch customer ke paas." Everything here
 * is the card the server published onto the booking at assignment — the phone
 * never reads `driverProfiles` to fill it in, because that document also holds
 * another person's Aadhaar pointer and their dues.
 *
 * Deliberately absent: what the driver is owed, where they live, and their
 * document numbers. Those are true of the driver and none of them are the
 * customer's business, before or after the trip.
 */

function initials(name: string): string {
  const first = name.trim().split(/\s+/).filter(Boolean);
  const letters = [first[0]?.[0], first[1]?.[0]].filter(Boolean).join('');
  return letters.toUpperCase() || 'DX';
}

export function DriverCardPanel({ driver }: { driver: AssignedDriverCard }) {
  const theme = useTheme();
  const [photo, setPhoto] = useState<{ uid: string; url: string } | null>(null);

  useEffect(() => {
    if (!driver.photoPath) return undefined;
    // The profile stores a storage *path*, so this customer's own session mints
    // the link to view it. Nothing that outlives this screen is left in the
    // database, and a face is not a bearer token.
    let active = true;
    avatarDownloadUrl(firebase(), { uid: driver.uid })
      .then((url) => {
        if (active) setPhoto({ uid: driver.uid, url });
      })
      // No photo, or a read that failed: the initials carry the same identity,
      // and a missing thumbnail is not worth an error message on a trip screen.
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [driver.uid, driver.photoPath]);

  // Keyed by uid so a card that changes driver cannot show the previous one's face.
  const photoUri = photo?.uid === driver.uid ? photo.url : null;

  const car = [driver.vehicle.make, driver.vehicle.model].filter(Boolean).join(' ');
  const rating =
    driver.ratingCount > 0
      ? `${driver.ratingAverage.toFixed(2)} ★ from ${driver.ratingCount} rating${driver.ratingCount === 1 ? '' : 's'}`
      : 'New on DrivX — no ratings yet';

  return (
    <Card style={{ gap: theme.spacing.sm }}>
      <Text variant="overline" tone="brand">
        Your driver
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
        {photoUri ? (
          <Image
            source={{ uri: photoUri }}
            accessibilityLabel={`${driver.fullName}'s photo`}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              backgroundColor: theme.colors.surfaceMuted,
            }}
          />
        ) : (
          <View
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.primarySoft,
            }}
          >
            <Text variant="subheading" tone="brand">
              {initials(driver.fullName)}
            </Text>
          </View>
        )}

        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="subheading">{driver.fullName}</Text>
            {driver.driverId ? <Tag label={driver.driverId} tone="outline" /> : null}
          </View>
          <Text variant="caption" tone="muted">
            {rating} · {driver.lifetimeTrips} trip{driver.lifetimeTrips === 1 ? '' : 's'} driven
          </Text>
        </View>
      </View>

      {car || driver.vehicle.plate ? (
        <Text variant="body" tone="default">
          {[car, driver.vehicle.plate].filter(Boolean).join(' · ')}
        </Text>
      ) : (
        <Text variant="caption" tone="faint">
          The office has not recorded this driver&apos;s car yet.
        </Text>
      )}

      {driver.onTimeArrivalRate !== null && driver.onTimeArrivalCount > 0 ? (
        <Text variant="caption" tone="muted">
          On-time pickup · {Math.round(driver.onTimeArrivalRate * 100)}% ({driver.onTimeArrivalCount} on time, {driver.lateArrivalCount} late)
        </Text>
      ) : (
        <Text variant="caption" tone="muted">On-time pickup record will appear after a measured trip.</Text>
      )}

      {driver.languages.length > 0 ? (
        <Text variant="caption" tone="muted">
          Speaks {driver.languages.map(languageLabel).join(', ')}
        </Text>
      ) : null}

      {driver.phoneE164 ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
          }}
        >
          <Text variant="bodyStrong">{driver.phoneE164}</Text>
          <Button
            label="Call"
            appearance="secondary"
            size="sm"
            accessibilityLabel={`Call ${driver.fullName}`}
            onPress={() => void Linking.openURL(`tel:${driver.phoneE164}`)}
          />
        </View>
      ) : (
        <Text variant="caption" tone="warning">
          No phone number is on file for this driver. Ask the office to connect you.
        </Text>
      )}

      <Text variant="caption" tone="faint">
        DrivX shares these details with you for this trip only.
      </Text>
    </Card>
  );
}
