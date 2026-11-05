import { useState } from 'react';
import { View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { Button, Card, Field, Screen, ScreenHeader, StateView, StatusPill, Text, useTheme } from '@drivx/ui';
import type { DocumentType } from '@drivx/domain';
import { DOCUMENT_LABELS, formatINR } from '@drivx/domain';
import { useSession } from '../../features/auth/AuthProvider';
import { useDriverDues, type DriverDueRow } from '../../features/driver/profile';
import { payDriverDue } from '../../features/driver/payments';
import { submitDriverApplication } from '../../features/driver/onboarding';
import { useDriverProfile } from '../../features/driver/profile';
import {
  ownDocumentUrl,
  useDriverDocuments,
  useUploadDriverDocument,
  type DriverDocumentView,
} from '../../features/driver/documents';

/**
 * The paperwork step that stands between a signed-up driver and their first
 * trip. Every row here is a real file in private storage plus a real metadata
 * document; nothing is marked uploaded until both writes come back.
 */
const CHECKLIST: {
  type: DocumentType;
  label: string;
  note: string;
  /** Photographs have no number to read off; the rest do. */
  asksNumber: boolean;
}[] = [
  {
    type: 'driver_photograph',
    label: DOCUMENT_LABELS.driver_photograph,
    note: 'A clear front-facing photo. This is the face the customer is shown when you are assigned to them.',
    asksNumber: false,
  },
  {
    type: 'photo_id',
    label: DOCUMENT_LABELS.photo_id,
    note: 'Front of the card, number readable. Only the last four digits are kept.',
    asksNumber: true,
  },
  {
    type: 'driving_licence',
    label: DOCUMENT_LABELS.driving_licence,
    note: 'Commercial endorsement if issued after 2019.',
    asksNumber: true,
  },
];

const STATUS_COPY: Record<DriverDocumentView['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  not_uploaded: { label: 'not uploaded', tone: 'neutral' },
  pending_review: { label: 'with the office', tone: 'warning' },
  approved: { label: 'approved', tone: 'success' },
  rejected: { label: 'rejected', tone: 'danger' },
  expired: { label: 'expired', tone: 'danger' },
  not_started: { label: 'not started', tone: 'neutral' },
  expiring_soon: { label: 'expiring soon', tone: 'warning' },
};

/**
 * What the platform charges this driver, row by row. Onboarding uses Cashfree;
 * the ledger changes only after the gateway webhook confirms payment.
 *
 * The amounts come from the driver's own `dues` rows rather than being computed
 * here, so the number on screen is the number on the record.
 */
function DuesCard({ documentsReady, missingDocuments, profile }: {
  documentsReady: boolean;
  missingDocuments: string[];
  profile: ReturnType<typeof useDriverProfile>['profile'];
}) {
  const theme = useTheme();
  const dues = useDriverDues();
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const onboardingDue = dues.rows.find((row) => row.id === 'onboarding_fee' && row.status !== 'paid');

  async function payOnboarding() {
    const due = onboardingDue;
    if (!due || paying) return;
    setPaying(true);
    setPaymentMessage(null);
    const result = await payDriverDue(due.id);
    setPaying(false);
    setPaymentMessage(result.ok
      ? 'Cashfree checkout opened. After payment is confirmed, Submit now will appear here.'
      : result.message);
  }

  async function submitNow() {
    if (submitting) return;
    setSubmitting(true);
    const message = await submitDriverApplication();
    setSubmitting(false);
    setPaymentMessage(message);
  }

  if (dues.loading) {
    return (
      <Card tone="flat">
        <Text variant="caption" tone="muted">
          Checking your dues…
        </Text>
      </Card>
    );
  }

  if (dues.unreadable) {
    return (
      <Card tone="flat">
        <Text variant="bodyStrong" tone="default">
          Your dues
        </Text>
        <Text variant="caption" tone="muted">
          The ledger could not be read right now. Reopen this screen; if it stays unread, ask the
          office what stands against your name rather than assuming it is clear.
        </Text>
      </Card>
    );
  }

  if (dues.rows.length === 0) {
    return (
      <Card tone="flat">
        <Text variant="bodyStrong" tone="default">
          Your dues
        </Text>
        <Text variant="caption" tone="muted">
          Nothing is raised on your account yet. The onboarding fee appears here the moment your first
          document is filed, and a commission row appears for each trip you complete.
        </Text>
      </Card>
    );
  }

  return (
    <Card tone="flat" style={{ gap: theme.spacing.sm }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.spacing.md,
        }}
      >
        <Text variant="bodyStrong" tone="default">
          Your dues
        </Text>
        {dues.outstandingPaise > 0 ? (
          <StatusPill label={`to pay ${formatINR(dues.outstandingPaise)}`} tone="warning" />
        ) : (
          <StatusPill label="all cleared" tone="success" />
        )}
      </View>

      {dues.rows.map((row) => (
        <DueRow key={row.id} row={row} />
      ))}

      <Text variant="caption" tone="muted">
        {dues.outstandingPaise > 0
          ? documentsReady
            ? 'Upload all three documents, then pay the one-time onboarding fee through Cashfree.'
            : `Upload your photo, photo ID and driving licence first. The one-time ${formatINR(onboardingDue?.totalPaise ?? 52_500)} Cashfree payment unlocks after all three uploads are saved.`
          : profile?.verificationStatus === 'pending_review' && profile.applicationSubmittedAtMs !== null
            ? 'Your application is with Admin for verification. You can start receiving bookings after approval.'
            : profile?.verificationStatus === 'approved'
              ? 'Your driver profile is approved.'
              : documentsReady
                ? 'Payment is confirmed. Tap Submit now to send your documents to Admin for verification.'
                : 'Your onboarding fee is paid. Upload all three documents, then submit them for Admin verification.'}
      </Text>
      {dues.rows.some((row) => row.id === 'onboarding_fee' && row.status !== 'paid') ? (
        <Button
          label={paying ? 'Opening Cashfree…' : documentsReady && onboardingDue ? `Pay ${formatINR(onboardingDue.totalPaise)}` : 'Upload all 3 documents first'}
          onPress={() => void payOnboarding()}
          disabled={paying || !documentsReady}
          accessibilityLabel={onboardingDue ? `Pay the one-time onboarding fee of ${formatINR(onboardingDue.totalPaise)} with Cashfree` : 'Pay onboarding fee with Cashfree'}
        />
      ) : null}
      {dues.rows.some((row) => row.id === 'onboarding_fee' && row.status === 'paid') &&
      profile && profile.applicationSubmittedAtMs === null && profile.verificationStatus !== 'approved' ? (
        <>
          {!documentsReady ? (
            <Text variant="caption" tone="warning">
              To submit, finish these documents first: {missingDocuments.join(', ') || 'check each upload status'}.
            </Text>
          ) : null}
          <Button
            label={submitting ? 'Submitting…' : documentsReady ? 'Submit now' : 'Upload all 3 documents first'}
            onPress={() => void submitNow()}
            disabled={submitting || !documentsReady}
          />
        </>
      ) : null}
      {paymentMessage ? <Text variant="caption" tone="muted">{paymentMessage}</Text> : null}
    </Card>
  );
}

function DueRow({ row }: { row: DriverDueRow }) {
  const theme = useTheme();
  const paid = row.status === 'paid';
  return (
    <View
      style={{
        borderTopWidth: theme.borderWidth.hairline,
        borderTopColor: theme.colors.border,
        paddingTop: theme.spacing.sm,
        gap: theme.spacing.xs,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: theme.spacing.md,
        }}
      >
        <Text variant="bodyStrong" tone="default">
          {row.title}
        </Text>
        <StatusPill label={paid ? 'paid' : 'to pay'} tone={paid ? 'success' : 'warning'} />
      </View>

      <Text variant="caption" tone="muted">
        {row.kind === 'commission'
          ? `Trip commission${
              row.rate === null ? '' : ` · ${Math.round(row.rate * 100)}% of the fare`
            }${row.bookingId ? ` · booking ${row.bookingId}` : ''}`
          : 'Charged once, when you first file your papers'}
      </Text>

      <View style={{ gap: theme.spacing.xs }}>
        <FeeLine
          label={
            row.kind === 'commission'
              ? row.rate === null
                ? 'Commission'
                : `Commission (${Math.round(row.rate * 100)}%)`
              : 'Onboarding fee'
          }
          value={formatINR(row.basePaise)}
        />
        <FeeLine label={`tax (${Math.round(row.gstRate * 100)}%)`} value={formatINR(row.gstPaise)} />
        <FeeLine label="Total" value={formatINR(row.totalPaise)} strong />
      </View>

      {paid ? (
        <Text variant="caption" tone="muted">
          Collected{row.method ? ` as ${row.method === 'upi' ? 'UPI' : 'cash'}` : ''} by the office.
          You do not owe this again.
        </Text>
      ) : null}
    </View>
  );
}
function FeeLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
      <Text variant={strong ? 'bodyStrong' : 'caption'} tone={strong ? 'default' : 'muted'}>
        {label}
      </Text>
      <Text variant={strong ? 'bodyStrong' : 'caption'} tone="default">
        {value}
      </Text>
    </View>
  );
}

export default function DriverDocuments() {
  const theme = useTheme();
  const { user } = useSession();
  const documents = useDriverDocuments();
  const { profile } = useDriverProfile();
  const upload = useUploadDriverDocument();
  const [openType, setOpenType] = useState<DocumentType | null>(null);
  const [numbers, setNumbers] = useState<Partial<Record<DocumentType, string>>>({});
  const [error, setError] = useState<string | null>(null);

  const rows = new Map((documents.data ?? []).map((row) => [row.type, row]));
  const documentsReady = CHECKLIST.every((item) => {
    const row = rows.get(item.type);
    return row?.hasFile === true && row.status === 'pending_review';
  });
  const missingDocuments = CHECKLIST
    .filter((item) => {
      const row = rows.get(item.type);
      return row?.hasFile !== true || row.status !== 'pending_review';
    })
    .map((item) => item.label);

  async function pick(item: (typeof CHECKLIST)[number], from: 'library' | 'camera') {
    setError(null);
    const permission =
      from === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError(
        from === 'camera'
          ? 'Camera access was refused. Allow it in settings, or upload a photo from the gallery.'
          : 'Photo access was refused. Allow it in settings to upload a document.',
      );
      return;
    }

    const picked =
      from === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 0.7, allowsEditing: false })
        : await ImagePicker.launchImageLibraryAsync({ quality: 0.7, allowsEditing: false });
    if (picked.canceled || picked.assets.length === 0) return;

    const [asset] = picked.assets;
    if (!asset) return;
    try {
      await upload.mutateAsync({
        type: item.type,
        asset: {
          uri: asset.uri,
          fileName: asset.fileName ?? item.type,
          mimeType: asset.mimeType ?? 'image/jpeg',
        },
        number: item.asksNumber ? (numbers[item.type] ?? null) : null,
      });
      setOpenType(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The upload did not go through. Try again.');
    }
  }

  async function viewUpload(type: DocumentType) {
    if (!user?.uid) return;
    setError(null);
    try {
      const url = await ownDocumentUrl(user.uid, type);
      // The web build can open the object directly; a phone hands the URL to
      // whatever can render it. Either way it is the driver's own file.
      const { Linking, Platform } = await import('react-native');
      if (Platform.OS === 'web') {
        window.open(url, '_blank', 'noopener');
      } else {
        await Linking.openURL(url);
      }
    } catch {
      setError('That upload could not be opened. Re-upload the photo if it is unreadable.');
    }
  }

  if (documents.isPending) {
    return (
      <Screen>
        <StateView kind="loading" message="Opening your checklist…" />
      </Screen>
    );
  }

  if (documents.isError) {
    return (
      <Screen>
        <StateView
          kind="error"
          title="Could not read your documents"
          message="Sign out and in again, then retry. Nothing was lost."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: theme.spacing.lg }}>
        <ScreenHeader
          title="Document checklist"
          subtitle="Upload each document so our team can verify your account. You stay offline for trips until it is approved."
        />

        <Card tone="flat" style={{ gap: theme.spacing.xs }}>
          <Text variant="bodyStrong" tone="default">Before you submit</Text>
          <Text variant="caption" tone="muted">
          Upload all three documents, then pay the one-time fee shown above (₹500 + 5% GST = ₹525 by default). After payment is confirmed, tap Submit now to send your application to Admin. Bookings start only after approval.
          </Text>
        </Card>

        {error ? (
          <Card tone="flat" style={{ gap: theme.spacing.xs }}>
            <Text variant="bodyStrong" tone="danger">
              {error}
            </Text>
          </Card>
        ) : null}

        <DuesCard documentsReady={documentsReady} missingDocuments={missingDocuments} profile={profile} />

        {CHECKLIST.map((item) => {
          const row = rows.get(item.type);
          const status = row?.status ?? 'not_uploaded';
          const pill = STATUS_COPY[status];
          const isOpen = openType === item.type;
          const approved = status === 'approved';

          return (
            <Card key={item.type} tone="flat" style={{ gap: theme.spacing.sm }}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                }}
              >
                <Text variant="bodyStrong" tone="default">
                  {item.label}
                </Text>
                <StatusPill label={pill.label} tone={pill.tone} />
              </View>
              <Text variant="caption" tone="muted">
                {item.note}
              </Text>

              {status === 'rejected' && row?.rejectionNote ? (
                <Text variant="caption" tone="danger">
                  The office sent this back: {row.rejectionNote}
                </Text>
              ) : null}

              {approved ? (
                <Button
                  label="Approved — contact the office to replace it"
                  appearance="secondary"
                  size="sm"
                  onPress={() => void viewUpload(item.type)}
                  iconLeft={<Ionicons name="checkmark-circle-outline" size={16} color={theme.colors.textBrand} />}
                />
              ) : (
                <>
                  {isOpen && item.asksNumber ? (
                    <Field
                      label="Document number"
                      value={numbers[item.type] ?? ''}
                      onChangeText={(value) => setNumbers((current) => ({ ...current, [item.type]: value }))}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      helper="Stored as its last four characters only."
                    />
                  ) : null}

                  <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
                    {row?.hasFile ? (
                      <Button
                        label="View"
                        appearance="secondary"
                        size="sm"
                        onPress={() => void viewUpload(item.type)}
                      />
                    ) : null}
                    <Button
                      label={isOpen ? 'Cancel' : status === 'rejected' ? 'Upload again' : 'Upload'}
                      appearance={isOpen ? 'secondary' : 'primary'}
                      size="sm"
                      onPress={() => setOpenType(isOpen ? null : item.type)}
                    />
                    {isOpen ? (
                      <>
                        <Button
                          label="From gallery"
                          size="sm"
                          loading={upload.isPending}
                          onPress={() => void pick(item, 'library')}
                        />
                        <Button
                          label="Take a photo"
                          appearance="secondary"
                          size="sm"
                          onPress={() => void pick(item, 'camera')}
                        />
                      </>
                    ) : null}
                  </View>
                </>
              )}
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}
