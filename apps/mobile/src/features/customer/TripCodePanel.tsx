import { View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Text, useTheme } from '@drivx/ui';
import type { BookingStatus } from '@drivx/domain';
import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * The two codes that let the trip move.
 *
 * The driver cannot read these — the digits are only ever sent to the customer's
 * app, which is the whole point: a code the driver could see would not prove the
 * customer was standing at the car. So this panel is where the proof is handed
 * over, and it names which stage each code is for.
 *
 * There is no button on this panel, deliberately. The owner's rule of
 * 2026-10-27: "otp ek bar generate hoga system generate karega booking id ke
 * against, hum bar bar new code generate ni kar sakte." The server mints each
 * code once against the booking id and returns the same digits to every later
 * read, so the number the customer was shown at the car is still the number on
 * this screen after a restart, a day, or three reloads — and nobody can burn
 * through a trip's codes by tapping.
 *
 * The same digits arrive in the customer's inbox as a message, written by the
 * server when the codes are minted. SMS and WhatsApp are not wired on this
 * project, so this panel and that inbox row are how the codes reach them today.
 */

const STARTABLE: BookingStatus[] = ['assigned', 'driver_en_route', 'driver_arrived'];
const RUNNING: BookingStatus[] = ['trip_started', 'in_progress', 'destination_reached'];

/** Statuses the server will hand codes out in. Outside them, this panel explains instead. */
function codeStage(status: BookingStatus): boolean {
  return STARTABLE.includes(status) || RUNNING.includes(status);
}

type TripCodes = { bookingId: string; reference: string | null; start: string; end: string };

/**
 * Read this booking's codes. Retried by the query client when the trip's status
 * changes, because the first read of a booking that just got a driver is the one
 * that mints them.
 */
export function useTripCodes(bookingId: string, enabled: boolean) {
  const { user } = useSession();
  const client = useQueryClient();
  return useQuery({
    queryKey: ['tripCodes', bookingId, user?.uid ?? null],
    enabled: enabled && Boolean(user),
    staleTime: Infinity,
    retry: 1,
    queryFn: async () => {
      try {
        const codes = await callFunction<{ bookingId: string }, TripCodes>(firebase(), 'tripCodes', { bookingId });
        // Minting writes an `otp_sent` line and an inbox message; both are read
        // elsewhere on this screen, so their caches move with it.
        await client.invalidateQueries({ queryKey: ['booking'] });
        await client.invalidateQueries({ queryKey: ['notifications'] });
        return codes;
      } catch (error) {
        if (error instanceof FunctionCallError) throw new Error(error.message);
        throw new Error('DrivX could not be reached, so the codes could not be shown.');
      }
    },
  });
}

function CodeCard({ label, code, note }: { label: string; code: string; note: string }) {
  const theme = useTheme();
  return (
    <Card tone="brand" style={{ gap: theme.spacing.xs }}>
      <Text variant="caption" tone="onBrand">
        {label}
      </Text>
      <Text
        variant="fare"
        tone="onBrand"
        accessibilityLiveRegion="polite"
        // Six digits with a space in the middle is the difference between a code
        // read out correctly over the phone and one read out twice.
        aria-label={`${label}: ${code.split('').join(' ')}`}
      >
        {`${code.slice(0, 3)} ${code.slice(3)}`}
      </Text>
      <Text variant="caption" tone="onBrand">
        {note}
      </Text>
    </Card>
  );
}

/**
 * The customer's side of the trip loop: the digits the driver has to be told.
 *
 * `theme.spacing.sm` is the only layout decision here. Which of the two cards
 * matters *now* is stated on the card, because both are on screen from the
 * moment a driver is assigned — that is what the owner asked for, and a customer
 * who can see the end code early is a customer who is not asked for it twice.
 */
export function TripCodePanel({ bookingId, status }: { bookingId: string; status: BookingStatus }) {
  const theme = useTheme();
  const showCodes = codeStage(status);
  const codes = useTripCodes(bookingId, showCodes);

  if (!showCodes) {
    return (
      <Card tone="inset">
        <Text variant="caption" tone="muted">
          {status === 'requested' || status === 'searching_driver'
            ? 'The codes are generated once a driver is on the job.'
            : 'No code is needed for this trip any more.'}
        </Text>
      </Card>
    );
  }

  if (codes.isPending) {
    return (
      <Card tone="inset">
        <Text variant="caption" tone="muted">
          Fetching your trip codes…
        </Text>
      </Card>
    );
  }

  if (codes.isError) {
    return (
      <Card tone="flat" style={{ gap: theme.spacing.xs }}>
        <Text variant="bodyStrong" tone="danger">
          {(codes.error as Error).message}
        </Text>
        <Text variant="caption" tone="muted">
          Reopen this trip. The codes are generated once and are not lost by a failed read.
        </Text>
      </Card>
    );
  }

  const started = RUNNING.includes(status);

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <CodeCard
        label={started ? 'Start code — used' : 'Start code'}
        code={codes.data.start}
        note={
          started
            ? 'Already read to the driver at pickup. It has been used and cannot work again.'
            : 'Read it to the driver at the car, with your opening odometer reading. Nothing starts without it.'
        }
      />
      <CodeCard
        label="End code"
        code={codes.data.end}
        note={
          started
            ? 'Read it at the drop. The bill is priced between the two odometer readings.'
            : 'This is the code for the drop. Keep it — it works once, and no new one is issued.'
        }
      />
    </View>
  );
}
