import type { ComponentProps } from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, useTheme } from '@drivx/ui';
import type { NotificationView } from '../features/customer/queries';
import { dateTime } from '../features/customer/labels';

type IconName = ComponentProps<typeof Ionicons>['name'];

const iconForType = (type: string | null): IconName => {
  const normalized = type?.toLowerCase() ?? '';
  if (normalized.includes('cancel')) return 'close-circle-outline';
  if (normalized.includes('complete') || normalized.includes('success')) return 'checkmark-circle-outline';
  if (normalized.includes('payment') || normalized.includes('earning') || normalized.includes('due')) return 'wallet-outline';
  if (normalized.includes('offer') || normalized.includes('booking') || normalized.includes('assigned')) return 'car-sport-outline';
  if (normalized.includes('announcement')) return 'megaphone-outline';
  if (normalized.includes('trip') || normalized.includes('driver')) return 'navigate-outline';
  return 'notifications-outline';
};

export function NotificationsInbox({
  items,
  isLoading,
  error,
  pendingId,
  onMarkRead,
}: {
  items: NotificationView[];
  isLoading: boolean;
  error?: string | null;
  pendingId?: string | null;
  onMarkRead: (id: string) => void;
}) {
  const theme = useTheme();
  const unreadCount = items.filter((item) => item.readAtMs === null).length;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.primarySoft,
          }}
        >
          <Ionicons name="notifications-outline" size={21} color={theme.colors.primaryInk} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="subheading" tone="brand">Notifications</Text>
          <Text variant="caption" tone="muted">
            {unreadCount ? `${unreadCount} new update${unreadCount === 1 ? '' : 's'}` : 'Your DrivX trip updates'}
          </Text>
        </View>
        {unreadCount > 0 ? (
          <View style={{ minWidth: 27, height: 27, borderRadius: 14, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primary }}>
            <Text variant="caption" style={{ color: theme.colors.onPrimary, fontWeight: '700' }}>{unreadCount}</Text>
          </View>
        ) : null}
      </View>

      {error ? (
        <View style={{ borderRadius: theme.radius.md, padding: theme.spacing.md, backgroundColor: theme.colors.dangerSoft }}>
          <Text variant="caption" tone="danger">{error}</Text>
        </View>
      ) : null}

      {!error && !isLoading && items.length === 0 ? (
        <View style={{ alignItems: 'center', gap: 7, paddingVertical: theme.spacing.lg, borderRadius: theme.radius.md, backgroundColor: theme.colors.surfaceMuted }}>
          <Ionicons name="notifications-off-outline" size={24} color={theme.colors.textMuted} />
          <Text variant="bodyStrong" tone="brand">You’re all caught up</Text>
          <Text variant="caption" tone="muted">Booking and trip alerts will appear here.</Text>
        </View>
      ) : null}

      {isLoading && items.length === 0 ? (
        <Text variant="caption" tone="muted">Loading your latest updates…</Text>
      ) : null}

      {items.map((item) => {
        const unread = item.readAtMs === null;
        return (
          <View
            key={item.id}
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 11,
              padding: 13,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: unread ? '#D5E2FF' : theme.colors.border,
              backgroundColor: unread ? '#F6F8FF' : theme.colors.surface,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                flexShrink: 0,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: unread ? theme.colors.primarySoft : theme.colors.surfaceMuted,
              }}
            >
              <Ionicons name={iconForType(item.type)} size={18} color={unread ? theme.colors.primaryInk : theme.colors.textMuted} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 7 }}>
                <Text variant="bodyStrong" tone="brand" style={{ flex: 1 }}>
                  {item.title ?? item.type ?? 'DrivX update'}
                </Text>
                {unread ? <View style={{ width: 7, height: 7, marginTop: 6, borderRadius: 4, backgroundColor: theme.colors.primary }} /> : null}
              </View>
              <Text variant="caption" tone="muted">{item.body ?? 'There is an update to your booking.'}</Text>
              <Text variant="overline" tone="faint" style={{ marginTop: 2 }}>{dateTime(item.createdAtMs)}</Text>
              {unread ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${item.title ?? 'notification'} as read`}
                  disabled={pendingId === item.id}
                  onPress={() => onMarkRead(item.id)}
                  style={{ alignSelf: 'flex-start', marginTop: 3, paddingVertical: 3, paddingRight: 8 }}
                >
                  <Text variant="label" tone="primary">
                    {pendingId === item.id ? 'Saving…' : 'Mark as read'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
