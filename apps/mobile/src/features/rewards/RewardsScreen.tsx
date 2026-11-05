import { useCallback, useEffect, useState } from 'react';
import { Share, View } from 'react-native';
import { Button, Card, Field, Screen, ScreenHeader, StateView, Text, useTheme } from '@drivx/ui';
import { callFunction } from '@drivx/firebase-client';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

type RewardRole = 'customer' | 'driver';
type RewardLedger = { id: string; type?: string; amountPaise?: number; points?: number; reason?: string; bookingId?: string; expiresAtMs?: number };
type Rewards = {
  account: { customerReferralCode: string | null; driverReferralCode: string | null; walletPaise: number; milesPoints: number; lifetimeMilesPoints: number; customerTrips: number; driverTrips: number; rewardPayablePaise: number; qualifiedDriverReferrals: number; badges: string[] };
  referral: { status?: string; code?: string; referrerUid?: string } | null;
  driver: { ratingAverage: number; ratingCount: number; verificationStatus: string } | null;
  rules: { enabled: boolean; customerReferralCreditPaise: number; customerReferralMinimumFarePaise: number; creditExpiryDays: number; milesPer100Rupees: number; milesPaisePer100Points: number; driverTripsFirstMilestone: number; driverFirstMilestonePaise: number; driverTripsSecondMilestone: number; driverSecondMilestonePaise: number; driverMilestoneWindowDays: number; driverMinimumRating: number; driverMinimumRatings: number };
  payoutRequest: { status: string; amountPaise: number; accountLast4: string; reason: string; createdAtMs: number } | null;
  ledger: RewardLedger[];
};

const money = (paise = 0) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const readable = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

export function RewardsScreen({ role }: { role: RewardRole }) {
  const theme = useTheme();
  const { user } = useSession();
  const [data, setData] = useState<Rewards | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [accountHolder, setAccountHolder] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [confirmAccountNumber, setConfirmAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState('');

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true); setError(null);
    try {
      const result = await callFunction<{ role: RewardRole }, Rewards>(firebase(), 'getRewards', { role });
      setData(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Rewards could not be loaded.');
    } finally { setLoading(false); }
  }, [role, user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const ownCode = role === 'driver' ? data?.account.driverReferralCode : data?.account.customerReferralCode;
  const invite = async () => {
    if (!ownCode) return;
    const reward = role === 'driver' ? 'driver milestone rewards' : `${money(data?.rules.customerReferralCreditPaise)} for both of you`;
    await Share.share({ message: `Join me on DrivX. Use my invite code ${ownCode} to get started. ${reward} unlock after eligible completed trips.` });
  };
  const claim = async () => {
    setBusy(true); setFeedback(null);
    try {
      const functionName = role === 'driver' ? 'claimDriverReferralCode' : 'claimReferralCode';
      await callFunction<{ code: string }, { ok: boolean }>(firebase(), functionName, { code: code.trim() });
      setCode(''); setFeedback('Referral code saved. Rewards unlock after the qualifying trips are completed.'); await refresh();
    } catch (caught) { setFeedback(caught instanceof Error ? caught.message : 'Referral code could not be applied.'); }
    finally { setBusy(false); }
  };
  const requestPayout = async () => {
    const amount = Number(payoutAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setFeedback('Enter a valid payout amount.'); return; }
    setBusy(true); setFeedback(null);
    try {
      await callFunction(firebase(), 'requestDriverRewardPayout', {
        amountPaise: Math.round(amount * 100), accountHolder, accountNumber,
        confirmAccountNumber, ifsc,
      });
      setPayoutAmount(''); setAccountHolder(''); setAccountNumber(''); setConfirmAccountNumber(''); setIfsc('');
      setFeedback('Payout request sent to DrivX Admin. The office will review and record the bank transfer.');
      await refresh();
    } catch (caught) { setFeedback(caught instanceof Error ? caught.message : 'Payout request could not be sent.'); }
    finally { setBusy(false); }
  };

  if (loading && !data) return <Screen><StateView kind="loading" title="Loading rewards" message="Getting your current DrivX rewards." /></Screen>;
  if (error && !data) return <Screen><StateView kind="error" title="Rewards unavailable" message={error} actionLabel="Try again" onAction={() => void refresh()} /></Screen>;
  if (!data) return null;
  const { account, rules } = data;

  return <Screen>
    <ScreenHeader eyebrow="DRIVX REWARDS CLUB" title={role === 'driver' ? 'Captain rewards' : 'Your rewards'} subtitle={role === 'driver' ? 'Trips, milestones and referral rewards in one place.' : 'Invite friends, collect Miles and use eligible credits on a booking.'} />
    {role === 'customer' ? <>
      <Card tone="brand" style={{ gap: theme.spacing.md }}>
        <Text variant="overline" tone="onBrand">YOUR BOOKING CREDIT</Text>
        <Text variant="display" tone="onBrand">{money(account.walletPaise)}</Text>
        <Text variant="caption" tone="onBrand">Available DrivX credit · not withdrawable as cash</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', paddingTop: theme.spacing.md }}>
          <View><Text variant="caption" tone="onBrand">DrivX Miles</Text><Text variant="subheading" tone="onBrand">{account.milesPoints.toLocaleString('en-IN')} pts</Text></View>
          <View style={{ alignItems: 'flex-end' }}><Text variant="caption" tone="onBrand">Completed trips</Text><Text variant="subheading" tone="onBrand">{account.customerTrips}</Text></View>
        </View>
      </Card>
      <Card style={{ gap: theme.spacing.md }}>
        <Text variant="subheading" tone="brand">Invite & earn</Text>
        <Text variant="body" tone="muted">You and your friend each get {money(rules.customerReferralCreditPaise)} after their first completed booking of at least {money(rules.customerReferralMinimumFarePaise)}.</Text>
        <View style={{ borderRadius: theme.radius.md, padding: theme.spacing.md, backgroundColor: theme.colors.surfaceMuted, alignItems: 'center' }}><Text variant="overline" tone="muted">YOUR PERSONAL CODE</Text><Text variant="title" tone="brand" selectable>{ownCode ?? '—'}</Text></View>
        <Button label="Share invite" onPress={() => void invite()} fullWidth />
        <Text variant="caption" tone="faint">No self-referrals or duplicate accounts. Credits expire after {rules.creditExpiryDays} days and cannot be withdrawn.</Text>
      </Card>
      <Card style={{ gap: theme.spacing.md }}>
        <Text variant="subheading" tone="brand">Have a friend’s code?</Text>
        <Text variant="caption" tone="muted">Apply before your first completed trip.</Text>
        <Field label="Referral code" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} />
        <Button label="Apply code" onPress={() => void claim()} loading={busy} disabled={!code.trim()} />
        {data.referral ? <Text variant="caption" tone="success">Code {data.referral.code} · {readable(data.referral.status ?? 'pending')}</Text> : null}
      </Card>
      <Card tone="inset" style={{ gap: theme.spacing.xs }}><Text variant="label" tone="brand">How DrivX Miles work</Text><Text variant="caption" tone="muted">Earn {rules.milesPer100Rupees} points per ₹100 on completed bookings. {Math.round(rules.milesPaisePer100Points / 100)} points = ₹{(rules.milesPaisePer100Points / 100).toFixed(0)} booking credit. Redeem at checkout when enabled.</Text></Card>
    </> : <>
      <Card tone="brand" style={{ gap: theme.spacing.md }}>
        <Text variant="overline" tone="onBrand">REWARD PAYABLE</Text><Text variant="display" tone="onBrand">{money(account.rewardPayablePaise)}</Text>
        <Text variant="caption" tone="onBrand">This is earned referral reward, paid by the office after recording a bank transfer.</Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.2)', paddingTop: theme.spacing.md }}><View><Text variant="caption" tone="onBrand">Completed trips</Text><Text variant="subheading" tone="onBrand">{account.driverTrips}</Text></View><View style={{ alignItems: 'flex-end' }}><Text variant="caption" tone="onBrand">Rating</Text><Text variant="subheading" tone="onBrand">{data.driver?.ratingAverage.toFixed(1) ?? '—'} ★ ({data.driver?.ratingCount ?? 0})</Text></View></View>
      </Card>
      <Card style={{ gap: theme.spacing.md }}>
        <Text variant="subheading" tone="brand">Refer a driver</Text><Text variant="body" tone="muted">Share your code. Earn {money(rules.driverFirstMilestonePaise)} at {rules.driverTripsFirstMilestone} trips and another {money(rules.driverSecondMilestonePaise)} at {rules.driverTripsSecondMilestone} trips within {rules.driverMilestoneWindowDays} days, subject to verification and quality rules.</Text>
        <View style={{ borderRadius: theme.radius.md, padding: theme.spacing.md, backgroundColor: theme.colors.surfaceMuted, alignItems: 'center' }}><Text variant="overline" tone="muted">YOUR CAPTAIN CODE</Text><Text variant="title" tone="brand" selectable>{ownCode ?? '—'}</Text></View>
        <Button label="Share driver invite" onPress={() => void invite()} fullWidth />
        <Text variant="caption" tone="faint">Milestone reward requires approved identity, at least {rules.driverMinimumRatings} ratings averaging {rules.driverMinimumRating.toFixed(1)} or higher, and no serious safety hold.</Text>
      </Card>
      <Card style={{ gap: theme.spacing.sm }}><Text variant="subheading" tone="brand">Your progress</Text><Text variant="body">{account.driverTrips} completed trips · {account.qualifiedDriverReferrals} qualified referrals</Text><Text variant="caption" tone="muted">Next milestone: {rules.driverTripsFirstMilestone} trips → {money(rules.driverFirstMilestonePaise)}; then {rules.driverTripsSecondMilestone} trips → {money(rules.driverSecondMilestonePaise)}.</Text>{account.badges.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>{account.badges.map((badge) => <Text key={badge} variant="caption" tone="primary">✦ {readable(badge)}</Text>)}</View> : <Text variant="caption" tone="faint">Trip badges appear as milestones are reached.</Text>}</Card>
      <Card style={{ gap: theme.spacing.md }}>
        <Text variant="subheading" tone="brand">Request a reward payout</Text>
        <Text variant="caption" tone="muted">Request a bank transfer from your earned driver referral rewards. Admin reviews it and records the transfer reference; money is not sent automatically.</Text>
        {data.payoutRequest?.status === 'pending' ? <Text variant="label" tone="primary">Request pending · {money(data.payoutRequest.amountPaise)} · bank ending {data.payoutRequest.accountLast4}</Text> : data.payoutRequest?.status === 'rejected' ? <Text variant="caption" tone="danger">Last request declined: {data.payoutRequest.reason || 'Contact DrivX support.'}</Text> : data.payoutRequest?.status === 'paid' ? <Text variant="caption" tone="success">Last requested payout recorded as paid · {money(data.payoutRequest.amountPaise)}</Text> : null}
        {data.payoutRequest?.status !== 'pending' ? <>
          <Field label="Amount to withdraw (₹)" value={payoutAmount} onChangeText={setPayoutAmount} keyboardType="decimal-pad" placeholder={`Up to ${money(account.rewardPayablePaise)}`} />
          <Field label="Account holder name" value={accountHolder} onChangeText={setAccountHolder} autoCapitalize="words" />
          <Field label="Bank account number" value={accountNumber} onChangeText={setAccountNumber} keyboardType="number-pad" secureTextEntry />
          <Field label="Confirm account number" value={confirmAccountNumber} onChangeText={setConfirmAccountNumber} keyboardType="number-pad" secureTextEntry />
          <Field label="IFSC code" value={ifsc} onChangeText={setIfsc} autoCapitalize="characters" autoCorrect={false} />
          <Button label="Send payout request" onPress={() => void requestPayout()} loading={busy} disabled={account.rewardPayablePaise <= 0 || !payoutAmount || !accountHolder || !accountNumber || !confirmAccountNumber || !ifsc} fullWidth />
        </> : null}
      </Card>
      <Card tone="inset"><Text variant="caption" tone="muted">Referral rewards are separate from trip commission dues. Your bank details are shared with DrivX Admin only for this payout review and are cleared when the request is approved or declined.</Text></Card>
    </>}
    {feedback ? <Text variant="caption" tone={feedback.includes('saved') ? 'success' : 'danger'}>{feedback}</Text> : null}
    <Card style={{ gap: theme.spacing.sm }}><View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text variant="subheading" tone="brand">Recent activity</Text><Button label="Refresh" appearance="ghost" size="sm" onPress={() => void refresh()} loading={loading} /></View>{data.ledger.length ? data.ledger.slice(0, 12).map((item) => <View key={item.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: theme.spacing.sm }}><View style={{ flex: 1 }}><Text variant="label">{readable(item.type ?? 'reward')}</Text><Text variant="caption" tone="muted">{item.reason ?? (item.points != null ? `${item.points} points` : item.bookingId ? `Trip ${item.bookingId.slice(0, 8)}` : 'DrivX Rewards')}</Text></View><Text variant="label" tone={(item.amountPaise ?? 0) < 0 ? 'muted' : 'success'}>{item.amountPaise != null ? `${item.amountPaise < 0 ? '−' : '+'}${money(Math.abs(item.amountPaise))}` : `+${item.points ?? 0} pts`}</Text></View>) : <Text variant="caption" tone="muted">Completed trip and reward activity will appear here.</Text>}</Card>
  </Screen>;
}
