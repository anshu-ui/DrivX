import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Button, Card, StateView, StatusPill, Text, useTheme } from '@drivx/ui';
import { formatINR } from '@drivx/domain';
import { useDriverDocuments } from '../features/driver/documents';
import {
  describeOutstandingFee,
  useDriverAccess,
  useDriverDues,
  useDriverProfile,
} from '../features/driver/profile';
import { payDriverDue } from '../features/driver/payments';

/**
 * Wraps every driver screen a trip would need.
 *
 * A signed-up driver is not yet a driver the public should be carried by: the
 * owner reads the licence, the ID and the photograph by hand, and the one-time
 * onboarding fee has to be recorded as collected before that approval can even
 * be saved. Until both are done, the duty, earnings and trip surfaces stay
 * closed here — not hidden from the tab bar, which would leave a tappable tab
 * that renders nothing — and the checklist stays reachable so the file can still
 * be sent.
 */
export function RequireApproval({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const access = useDriverAccess();
  const dues = useDriverDues();
  const documents = useDriverDocuments();
  const profile = useDriverProfile();
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  if (access.loading) {
    return <StateView kind="loading" message="Checking your account…" />;
  }
  if (access.status === 'approved') return <>{children}</>;

  // The fee is the part of the wait a driver can act on, so it is named in the
  // same breath as the paperwork rather than left for them to discover.
  const feeNote =
    dues.outstandingPaise > 0 ? ` ${describeOutstandingFee(dues)}` : '';
  const onboardingDue = dues.rows.find((row) => row.kind === 'onboarding_fee') ?? null;
  const unpaidDue = dues.rows.find((row) => row.status === 'unpaid') ?? null;
  const filedCount = documents.data?.filter((document) => document.status !== 'not_uploaded').length ?? 0;

  const copy =
    access.status === 'pending_review'
      ? {
          title: 'Your papers are with the office',
          message:
            'The owner checks every licence and ID by hand. Duty opens as soon as that is saved — you do not need to sign in again.' +
            feeNote,
        }
      : access.status === 'rejected'
        ? {
            title: 'The office sent your documents back',
            message: access.rejectionReason
              ? `${access.rejectionReason} Upload the corrected document from the checklist.${feeNote}`
              : `Upload a corrected document from the checklist and it will be reviewed again.${feeNote}`,
          }
        : {
            title: 'Duty is closed until your documents are verified',
            message: `Upload your photograph, photo ID and driving licence to start.${feeNote}`,
          };

  return (
    <Card style={{ gap: theme.spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing.sm }}>
        <View style={{ flex: 1, gap: theme.spacing.xxs }}>
          <Text variant="subheading" tone="brand">Driver onboarding</Text>
          <Text variant="caption" tone="muted">{copy.message}</Text>
        </View>
        <StatusPill
          label={access.status === 'pending_review' ? 'under review' : access.status === 'rejected' ? 'action needed' : 'not live'}
          tone={access.status === 'rejected' ? 'danger' : 'warning'}
        />
      </View>

      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="label" tone="default">1 · Profile</Text>
        <Text variant="caption" tone="muted">
          {profile.profile?.fullName ? `${profile.profile.fullName} · contact details saved` : 'Complete your name and contact details.'}
        </Text>
        <Text variant="label" tone="default">2 · Documents</Text>
        <Text variant="caption" tone="muted">
          {documents.isPending ? 'Checking your documents…' : `${filedCount} of 3 documents uploaded`}
        </Text>
        <Text variant="label" tone="default">3 · One-time onboarding fee</Text>
        <Text variant="caption" tone="muted">
          {onboardingDue?.status === 'paid'
            ? `Paid · ${formatINR(onboardingDue.totalPaise)}`
            : unpaidDue?.kind === 'onboarding_fee'
              ? `${formatINR(unpaidDue.totalPaise)} due`
              : 'The fee appears after you upload your first document.'}
        </Text>
        <Text variant="label" tone="default">4 · Admin approval</Text>
        <Text variant="caption" tone="muted">
          {access.status === 'pending_review' ? 'The office is reviewing your documents and payment.' : 'Your account stays offline until the office approves your application.'}
        </Text>
      </View>

      {dues.outstandingPaise > 0 ? (
        <Text variant="caption" tone="warning">{describeOutstandingFee(dues)}</Text>
      ) : null}
      {unpaidDue ? (
        <Button
          label={`Pay ${formatINR(unpaidDue.totalPaise)} securely`}
          loading={paying}
          fullWidth
          onPress={() => {
            setPaying(true);
            setNotice(null);
            void payDriverDue(unpaidDue.id).then((result) => {
              setNotice(result.ok
                ? `Cashfree returned for ${formatINR(result.amountPaise)}. Your due changes to paid only after DrivX verifies the gateway payment.`
                : result.message);
            }).catch((error) => {
              setNotice(error instanceof Error ? error.message : 'Cashfree could not complete the payment.');
            }).finally(() => setPaying(false));
          }}
        />
      ) : null}
      {notice ? <Text variant="caption" tone="muted">{notice}</Text> : null}
      <Button
        label={access.status === 'rejected' ? 'Update documents' : 'Upload or view documents'}
        appearance="ghost"
        fullWidth
        onPress={() => router.push('/(driver)/documents')}
      />
    </Card>
  );
}
