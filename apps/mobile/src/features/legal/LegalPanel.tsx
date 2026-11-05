import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Text, useTheme } from '@drivx/ui';
import { legalDocumentsFor, type LegalRole } from './documents';

/**
 * The role's own Terms and Conditions and Privacy Policy, opened from Account.
 *
 * The owner asked for these separate per role on 2026-10-27 — "terms and
 * condition privacy policy customer ke liye alag driver ke liye alag" — because
 * the two parties are promised different things: a customer is told how a fare
 * is built and what their driver can see, a driver is told how commission is
 * taken and which of their documents leaves the account. One document covering
 * both would have to be vague about at least one of them.
 *
 * The wording lives in `documents.ts`, next to the code it describes, and every
 * clause there is checked against behaviour that has been run. Nothing expands
 * while it is unread, so the choice of document is explicit rather than a wall
 * of small print.
 */
export function LegalPanel({ role }: { role: LegalRole }) {
  const theme = useTheme();
  const docs = legalDocumentsFor(role);
  const [open, setOpen] = useState<'terms' | 'privacy' | null>(null);
  const document = open === null ? null : docs[open];

  return (
    <Card style={{ gap: theme.spacing.md }}>
      <View style={{ gap: theme.spacing.xxs }}>
        <Text variant="subheading" tone="brand">
          Terms and privacy
        </Text>
        <Text variant="caption" tone="muted">
          {role === 'driver'
            ? 'For drivers. Written from how DrivX actually works, including the money it holds and what a customer is shown of you.'
            : 'For customers. Written from how DrivX actually works, including how your bill is built and what your driver is shown.'}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        <Button
          label="Terms and Conditions"
          size="sm"
          appearance="secondary"
          selected={open === 'terms'}
          onPress={() => setOpen(open === 'terms' ? null : 'terms')}
        />
        <Button
          label="Privacy Policy"
          size="sm"
          appearance="secondary"
          selected={open === 'privacy'}
          onPress={() => setOpen(open === 'privacy' ? null : 'privacy')}
        />
      </View>

      {document ? (
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="caption" tone="faint">
            {document.updatedNote}
          </Text>
          {document.sections.map((section) => (
            <View key={section.heading} style={{ gap: theme.spacing.xxs }}>
              <Text variant="label" tone="brand">
                {section.heading}
              </Text>
              {section.lines.map((line, index) => (
                <Text key={`${section.heading}-${index}`} variant="caption">
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
