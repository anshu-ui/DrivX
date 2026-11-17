import { SupportCenter } from '../../features/support/SupportCenter';

/**
 * Driver support is also a persistent bottom tab, including before approval.
 *
 * Reachable before approval as well as after it: a driver whose documents were
 * sent back, or whose onboarding payment is recorded wrongly, needs a way to say so that does
 * not depend on the duty screen being unlocked.
 */
export default function DriverSupport() {
  return <SupportCenter role="driver" />;
}
