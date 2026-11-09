/**
 * DrivX Cloud Functions.
 *
 * Everything a client is not allowed to decide — fares, roles, trip state,
 * payment results, driver eligibility — lives behind these endpoints. Phase 1
 * ships identity, roles and verification for real; later phases are declared
 * with their input contract and fail with `unimplemented` rather than pretending.
 */
export { bookingOptions, cancelBooking, createBooking, dispatchNewBooking, quoteFare, registerDeviceToken, unregisterDeviceToken } from './functions/bookings';
export { notifyBookingCreated, notifyBookingStateChanged, notifyDriverDueCreated, notifyDriverDueSettled, notifyDriverVerification } from './functions/activityNotifications';
export { setDriverVerification } from './functions/driverVerification';
export { adminManageBooking, adminSetDriverAccountStatus, resetDriverOnboarding } from './functions/adminOperations';
export {
  publishDriverCardOnAssignmentEvent,
  publishDriverCardOnImportedBookingEvent,
} from './functions/driverCard';
export { recordDriverDuePayment } from './functions/driverDues';
export { flagDriverOnFirstUpload, flagDriverOnResubmission } from './functions/driverReview';
export { manualAssign, publishDriverLocation, respondToAssignment, setAvailability } from './functions/dispatch';
export { acceptDutyTerms } from './functions/duty';
export { driverGateway } from './functions/driverGateway';
export { beginDriverOnboarding, provisionNewAccount, provisionSelf, submitDriverApplication } from './functions/identity';
export { createPaymentOrder, paymentWebhook } from './functions/payments';
export { resolvePlace, reverseGeocode, searchPlaces } from './functions/places';
export { rateTrip } from './functions/ratings';
export { sweepExpiredDriverOffers, sweepStaleDispatchPins, sweepStaleLocationData } from './functions/scheduled';
export { setRole } from './functions/roles';
export { chargeCommissionOnCompletion, chargeCommissionOnImportedTrip } from './functions/tripCommission';
export { claimDriverReferralCode, claimReferralCode, getRewards, manageRewardsAdmin, requestDriverRewardPayout, settleRewardsOnTripCompletion } from './functions/rewards';
export {
  confirmArrival,
  confirmCompletion,
  customerContactForAssignedDriver,
  recordOdometer,
  tripCodes,
  verifyTripOtp,
} from './functions/trip';
