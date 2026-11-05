import { useState } from 'react';
import { View } from 'react-native';
import { Button, Field, OptionCard, Sheet, Text, useTheme } from '@drivx/ui';
import { CANCELLATION_REASONS, isCancellable, type BookingStatus, type CancellationReason } from '@drivx/domain';
import { CANCELLATION_REASON_LABEL } from './labels';
import { useCancelBooking } from './mutations';

/**
 * Cancelling a trip, from the only end that can do it.
 *
 * The owner's rule is that a customer cancels their own booking and nobody else
 * does: a driver who cannot attend hands the job back to dispatch, so the button
 * on this panel is the single cancellation path in the product. It calls
 * `cancelBooking` rather than writing Firestore, because the decision about
 * whether a trip may still be ended belongs to the server, and the trip's
 * document is closed to a client.
 */

export function CancelTripAction({
  bookingId,
  status,
  hasDriver,
}: {
  bookingId: string;
  status: BookingStatus;
  hasDriver: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CancellationReason | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cancel = useCancelBooking();

  // Past the point of no return — the trip has started or is already closed — so
  // there is nothing to offer. Saying "this cannot be cancelled" on every trip
  // would be noise; the status the screen already shows carries that.
  if (!isCancellable(status)) return null;

  const close = () => {
    setOpen(false);
    setReason(null);
    setNote('');
    setError(null);
  };

  const submit = () => {
    if (!reason) return;
    setError(null);
    cancel.mutate(
      {
        bookingId,
        reasonCode: reason,
        reasonText: reason === 'other' ? note.trim() || null : null,
      },
      {
        // The function refuses on its own terms — the trip moved out from under
        // this screen, or it is not this customer's — and its message is the
        // plainest thing available to show.
        onSuccess: (outcome) => {
          if (!outcome.ok) {
            setError(outcome.error.message);
            return;
          }
          close();
        },
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'The cancellation did not go through.'),
      },
    );
  };

  return (
    <>
      <Button
        label="Cancel trip"
        onPress={() => setOpen(true)}
        appearance="danger"
        size="sm"
        accessibilityLabel={`Cancel booking ${bookingId}`}
      />

      <Sheet
        open={open}
        title="Cancel this trip"
        subtitle={
          hasDriver
            ? 'A driver is on this booking. Cancelling ends it for them too.'
            : 'Nothing has been charged, so nothing is kept.'
        }
        onClose={close}
        footer={
          <View style={{ gap: theme.spacing.sm }}>
            {error ? (
              <Text variant="caption" tone="danger" accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button label="Keep the trip" onPress={close} appearance="secondary" style={{ flex: 1 }} />
              <Button
                label="Confirm cancellation"
                onPress={submit}
                appearance="danger"
                disabled={reason === null}
                loading={cancel.isPending}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        }
      >
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="label" tone="brand">
            WHY ARE YOU CANCELLING?
          </Text>
          {CANCELLATION_REASONS.map((code) => (
            <OptionCard
              key={code}
              title={CANCELLATION_REASON_LABEL[code]}
              selected={reason === code}
              // OptionCard is built for a row of choices and carries `flex: 1`,
              // which in this column would stretch six cards to fill the panel.
              style={{ flex: 0, flexBasis: 'auto', width: '100%' }}
              onPress={() => {
                setReason(code);
                setError(null);
              }}
            />
          ))}
          {reason === 'other' ? (
            <Field
              label="Tell us what happened"
              optional
              multiline
              value={note}
              onChangeText={setNote}
            />
          ) : null}
          <Text variant="caption" tone="faint">
            This is the customer’s own cancellation, and it is recorded with the reason on the trip.
            Once it is cancelled the booking cannot be reopened — book again for a new trip.
          </Text>
        </View>
      </Sheet>
    </>
  );
}
