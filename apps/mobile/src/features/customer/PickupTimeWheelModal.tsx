import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button, Divider, Text, useTheme } from '@drivx/ui';
import {
  clockLabel,
  latestBookingDateMs,
  MIN_LEAD_MS,
  nextScheduleSlot,
  pickupTimeNeedsMoreNotice,
  scheduledEpochMs,
  upcomingDays,
  type ScheduleDay,
  type ScheduleSlot,
} from './booking';

const HOURS = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = [0, 15, 30, 45];
const MERIDIEMS = ['am', 'pm'] as const;
const ITEM_HEIGHT = 42;
const WHEEL_HEIGHT = 210;

type WheelValue = string | number;
type WheelItem = { label: string; value: WheelValue };

type WheelColumnProps = {
  label: string;
  items: WheelItem[];
  selectedValue: WheelValue;
  height: number;
  width: `${number}%`;
  onChange: (value: WheelValue) => void;
};

function WheelColumn({ label, items, selectedValue, height, width, onChange }: WheelColumnProps) {
  const theme = useTheme();
  const scrollRef = useRef<ScrollViewInstance | null>(null);
  const selectedIndex = Math.max(0, items.findIndex((item) => item.value === selectedValue));
  const padding = (height - ITEM_HEIGHT) / 2;
  const initialIndex = useRef(selectedIndex);
  const lastNotifiedValue = useRef<WheelValue>(selectedValue);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ y: initialIndex.current * ITEM_HEIGHT, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function notifyValue(value: WheelValue) {
    if (Object.is(lastNotifiedValue.current, value)) return;
    lastNotifiedValue.current = value;
    onChange(value);
  }

  function commitScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    if (items.length === 0) return;
    const index = Math.max(0, Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.y / ITEM_HEIGHT)));
    notifyValue(items[index]!.value);
  }

  return (
    <View accessibilityLabel={label} style={{ width, height, overflow: 'hidden' }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: padding,
          left: 0,
          right: 0,
          height: ITEM_HEIGHT,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.surfaceMuted,
        }}
      />
      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        bounces={false}
        decelerationRate="fast"
        snapToInterval={ITEM_HEIGHT}
        snapToAlignment="start"
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingVertical: padding }}
        onScroll={commitScroll}
        onScrollEndDrag={commitScroll}
        onMomentumScrollEnd={commitScroll}
      >
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          const distance = Math.abs(index - selectedIndex);
          const opacity = selected ? 1 : distance === 1 ? 0.52 : distance === 2 ? 0.24 : 0.1;
          return (
            <Pressable
              key={`${String(item.value)}-${index}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                notifyValue(item.value);
                scrollRef.current?.scrollTo({ y: index * ITEM_HEIGHT, animated: true });
              }}
              style={{ height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity }}
            >
              <Text
                numberOfLines={1}
                variant={selected ? 'body' : 'caption'}
                style={{
                  color: selected ? theme.colors.text : theme.colors.textMuted,
                  fontWeight: selected ? '700' : '500',
                  textAlign: 'center',
                  paddingHorizontal: 2,
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function scheduleSlotAtEpoch(epochMs: number, nowMs: number): ScheduleSlot {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const nowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const current = (type: string) => Number(nowParts.find((part) => part.type === type)?.value ?? 0);
  const offsetDays = Math.round(
    (Date.UTC(get('year'), get('month') - 1, get('day')) - Date.UTC(current('year'), current('month') - 1, current('day'))) /
      86_400_000,
  );
  const hour24 = get('hour');
  return {
    offsetDays,
    hour12: hour24 % 12 || 12,
    minute: get('minute'),
    meridiem: hour24 >= 12 ? 'pm' : 'am',
  };
}

function selectedDateLabel(day: ScheduleDay | undefined, slot: ScheduleSlot): string {
  return day?.label ?? `Day ${slot.offsetDays + 1}`;
}

export function PickupTimeWheelModal({
  initialEpochMs,
  nowMs,
  onClose,
  onConfirm,
}: {
  initialEpochMs: number | null;
  nowMs: number;
  onClose: () => void;
  onConfirm: (slot: ScheduleSlot) => void;
}) {
  const theme = useTheme();
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();
  const wheelHeight = Math.min(WHEEL_HEIGHT, Math.max(ITEM_HEIGHT * 4, windowHeight * 0.3));
  const compact = windowWidth < 360;
  const dates = useMemo(() => {
    const latest = latestBookingDateMs(nowMs);
    return upcomingDays(nowMs, 200).filter((day) =>
      scheduledEpochMs({ offsetDays: day.offsetDays, hour12: 12, minute: 0, meridiem: 'pm' }, nowMs) <= latest,
    );
  }, [nowMs]);
  const initialSlot = useMemo(() => {
    const fallback = nextScheduleSlot(nowMs);
    return scheduleSlotAtEpoch(initialEpochMs ?? scheduledEpochMs(fallback, nowMs), nowMs);
  }, [initialEpochMs, nowMs]);
  const [draft, setDraft] = useState<ScheduleSlot>(initialSlot);

  const selectedDay = dates.find((day) => day.offsetDays === draft.offsetDays) ?? dates[0];
  const dateItems: WheelItem[] = dates.map((day) => ({ label: day.label, value: day.offsetDays }));
  const hourItems: WheelItem[] = HOURS.map((hour) => ({ label: String(hour), value: hour }));
  const minuteItems: WheelItem[] = MINUTES.map((minute) => ({ label: String(minute).padStart(2, '0'), value: minute }));
  const meridiemItems: WheelItem[] = MERIDIEMS.map((value) => ({ label: value.toUpperCase(), value }));
  const scheduledForMs = scheduledEpochMs(draft, nowMs);
  const tooSoon = pickupTimeNeedsMoreNotice(scheduledForMs, nowMs);
  const afterBookingWindow = scheduledForMs > latestBookingDateMs(nowMs);
  const canSchedule = !tooSoon && !afterBookingWindow;
  const pickupLabel = `${selectedDateLabel(selectedDay, draft)}, ${clockLabel(draft)} IST`;

  function updateDate(value: WheelValue) {
    setDraft((current) => ({ ...current, offsetDays: Number(value) }));
  }

  function updateHour(value: WheelValue) {
    setDraft((current) => ({ ...current, hour12: Number(value) }));
  }

  function updateMinute(value: WheelValue) {
    setDraft((current) => ({ ...current, minute: Number(value) }));
  }

  function updateMeridiem(value: WheelValue) {
    setDraft((current) => ({ ...current, meridiem: value as ScheduleSlot['meridiem'] }));
  }

  const closeButton = (
    <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={10} style={{ padding: 2 }}>
      <Ionicons name="close-circle" size={27} color={theme.colors.textMuted} />
    </Pressable>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: compact ? theme.spacing.sm : theme.spacing.lg, paddingVertical: theme.spacing.lg, backgroundColor: theme.colors.scrim }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close pickup time picker"
          onPress={onClose}
          style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            gap: compact ? theme.spacing.sm : theme.spacing.md,
            borderRadius: theme.radius.xl,
            backgroundColor: theme.colors.surface,
            padding: compact ? theme.spacing.md : theme.spacing.lg,
            maxHeight: '88%',
            ...theme.elevation.overlay,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand" style={{ flex: 1 }}>When do you need a driver?</Text>
            {closeButton}
          </View>

          <Divider size="sm" />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.xs }}>
            <Text variant="label" tone="muted">Pickup time</Text>
            <Text variant="caption" tone="primary">India Standard Time · IST</Text>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.xxs }}>
            <WheelColumn
              label="Pickup date"
              items={dateItems}
              selectedValue={draft.offsetDays}
              height={wheelHeight}
              width="44%"
              onChange={updateDate}
            />
            <WheelColumn label="Hour" items={hourItems} selectedValue={draft.hour12} height={wheelHeight} width="15%" onChange={updateHour} />
            <WheelColumn label="Minute" items={minuteItems} selectedValue={draft.minute} height={wheelHeight} width="15%" onChange={updateMinute} />
            <WheelColumn label="AM or PM" items={meridiemItems} selectedValue={draft.meridiem} height={wheelHeight} width="18%" onChange={updateMeridiem} />
          </View>

          <Text variant="caption" tone={tooSoon ? 'danger' : afterBookingWindow ? 'danger' : 'muted'} accessibilityRole={tooSoon || afterBookingWindow ? 'alert' : undefined}>
            {tooSoon
              ? `Choose a pickup at least ${MIN_LEAD_MS / 60_000} minutes from now.`
              : afterBookingWindow
                ? 'Choose a pickup within the next six months.'
                : 'Pickup needs at least 30 minutes’ notice. Times are shown in IST.'}
          </Text>

          <Button
            label={`Schedule for ${pickupLabel}`}
            onPress={() => onConfirm(draft)}
            disabled={!canSchedule}
            fullWidth
            size="lg"
            style={{ minHeight: 54 }}
          />
        </View>
      </View>
    </Modal>
  );
}
