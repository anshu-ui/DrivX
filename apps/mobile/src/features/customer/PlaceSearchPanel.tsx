import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Button, Text, useTheme } from '@drivx/ui';
import type { GeoPointLite, Place } from '@drivx/domain';
import type { SavedPlaceView } from './queries';
import {
  devicePosition,
  useCurrentLocationPlace,
  usePlaceSearch,
  useResolvePlace,
} from './places';

/** How long a pause before the words in the box are worth a Google call. */
const DEBOUNCE_MS = 180;

type Row = { key: string; primary: string; secondary: string; onPress: () => void };

/**
 * The address picker inside the booking composer.
 *
 * Three sources in one list, in the order a customer actually uses them: the
 * position the phone already has, the places they saved, and typed search
 * against Google Places. Only the third costs money, so it is the last resort —
 * an empty box queries nothing, and a suggestion carries no coordinate until it
 * is tapped and resolved.
 */
export function PlaceSearchPanel({
  title,
  savedPlaces,
  pickedPlaceId,
  onPick,
  onOpenSavedPlaces,
}: {
  title: string;
  savedPlaces: SavedPlaceView[];
  /** The row that is already chosen, so the list shows a tick rather than guessing. */
  pickedPlaceId: string | null;
  onPick: (place: Place, name: string, placeKey: string) => void;
  onOpenSavedPlaces: () => void;
}) {
  const theme = useTheme();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [near, setNear] = useState<GeoPointLite | null>(null);
  const [locationNote, setLocationNote] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const resolve = useResolvePlace();
  const currentLocation = useCurrentLocationPlace();
  const search = usePlaceSearch(debounced, near);
  const askedForFix = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Asked once, not per render: the permission prompt must not reappear every
  // time the customer opens the sheet a second time.
  useEffect(() => {
    if (askedForFix.current) return;
    askedForFix.current = true;
    devicePosition()
      .then((position) => {
        setNear(position);
        if (!position) setLocationNote('Location is off, so search will not know where you are.');
      })
      .catch(() => setLocationNote('Could not read your position. Type an address instead.'));
  }, []);

  const busy = resolve.isPending || currentLocation.isPending;
  const outcome = search.data;

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];

    if (near) {
      list.push({
        key: 'current',
        primary: 'Use current location',
        secondary: locationNote ?? 'Near you',
        onPress: () => {
          currentLocation.mutate(near, {
            onSuccess: (result) => {
              if (result.failed) {
                setLocationNote(result.error.message);
                return;
              }
              onPick(result.place, result.place.label, 'current');
            },
          });
        },
      });
    }

    if (!debounced) {
      for (const saved of savedPlaces) {
        if (!saved.place) continue;
        list.push({
          key: saved.id,
          primary: saved.name,
          secondary: saved.place.label,
          onPress: () => onPick(saved.place!, saved.name, saved.id),
        });
      }
      return list;
    }

    for (const suggestion of outcome && !outcome.failed ? outcome.suggestions : []) {
      list.push({
        key: suggestion.placeId,
        primary: suggestion.mainText,
        secondary: suggestion.secondaryText,
        onPress: () => {
          resolve.mutate(suggestion.placeId, {
            onSuccess: (result) => {
              if (result.failed) {
                setSelectionError(result.error.message);
                return;
              }
              setSelectionError(null);
              onPick(result.place, result.place.label, suggestion.placeId);
            },
          });
        },
      });
    }
    return list;
  }, [currentLocation, debounced, locationNote, near, onPick, outcome, resolve, savedPlaces]);

  const statusLine = (() => {
    if (busy) return 'Finding that address…';
    if (search.isFetching) return 'Searching nearby places…';
    if (selectionError) return selectionError;
    if (debounced.length > 0 && debounced.length < 2) return 'Type at least two characters.';
    if (outcome?.failed) return outcome.error.message;
    if (outcome && !outcome.configured) {
      return 'Address search is not configured on this build. Saved places still work.';
    }
    if (debounced && rows.filter((row) => row.key !== 'current').length === 0 && !search.isPending) {
      return `No match for “${debounced}”. Try a landmark or a PIN code.`;
    }
    return null;
  })();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="label" tone="muted">
        {title}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          borderRadius: theme.radius.md,
          borderWidth: theme.borderWidth.thin,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
          paddingHorizontal: theme.spacing.sm,
        }}
      >
        <Ionicons name="search-outline" size={16} color={theme.colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={(value) => { setSelectionError(null); setQuery(value); }}
          accessibilityLabel="Search for an address"
          placeholder="Search pickup or drop location"
          returnKeyType="search"
          autoCorrect={false}
          style={[
            {
              flex: 1,
              paddingVertical: theme.spacing.sm,
              color: theme.colors.text,
              fontFamily: theme.fontFamily.text,
              fontSize: theme.typography.body.fontSize,
            },
          ]}
        />
        {query ? (
          <Pressable accessibilityRole="button" onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={theme.colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {rows.map((row) => {
        const isSelected = pickedPlaceId === row.key;
        return (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            onPress={row.onPress}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.sm,
              paddingHorizontal: theme.spacing.sm,
              borderRadius: theme.radius.sm,
              backgroundColor: pressed
                ? theme.colors.surfaceMuted
                : isSelected
                  ? theme.colors.primarySoft
                  : 'transparent',
            })}
          >
            <Ionicons
              name={row.key === 'current' ? 'locate-outline' : 'location-outline'}
              size={16}
              color={theme.colors.textBrand}
            />
            <View style={{ flex: 1 }}>
              <Text variant="body" numberOfLines={1}>
                {row.primary}
              </Text>
              {row.secondary ? (
                <Text variant="caption" tone="muted" numberOfLines={1}>
                  {row.secondary}
                </Text>
              ) : null}
            </View>
            {isSelected ? (
              <Ionicons name="checkmark-circle" size={18} color={theme.colors.textBrand} />
            ) : null}
          </Pressable>
        );
      })}

      {statusLine ? (
        <Text variant="caption" tone={outcome?.failed || selectionError ? 'warning' : 'muted'}>
          {statusLine}
        </Text>
      ) : null}

      <Button
        label="Manage saved places"
        onPress={onOpenSavedPlaces}
        appearance="ghost"
        size="sm"
      />
    </View>
  );
}
