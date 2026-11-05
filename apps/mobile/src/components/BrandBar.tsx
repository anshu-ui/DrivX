import { View } from 'react-native';
import { Tag, Text, useTheme } from '@drivx/ui';
import { BrandMark } from './BrandMark';

/**
 * The brand lockup and the account chip.
 *
 * There is no role rail here on purpose: the customer app and the driver app are
 * separate installs, and a role is a claim on the ID token rather than something
 * to switch from a header.
 */
export function BrandBar({ tagline, right }: { tagline: string; right?: React.ReactNode }) {
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        backgroundColor: theme.colors.surface,
        borderBottomWidth: theme.borderWidth.thin,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <BrandMark />
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="title" tone="brand" style={{ fontWeight: '800', letterSpacing: -0.8 }}>
              DrivX.
            </Text>
            <Tag label="CUSTOMER" tone="outline" />
          </View>
          <Text
            variant="overline"
            tone="muted"
            style={{ fontSize: theme.fontSize.xs - 2, letterSpacing: 1.4 }}
            numberOfLines={1}
          >
            {tagline.toUpperCase()}
          </Text>
        </View>
      </View>

      {right ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          {right}
        </View>
      ) : null}
    </View>
  );
}
