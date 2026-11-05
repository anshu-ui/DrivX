import { Linking, Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, useTheme } from '@drivx/ui';
import { formatINR, type MoneyPaise, type Place } from '@drivx/domain';

/** One column of the floating stat card. */
function Stat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text
        variant="overline"
        tone="muted"
        style={{ fontSize: theme.fontSize.xs - 2, letterSpacing: 0.8 }}
        numberOfLines={1}
      >
        {label.toUpperCase()}
      </Text>
      <Text
        variant="subheading"
        tone={accent ? 'primary' : 'brand'}
        numberOfLines={1}
        style={{ fontSize: theme.fontSize.lg }}
      >
        {value}
      </Text>
    </View>
  );
}

function SquareButton({
  icon,
  onPress,
  accessibilityLabel,
  active = false,
}: {
  icon: 'layers' | 'locate' | 'close';
  onPress: () => void;
  accessibilityLabel: string;
  active?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: theme.radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? theme.colors.primarySoft : theme.colors.surface,
        borderColor: active ? theme.colors.textBrand : theme.colors.border,
        borderWidth: theme.borderWidth.thin,
      })}
    >
      <Ionicons
        name={icon}
        size={18}
        color={active ? theme.colors.textBrand : theme.colors.textFaint}
      />
    </Pressable>
  );
}

/**
 * The right-hand panel of the booking screen: who is available and what the
 * trip measures.
 *
 * It is drawn, not mapped. There is no map SDK, no road geometry and no driver
 * coordinate in this build, so the panel shows the two numbers the backend
 * really returned — a verified-driver count and the measured distance — over a
 * schematic that says so on its face. The dashed line is a straight line
 * between the customer's two places, which is exactly what the fare was priced
 * off; drawing a plausible road instead would be the one lie this panel could
 * not take back, because the customer would read a route into it.
 */
export function AvailabilityPanel({
  driversOnline,
  zoneId,
  distanceMeters,
  durationSeconds,
  totalPaise,
  pickup,
  destination,
  onRefresh,
  refreshing,
  compact = false,
}: {
  driversOnline: number;
  zoneId: string | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  totalPaise: MoneyPaise | null;
  pickup: Place | null;
  destination: Place | null;
  onRefresh: () => void;
  refreshing: boolean;
  /** Stacked under the composer on a narrow screen, where 460px is a whole page. */
  compact?: boolean;
}) {
  const theme = useTheme();

  const distanceLabel =
    distanceMeters === null ? '—' : `${(distanceMeters / 1000).toFixed(1)} km`;
  const timeLabel = durationSeconds === null ? '—' : `${Math.round(durationSeconds / 60)} mins`;
  const mapsUrl = pickup && destination
    ? `https://www.google.com/maps/dir/?api=1&origin=${pickup.location.lat},${pickup.location.lng}&destination=${destination.location.lat},${destination.location.lng}&travelmode=driving`
    : null;

  return (
    <View
      style={{
        // `flex: 1` would set a zero basis, and in the stacked layout the panel's
        // parent has no fixed height to distribute — the box would collapse to 0
        // while its content kept painting over the composer.
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 'auto',
        minHeight: compact ? 360 : 480,
        padding: theme.spacing.lg,
        gap: theme.spacing.md,
        backgroundColor: theme.colors.surfaceMuted,
        borderColor: theme.colors.border,
        borderWidth: theme.borderWidth.thin,
        borderRadius: theme.radius.xl,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm }}>
        <View
          style={{
            flex: 1,
            minWidth: 0,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            alignSelf: 'flex-start',
            paddingVertical: theme.spacing.sm,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
            borderWidth: theme.borderWidth.thin,
          }}
        >
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: driversOnline > 0 ? theme.palette.brandBright : theme.colors.disabledText,
            }}
          />
          <Text variant="label" tone="brand" numberOfLines={1}>
            {driversOnline > 0
              ? `${driversOnline} DrivX verified driver${driversOnline === 1 ? '' : 's'} active nearby`
              : `No verified driver online in ${zoneId ?? 'this zone'} right now`}
          </Text>
        </View>
        <SquareButton
          icon="locate"
          onPress={onRefresh}
          accessibilityLabel="Refresh driver availability"
        />
      </View>

      {/* Schematic: the two pins and the line the fare was measured along. */}
      <View
        style={{
          flexGrow: 1,
          flexShrink: 0,
          flexBasis: compact ? 150 : 220,
          borderRadius: theme.radius.lg,
          borderStyle: 'dashed',
          borderColor: theme.colors.border,
          borderWidth: 1,
          overflow: 'hidden',
          backgroundColor: theme.colors.surface,
        }}
      >
        <View
          style={{
            position: 'absolute',
            left: '-5%',
            right: '-5%',
            top: '54%',
            borderTopWidth: 3,
            borderStyle: 'dashed',
            borderColor: theme.colors.textBrand,
            transform: [{ rotate: '-13deg' }],
          }}
        />
        <View
          style={{
            position: 'absolute',
            left: '16%',
            top: '64%',
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: theme.palette.brandBright,
            borderWidth: 3,
            borderColor: theme.colors.surface,
          }}
        />
        <View
          style={{
            position: 'absolute',
            right: '18%',
            top: '34%',
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: theme.colors.textBrand,
            borderWidth: 3,
            borderColor: theme.colors.surface,
          }}
        />
        <View style={{ padding: theme.spacing.md, gap: 2 }}>
          <Text variant="overline" tone="muted" style={{ fontSize: theme.fontSize.xs - 2, letterSpacing: 0.8 }}>
            PICKUP
          </Text>
          <Text variant="overline" tone="muted" style={{ fontSize: theme.fontSize.xs - 2, letterSpacing: 0.8 }}>
            DROP-OFF
          </Text>
        </View>
      </View>

      {mapsUrl ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open pickup to drop route in Google Maps"
          onPress={() => void Linking.openURL(mapsUrl).catch(() => undefined)}
          style={({ pressed }) => ({
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
            borderRadius: theme.radius.md,
            backgroundColor: pressed ? theme.colors.primarySoft : theme.colors.surface,
            borderColor: theme.colors.border,
            borderWidth: theme.borderWidth.thin,
          })}
        >
          <Ionicons name="map-outline" size={17} color={theme.colors.textBrand} />
          <Text variant="label" tone="brand">Open pickup → drop in Google Maps</Text>
          <Ionicons name="open-outline" size={15} color={theme.colors.textBrand} />
        </Pressable>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          gap: theme.spacing.md,
          padding: theme.spacing.md,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: theme.borderWidth.thin,
        }}
      >
        <Stat label="Distance" value={distanceLabel} />
        <Stat label="Est. time" value={timeLabel} />
        <Stat label="Fare" value={totalPaise === null ? '—' : formatINR(totalPaise)} accent />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          padding: theme.spacing.md,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderWidth: theme.borderWidth.thin,
        }}
      >
        <Ionicons name="people" size={18} color={theme.colors.primaryInk} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="label" tone="brand">
            {driversOnline > 0
              ? `${driversOnline} available in ${zoneId ?? 'your zone'}`
              : `None online in ${zoneId ?? 'your zone'}`}
          </Text>
          <Text variant="caption" tone="faint">
            Driver names and positions stay private until one is assigned.
          </Text>
        </View>
        {refreshing ? <Ionicons name="refresh" size={16} color={theme.colors.textMuted} /> : null}
      </View>
    </View>
  );
}
