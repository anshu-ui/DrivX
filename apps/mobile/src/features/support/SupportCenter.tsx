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
import { CUSTOMER_CARE_CONTACTS, SUPPORT_CATEGORIES, type SupportCategory } from '@drivx/domain';
import { useMyTickets, useTicketMessages, type TicketView } from '../customer/queries';
import { useCreateTicket, useReplyTicket } from '../customer/mutations';
import { SUPPORT_CATEGORY_LABEL, dateTime } from '../customer/labels';
import { useSession } from '../auth/AuthProvider';
import type { LegalRole } from '../legal/documents';

const TICKET_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = {
  open: 'warning', in_progress: 'info', awaiting_customer: 'warning', resolved: 'success', closed: 'neutral',
};

function TicketConversation({ ticket, role, expanded, onToggle }: {
  ticket: TicketView;
  role: LegalRole;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const { user } = useSession();
  const ticketRole = role === 'driver' ? 'driver' : 'customer';
  const messages = useTicketMessages(expanded ? ticket.id : null, ticketRole);
  const reply = useReplyTicket(role);
  const [draft, setDraft] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  function sendReply() {
    setFeedback(null);
    reply.mutate({ id: ticket.id, body: draft }, {
      onSuccess: () => setDraft(''),
      onError: (error) => setFeedback(error instanceof Error ? error.message : 'Could not send your reply.'),
    });
  }

  return (
    <Card tone="flat" style={{ gap: theme.spacing.xs }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: theme.spacing.md }}>
        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
          <Text variant="heading" tone="brand">{ticket.subject}</Text>
          <Text variant="caption" tone="faint">
            {SUPPORT_CATEGORY_LABEL[ticket.category as SupportCategory] ?? ticket.category ?? 'Support'} · {dateTime(ticket.createdAtMs)}
          </Text>
        </View>
        <StatusPill label={ticket.status.replace(/_/g, ' ')} tone={TICKET_TONE[ticket.status] ?? 'neutral'} />
      </View>
      <Text variant="caption">{ticket.body}</Text>
      <Text variant="caption" tone="faint">
            Ticket {ticket.id}{ticket.bookingReference ? ` · Booking ${ticket.bookingReference}` : ticket.bookingId ? ` · Booking ${ticket.bookingId}` : ''}
      </Text>
      {ticket.resolution ? <Text variant="caption" tone="success">Resolution: {ticket.resolution}</Text> : null}
      <Button
        label={expanded ? 'Hide conversation' : 'View conversation'}
        appearance="ghost"
        size="sm"
        onPress={onToggle}
      />
      {expanded ? (
        <View style={{ gap: theme.spacing.sm, borderTopWidth: theme.borderWidth.hairline, borderTopColor: theme.colors.border, paddingTop: theme.spacing.sm }}>
          {messages.isPending ? <Text variant="caption" tone="muted">Loading replies…</Text> : null}
          {messages.isError ? <Text variant="caption" tone="danger">Could not load the ticket conversation.</Text> : null}
          {(messages.data ?? []).map((message) => (
            <View key={message.id} style={{ alignSelf: message.authorUid === user?.uid ? 'flex-end' : 'flex-start', maxWidth: '92%', borderRadius: theme.radius.md, backgroundColor: message.authorUid === user?.uid ? theme.colors.primarySoft : theme.colors.surfaceMuted, padding: theme.spacing.sm, gap: 3 }}>
              <Text variant="overline" tone={message.authorUid === user?.uid ? 'primary' : 'muted'}>
                {message.authorUid === user?.uid ? 'You' : message.authorRole === 'admin' || message.authorRole === 'ops' ? 'DrivX support' : message.authorRole === 'driver' ? 'Driver' : 'Customer'}
                {message.createdAtMs ? ` · ${dateTime(message.createdAtMs)}` : ''}
              </Text>
              <Text variant="caption">{message.body}</Text>
            </View>
          ))}
          {ticket.status !== 'closed' && ticket.status !== 'resolved' ? (
            <>
              <Field label="Reply to support" value={draft} onChangeText={setDraft} multiline />
              <Button label="Send reply" size="sm" loading={reply.isPending} disabled={draft.trim().length < 2} onPress={sendReply} />
            </>
          ) : <Text variant="caption" tone="muted">This ticket is closed. Open a new ticket if you still need help.</Text>}
          {feedback ? <Text variant="caption" tone="danger">{feedback}</Text> : null}
        </View>
      ) : null}
    </Card>
  );
}

export function SupportCenter({ role }: { role: LegalRole }) {
  const theme = useTheme();
  const ticketRole = role === 'driver' ? 'driver' : 'customer';
  const tickets = useMyTickets(ticketRole);
  const create = useCreateTicket(ticketRole);
  const [category, setCategory] = useState<SupportCategory>('trip_issue');
  const [body, setBody] = useState('');
  const [bookingReference, setBookingReference] = useState('');
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
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
        ['How do I contact support?', 'Open a ticket here with your booking reference and a short description. Do not include OTPs, passwords or payment card details.'],
      ];

  function submitTicket() {
    setFeedback(null);
    create.mutate({ subject: SUPPORT_CATEGORY_LABEL[category], body: body.trim(), category, bookingId: bookingReference.trim() || null }, {
      onSuccess: () => { setBody(''); setBookingReference(''); },
      onError: (error) => setFeedback(error instanceof Error ? error.message : 'Could not open that ticket.'),
    });
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader title="Support" subtitle="Contact DrivX or follow your ticket replies here." />

        <Card tone="flat" style={{ gap: theme.spacing.sm }}>
          <Text variant="overline" tone="muted">DRIVX SUPPORT · {ticketRole.toUpperCase()} ACCOUNT</Text>
          <Text variant="heading" tone="brand">Need a hand?</Text>
          <Text variant="caption" tone="muted">Call or email us, or send a quick message. Replies stay in this {ticketRole} account.</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {CUSTOMER_CARE_CONTACTS.phones.map((phone) => (
              <Pressable key={phone.e164} accessibilityRole="link" accessibilityLabel={`Call DrivX support at ${phone.label}`} onPress={() => void Linking.openURL(`tel:${phone.e164}`).catch(() => setFeedback(`Could not open your phone app. Call ${phone.label}.`))} style={{ minHeight: 48, minWidth: 150, flexGrow: 1, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, borderWidth: theme.borderWidth.hairline, borderColor: theme.colors.border }}>
                <Text variant="bodyStrong" tone="brand">Call {phone.label} ↗</Text>
              </Pressable>
            ))}
          </View>
          <Pressable accessibilityRole="link" accessibilityLabel={`Email DrivX support at ${CUSTOMER_CARE_CONTACTS.email}`} onPress={() => void Linking.openURL(`mailto:${CUSTOMER_CARE_CONTACTS.email}`).catch(() => setFeedback(`Could not open your email app. Write to ${CUSTOMER_CARE_CONTACTS.email}.`))} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.spacing.md, borderRadius: theme.radius.md, backgroundColor: theme.colors.surface, borderWidth: theme.borderWidth.hairline, borderColor: theme.colors.border }}>
            <Text variant="bodyStrong" tone="brand">{CUSTOMER_CARE_CONTACTS.email} ↗</Text>
          </Pressable>
        </Card>

        <Card style={{ gap: theme.spacing.sm }}>
          <Text variant="subheading" tone="brand">Send a quick support request</Text>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" tone="brand">Choose a topic</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {SUPPORT_CATEGORIES.map((option) => <Button key={option} label={SUPPORT_CATEGORY_LABEL[option]} size="sm" appearance="secondary" selected={category === option} onPress={() => setCategory(option)} />)}
            </View>
          </View>
          <Field label="Booking reference (optional)" value={bookingReference} onChangeText={setBookingReference} autoCapitalize="characters" autoCorrect={false} />
          <Field label="Tell us what happened" value={body} onChangeText={setBody} multiline helper="Never include an OTP, password or card details." />
          <Button label="Send to DrivX support" onPress={submitTicket} loading={create.isPending} fullWidth disabled={body.trim().length < 2} />
        </Card>

        <Card tone="flat" style={{ gap: theme.spacing.xs }}>
          <Text variant="subheading" tone="brand">Frequently asked questions</Text>
          {faq.map(([question, answer], index) => (
            <View key={question} style={{ borderTopWidth: theme.borderWidth.hairline, borderTopColor: theme.colors.border }}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: openFaq === index }} onPress={() => setOpenFaq(openFaq === index ? null : index)} style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
                <Text variant="bodyStrong" tone="default" style={{ flex: 1 }}>{question}</Text>
                <Text variant="bodyStrong" tone="brand">{openFaq === index ? '−' : '+'}</Text>
              </Pressable>
              {openFaq === index ? <Text variant="caption" tone="muted" style={{ paddingBottom: theme.spacing.sm }}>{answer}</Text> : null}
            </View>
          ))}
        </Card>

        {tickets.isError ? <StateView kind="permission_denied" title="Could not read your tickets" message={tickets.error instanceof Error ? tickets.error.message : 'Firestore refused.'} /> : null}
        {(tickets.data ?? []).length > 0 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Text variant="subheading" tone="brand">Your tickets</Text>
            {tickets.data!.map((ticket) => <TicketConversation key={ticket.id} ticket={ticket} role={role} expanded={expandedTicket === ticket.id} onToggle={() => setExpandedTicket(expandedTicket === ticket.id ? null : ticket.id)} />)}
          </View>
        ) : (!tickets.isPending ? <StateView kind="empty" title="No tickets" message="Nothing needs our attention yet." /> : null)}

        {feedback ? <Text variant="caption" tone="danger" accessibilityRole="alert">{feedback}</Text> : null}
      </View>
    </Screen>
  );
}
