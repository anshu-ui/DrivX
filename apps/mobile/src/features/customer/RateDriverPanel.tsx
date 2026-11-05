import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button, Card, Field, Text, useTheme } from '@drivx/ui';
import { DRIVER_RATING_TAGS, RATING_SCORE_MAX, type DriverRatingTag } from '@drivx/domain';
import { ratingTagLabel } from './labels';
import { useRateDriver, type RateTripResult } from './mutations';

/**
 * The customer's rating of the driver, on the trip that just closed.
 *
 * The owner asked for a rating "against the driverId", and this is the only
 * surface that can honestly produce one: the panel sends the booking id and
 * nothing else, so the score lands on the driver `rateTrip` reads off that
 * booking — not on a uid picked on a screen. `ratings` is closed to client
 * writes by the rules, so a tampered payload has no document to land in.
 *
 * One rating per trip is the server's rule, and the panel mirrors it rather
 * than fighting it: as soon as a score exists on the booking, this becomes a
 * receipt line instead of a form. A second tap while the first is still in
 * flight is answered by the function with the rating that already exists.
 */

const STARS = Array.from({ length: RATING_SCORE_MAX }, (_, i) => i + 1);

function StarRow({
  value,
  onPick,
  size,
}: {
  value: number;
  onPick?: (score: number) => void;
  size: number;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
      {STARS.map((star) => {
        const filled = star <= value;
        const icon = (
          <Ionicons
            name={filled ? 'star' : 'star-outline'}
            size={size}
            color={filled ? theme.colors.primaryInk : theme.colors.skeleton}
          />
        );
        if (!onPick) return <View key={star}>{icon}</View>;
        return (
          <Pressable
            key={star}
            accessibilityRole="button"
            accessibilityLabel={`${star} star${star === 1 ? '' : 's'}`}
            hitSlop={8}
            onPress={() => onPick(star)}
          >
            {icon}
          </Pressable>
        );
      })}
    </View>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Shown in place of the form once a score exists, from this submit or from the booking. */
function RatedCard({
  score,
  driverName,
  result,
}: {
  score: number;
  driverName: string | null;
  result: RateTripResult | null;
}) {
  const theme = useTheme();
  const aggregate = result?.driverRating;
  return (
    <Card tone="inset" style={{ gap: theme.spacing.sm }}>
      <Text variant="subheading" tone="brand">
        You rated this trip {score} star{score === 1 ? '' : 's'}
      </Text>
      <StarRow value={score} size={20} />
      {aggregate ? (
        <Text variant="caption" tone="muted">
          {driverName ?? 'Your driver'} now stands at {aggregate.ratingAverage.toFixed(2)} from{' '}
          {plural(aggregate.ratingCount, 'rating')}.
        </Text>
      ) : null}
      <Text variant="caption" tone="faint">
        Saved with the booking. A trip is rated once, so this is the rating DrivX holds.
      </Text>
    </Card>
  );
}

export function RateDriverPanel({
  bookingId,
  driverName,
  customerRating,
}: {
  bookingId: string;
  driverName: string | null;
  /** The score already on the booking, or null while the trip is unrated. */
  customerRating: number | null;
}) {
  const theme = useTheme();
  const [score, setScore] = useState<number | null>(null);
  const [tags, setTags] = useState<DriverRatingTag[]>([]);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<RateTripResult | null>(null);
  const rate = useRateDriver();

  if (customerRating !== null) {
    return (
      <RatedCard
        score={sent?.score ?? customerRating}
        driverName={driverName}
        result={sent && !sent.alreadyRated ? sent : null}
      />
    );
  }

  const toggleTag = (tag: DriverRatingTag) => {
    setError(null);
    setTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
  };

  const submit = () => {
    if (score === null) return;
    setError(null);
    rate.mutate(
      { bookingId, score, tags, comment: comment.trim() || null },
      {
        onSuccess: (outcome) => {
          if (!outcome.ok) {
            setError(outcome.error.message);
            return;
          }
          setSent(outcome.result);
        },
        onError: (cause) =>
          setError(
            cause instanceof Error ? cause.message : 'DrivX could not record the rating just now.',
          ),
      },
    );
  };

  return (
    <Card style={{ gap: theme.spacing.sm }}>
      <Text variant="subheading" tone="brand">
        How was the drive?
      </Text>
      <Text variant="caption" tone="muted">
        {driverName ? `${driverName} is rated on this trip alone. ` : 'Your driver is rated on this trip alone. '}
        The score goes on their DrivX profile, not on the booking.
      </Text>

      <StarRow
        value={score ?? 0}
        onPick={(picked) => {
          setScore(picked);
          setError(null);
        }}
        size={34}
      />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
        {DRIVER_RATING_TAGS.map((tag) => {
          const picked = tags.includes(tag);
          return (
            <Pressable
              key={tag}
              accessibilityRole="button"
              accessibilityState={{ selected: picked }}
              onPress={() => toggleTag(tag)}
              style={{
                borderRadius: theme.radius.pill,
                borderWidth: theme.borderWidth.thin,
                borderColor: picked ? theme.colors.primary : theme.colors.border,
                backgroundColor: picked ? theme.colors.primarySoft : theme.colors.surface,
                paddingHorizontal: theme.spacing.sm,
                paddingVertical: theme.spacing.xxs,
              }}
            >
              <Text variant="caption" tone={picked ? 'primary' : 'muted'}>
                {ratingTagLabel(tag)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Field
        label="Anything to add"
        optional
        multiline
        value={comment}
        onChangeText={(text) => {
          setComment(text);
          setError(null);
        }}
      />

      {error ? (
        <Text variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <Button
        label="Send rating"
        onPress={submit}
        disabled={score === null}
        loading={rate.isPending}
      />

      <Text variant="caption" tone="faint">
        Ratings are one per trip and cannot be changed afterwards, so check the stars before sending.
        DrivX reads them when the office reviews a driver.
      </Text>
    </Card>
  );
}
