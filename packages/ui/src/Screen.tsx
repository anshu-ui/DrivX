import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeProvider';

export type ScreenProps = {
  children: React.ReactNode;
  /** `scroll` for forms and content, `fixed` for map-backed layouts. */
  layout?: 'scroll' | 'fixed';
  /** Removes the horizontal gutter for edge-to-edge surfaces such as maps. */
  bleed?: boolean;
  paddedBottom?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Screen({ children, layout = 'scroll', bleed = false, paddedBottom = true, style }: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const gutter = bleed ? 0 : theme.sizing.screenGutter;

  const content = (
    <View style={[styles.content, { paddingVertical: theme.spacing.lg, gap: theme.sizing.cardGap }]}>
      {children}
    </View>
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}
    >
      {layout === 'scroll' ? (
        <ScrollView
          style={{ paddingHorizontal: gutter }}
          contentContainerStyle={{ paddingBottom: insets.bottom + (paddedBottom ? theme.spacing.xxxl : 0) }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        <View style={[styles.flex, { paddingHorizontal: gutter }]}>
          {content}
          <View style={{ height: insets.bottom + (paddedBottom ? theme.spacing.xl : 0) }} />
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  content: { flexGrow: 1 },
});
