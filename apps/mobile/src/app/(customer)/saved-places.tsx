import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Field, Screen, ScreenHeader, StateView, Text, useTheme } from '@drivx/ui';
import type { Place, SavedPlaceInput } from '@drivx/domain';
import { useMyBookings, useSavedPlaces } from '../../features/customer/queries';
import { useAddSavedPlace, useDeleteSavedPlace } from '../../features/customer/mutations';

const LABELS: SavedPlaceInput['label'][] = ['home', 'work', 'other'];

const LABEL_TITLE: Record<SavedPlaceInput['label'], string> = {
  home: 'Home',
  work: 'Work',
  other: 'Other',
};

/**
 * Saved places are the one piece of booking data a customer fully owns, so this
 * writes real documents under `savedPlaces/{uid}/places/`. Adding a *new*
 * address needs Places Autocomplete, so the choices here come from trips the
 * customer has actually taken — real coordinates, not typed guesses.
 */
export default function SavedPlaces() {
  const theme = useTheme();
  const places = useSavedPlaces();
  const bookings = useMyBookings();
  const add = useAddSavedPlace();
  const remove = useDeleteSavedPlace();

  const [label, setLabel] = useState<SavedPlaceInput['label']>('home');
  const [name, setName] = useState('');
  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const seen = new Map<string, Place>();
    for (const booking of bookings.data ?? []) {
      for (const place of [booking.pickup, booking.destination]) {
        if (!place) continue;
        seen.set(`${place.location.lat},${place.location.lng}`, place);
      }
    }
    return [...seen.entries()].map(([key, place]) => ({ key, place }));
  }, [bookings.data]);

  const source = candidates.find((candidate) => candidate.key === sourceKey)?.place ?? null;

  const onSave = () => {
    setFeedback(null);
    if (!source) {
      setFeedback('Choose one of the addresses below first.');
      return;
    }
    if (name.trim().length < 1) {
      setFeedback('Give it a name you will recognise.');
      return;
    }
    add.mutate(
      { label, name: name.trim(), place: { ...source, source: 'saved_place' } },
      {
        onSuccess: () => {
          setName('');
          setSourceKey(null);
        },
        onError: (error) =>
          setFeedback(error instanceof Error ? error.message : 'Could not save that place.'),
      },
    );
  };

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          title="Saved places"
          subtitle="Addresses you reuse when requesting a trip."
        />

        {places.isError ? (
          <StateView
            kind="permission_denied"
            title="Could not read your saved places"
            message={places.error instanceof Error ? places.error.message : 'Firestore refused.'}
          />
        ) : null}

        <Card style={{ gap: theme.spacing.xs }}>
          <Text variant="subheading" tone="brand">
            Your places
          </Text>
          {(places.data ?? []).length === 0 && !places.isPending ? (
            <Text variant="caption" tone="muted">
              None yet.
            </Text>
          ) : (
            (places.data ?? []).map((place) => (
              <View
                key={place.id}
                style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
              >
                <View style={{ flex: 1, gap: theme.spacing.xxs }}>
                  <Text variant="caption">{place.name}</Text>
                  <Text variant="caption" tone="faint">
                    {place.label} · {place.place?.city ?? 'no city'}
                  </Text>
                </View>
                <Button
                  label="Remove"
                  appearance="ghost"
                  size="sm"
                  loading={remove.isPending && remove.variables === place.id}
                  onPress={() =>
                    remove.mutate(place.id, {
                      onError: (error) =>
                        setFeedback(
                          error instanceof Error ? error.message : 'Could not remove that place.',
                        ),
                    })
                  }
                />
              </View>
            ))
          )}
        </Card>

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading" tone="brand">
            Add a place
          </Text>
          <Text variant="caption" tone="muted">
            Typeahead addresses need a Google Maps key, so a new saved place starts from an address on
            one of your trips.
          </Text>

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" tone="brand">
              Label
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {LABELS.map((option) => (
                <Button
                  key={option}
                  label={LABEL_TITLE[option]}
                  size="sm"
                  appearance="secondary"
                  selected={label === option}
                  onPress={() => setLabel(option)}
                />
              ))}
            </View>
          </View>

          <Field
            label="Name"
            value={name}
            onChangeText={setName}
            accessibilityLabel="Name for this place"
          />

          {candidates.length === 0 ? (
            <Text variant="caption" tone="warning">
              No trip addresses to save yet. {add.isPending ? '' : 'Book a trip first.'}
            </Text>
          ) : (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="label" tone="brand">
                Choose an address from your trips
              </Text>
              <View style={{ gap: theme.spacing.sm }}>
                {candidates.map((candidate) => (
                  <Button
                    key={candidate.key}
                    label={`${candidate.place.label} · ${candidate.place.city}`}
                    size="sm"
                    appearance="secondary"
                    selected={sourceKey === candidate.key}
                    fullWidth
                    onPress={() => setSourceKey(candidate.key)}
                  />
                ))}
              </View>
            </View>
          )}

          <Button
            label="Save place"
            onPress={onSave}
            loading={add.isPending}
            disabled={!source}
            fullWidth
          />

          {feedback ? (
            <Text variant="caption" tone="danger" accessibilityRole="alert">
              {feedback}
            </Text>
          ) : null}
        </Card>
      </View>
    </Screen>
  );
}
