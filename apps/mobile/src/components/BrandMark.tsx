import { Image, View } from 'react-native';
import { useTheme } from '@drivx/ui';

/**
 * The DrivX mark on its ink tile. `size` is the tile; the glyph inside is 68% of
 * it, which is the optical balance the app icon uses.
 */
export function BrandMark({ size = 44 }: { size?: number }) {
  const theme = useTheme();
  const glyph = Math.round(size * 0.68);

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surfaceBrand,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Image
        source={require('../../assets/logo-mark-light.png')}
        style={{ width: glyph, height: glyph }}
        resizeMode="contain"
        accessibilityLabel="DrivX"
      />
    </View>
  );
}
