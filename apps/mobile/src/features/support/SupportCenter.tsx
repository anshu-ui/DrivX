import { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import {
  Button,
  Card,
  Field,
  Screen,
  ScreenHeader,
  StateView,
  StatusPill,
  Text,
  useTheme,
} from '@drivx/ui';
import { SUPPORT_CATEGORIES, type SupportCategory } from '@drivx/domain';
import { useMyTickets } from '../customer/queries';
import { useCreateTicket, useReplyTicket } from '../customer/mutations';
import { SUPPORT_CATEGORY_LABEL, dateTime } from '../customer/labels';
import type { LegalRole } from '../legal/documents';

const TICKET_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = {
  open: 'warning',
  in_progress: 'info',
  awaiting_customer: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

const SUPPORT_EMAIL = 'customersupport@drivx.in';
const SUPPORT_PHONES = [
  { label: '87085 06508', uri: 'tel:+918708506508' },
  { label: '98130 51505', uri: 'tel:+919813051505' },
];

/**
 * The ticket desk, shared by both apps.
 *
 * One component rather than two screens because the rules behind it are
 * role-blind: `supportTickets` refuses a create whose `openedByUid` is not the
 * caller and whose `status` is not `open`, so whoever signs in may open a ticket
 * about their own trips and nothing else. What differs is only the closing
 * sentence, which says who writes the outcome.
 */
export function SupportCenter({ role }: { role: LegalRole }) {
  const theme = useTheme();
  const tickets = useMyTickets();
  const create = useCreateTicket();
  const reply = useReplyTicket();

  const [category, setCategory] = useState<SupportCategory>('trip_issue');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const faq = role === 'driver'
    ? [
        ['What happens after I upload my documents?', 'Pay the one-time onboarding fee shown in your account through Cashfree and upload your photo, photo ID and driving licence. Admin reviews the documents; your driver ID and booking access activate only after approval.'],
        ['When does my application reach Admin?', 'After all required documents are uploaded and the onboarding payment shown in your account is confirmed by Cashfree, your application appears in the live Admin review queue.'],
        ['How do trip charges work?', 'The app shows the booking fare and your configured commission before the trip. After a completed trip, the server calculates your commission and adds it to Clear dues.'],
        ['How can I get help with an upload or payment?', 'Open a support ticket here and include the document type or Cashfree order reference. Never send an OTP, password or card details.'],
      ]
    : [
        ['How is the fare estimated?', 'DrivX uses the selected service, route distance or hourly package, and a one-time night charge when the scheduled pickup or map-estimated trip overlaps the configured night window. The estimate is shown before you confirm.'],
        ['How do I pay for a trip?', 'Trip fare is paid directly to the driver in cash at the end of the trip. The current Cashfree checkout is only for driver onboarding and driver dues.'],
        ['Can the final fare change?', 'For a metered trip, the server uses the trip odometer reading and the agreed quote snapshot to calculate eligible extra distance or time. The receipt shows the calculation.'],
        ['How do I contact support?', 'Open a ticket here with your booking number and a short description. Do not include OTPs, passwords or payment card details.'],
      ];

  const submitTicket = () => {
    setFeedback(null);
    create.mutate(
      { subject: subject.trim(), body: body.trim(), category },
      {
        onSuccess: () => {
          setSubject('');
          setBody('');
        },
        onError: (error) =>
          setFeedback(error instanceof Error ? error.message : 'Could not open that ticket.'),
      },
    );
  };

  const submitReply = (id: string) => {
    setFeedback(null);
    reply.mutate(
      { id, body: replyBody },
      {
        onSuccess: () => {
          setReplyTo(null);
          setReplyBody('');
        },
        onError: (error) =>
          setFeedback(error instanceof Error ? error.message : 'Could not add that reply.'),
      },
    );
  };

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          title="Support"
          subtitle="Talk to the DrivX team or send a message about your trip."
        />

        <Card tone="flat" style={{ gap: theme.spacing.sm }}>
          <Text variant="overline" tone="muted">DRIVX CUSTOMER CARE</Text>
          <Text variant="heading" tone="brand">We’re here to help</Text>
          <Text variant="caption" tone="muted">
            Call either support number, email us, or send a ticket below and follow the reply here.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {SUPPORT_PHONES.map((phone) => (
              <Pressable
                key={phone.uri}
                accessibilityRole="link"
                accessibilityLabel={`Call DrivX support at ${phone.label}`}
                onPress={() => {
                  setFeedback(null);
                  void Linking.openURL(phone.uri).catch(() =>
                    setFeedback(`Could not open your phone app. Call ${phone.label}.`),
                  );
                }}
                style={{
                  minHeight: 48,
                  minWidth: 150,
                  flexGrow: 1,
                  justifyContent: 'center',
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radius.md,
                  backgroundColor: theme.colors.surface,
                  borderWidth: theme.borderWidth.hairline,
                  borderColor: theme.colors.border,
                }}
              >
                <Text variant="bodyStrong" tone="brand">Call {phone.label}  ↗</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Email DrivX support at ${SUPPORT_EMAIL}`}
            onPress={() => {
              setFeedback(null);
              void Linking.openURL(`mailto:${SUPPORT_EMAIL}`).catch(() =>
                setFeedback(`Could not open your email app. Write to ${SUPPORT_EMAIL}.`),
              );
            }}
            style={{
              minHeight: 48,
              justifyContent: 'center',
              paddingHorizontal: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surface,
              borderWidth: theme.borderWidth.hairline,
              borderColor: theme.colors.border,
            }}
          >
            <Text variant="bodyStrong" tone="brand">{SUPPORT_EMAIL}  ↗</Text>
          </Pressable>
        </Card>

        <Card tone="flat" style={{ gap: theme.spacing.xs }}>
          <Text variant="subheading" tone="brand">Frequently asked questions</Text>
          {faq.map(([question, answer], index) => (
            <View key={question} style={{ borderTopWidth: theme.borderWidth.hairline, borderTopColor: theme.colors.border }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: openFaq === index }}
                onPress={() => setOpenFaq(openFaq === index ? null : index)}
                style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}
              >
                <Text variant="bodyStrong" tone="default" style={{ flex: 1 }}>{question}</Text>
                <Text variant="bodyStrong" tone="brand">{openFaq === index ? '−' : '+'}</Text>
              </Pressable>
              {openFaq === index ? <Text variant="caption" tone="muted" style={{ paddingBottom: theme.spacing.sm }}>{answer}</Text> : null}
            </View>
          ))}
        </Card>

        {tickets.isError ? (
          <StateView
            kind="permission_denied"
            title="Could not read your tickets"
            message={tickets.error instanceof Error ? tickets.error.message : 'Firestore refused.'}
          />
        ) : null}

        {(tickets.data ?? []).length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            {tickets.data!.map((ticket) => (
              <Card key={ticket.id} tone="flat" style={{ gap: theme.spacing.xs }}>
                <View
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: theme.spacing.md,
                  }}
                >
                  <Text variant="heading" tone="brand">
                    {ticket.subject}
                  </Text>
                  <StatusPill
                    label={ticket.status.replace(/_/g, ' ')}
                    tone={TICKET_TONE[ticket.status] ?? 'neutral'}
                  />
                </View>
                <Text variant="caption" tone="faint">
                  {SUPPORT_CATEGORY_LABEL[ticket.category as SupportCategory] ?? ticket.category} ·{' '}
                  {dateTime(ticket.createdAtMs)}
                </Text>
                <Text variant="caption">{ticket.body}</Text>
                {ticket.resolution ? (
                  <Text variant="caption" tone="success">
                    Resolution: {ticket.resolution}
                  </Text>
                ) : null}

                {ticket.status !== 'closed' && ticket.status !== 'resolved' ? (
                  replyTo === ticket.id ? (
                    <View style={{ gap: theme.spacing.sm }}>
                      <Field
                        label="Your reply"
                        value={replyBody}
                        onChangeText={setReplyBody}
                        multiline
                        accessibilityLabel="Reply text"
                      />
                      <Button
                        label="Send reply"
                        size="sm"
                        loading={reply.isPending}
                        onPress={() => submitReply(ticket.id)}
                      />
                    </View>
                  ) : (
                    <Button
                      label="Add a reply"
                      size="sm"
                      appearance="ghost"
                      onPress={() => {
                        setReplyTo(ticket.id);
                        setReplyBody('');
                      }}
                    />
                  )
                ) : null}
              </Card>
            ))}
          </View>
        ) : (
          !tickets.isPending && (
            <StateView kind="empty" title="No tickets" message="Nothing needs our attention yet." />
          )
        )}

        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading" tone="brand">
            Send us a message
          </Text>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" tone="brand">
              Category
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {SUPPORT_CATEGORIES.map((option) => (
                <Button
                  key={option}
                  label={SUPPORT_CATEGORY_LABEL[option]}
                  size="sm"
                  appearance="secondary"
                  selected={category === option}
                  onPress={() => setCategory(option)}
                />
              ))}
            </View>
          </View>
          <Field
            label="Subject"
            value={subject}
            onChangeText={setSubject}
            accessibilityLabel="Subject"
          />
          <Field
            label="What happened"
            value={body}
            onChangeText={setBody}
            multiline
            helper="Ten characters at least. Do not include card details or passwords."
            accessibilityLabel="Description"
          />
          <Button
            label="Send to the support team"
            onPress={submitTicket}
            loading={create.isPending}
            fullWidth
          />
          <Text variant="caption" tone="faint">
            {role === 'driver'
              ? 'Tickets open at normal priority with no case owner. Assignment, escalation and the resolution are written by staff — you can add replies and read the outcome, and the rules refuse a driver changing a status or a due from here.'
              : 'Tickets open at normal priority with no case owner. Assignment, escalation and resolution are written by staff, and the rules refuse a customer changing them.'}
          </Text>
        </Card>

        {feedback ? (
          <Text variant="caption" tone="danger" accessibilityRole="alert">
            {feedback}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
