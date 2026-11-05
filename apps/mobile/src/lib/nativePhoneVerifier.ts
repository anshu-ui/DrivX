import { getApp as getNativeApp } from '@react-native-firebase/app';
import {
  getAuth as getNativeAuth,
  signInWithPhoneNumber as nativeSignInWithPhoneNumber,
} from '@react-native-firebase/auth';
import { PhoneAuthProvider, signInWithCredential } from 'firebase/auth';
import type { FirebaseClients, NativePhoneVerifier } from '@drivx/firebase-client';

/**
 * Native Firebase performs Android/iOS app verification and sends the SMS.
 * The returned verification ID is then exchanged through the Web SDK instance
 * already used by DrivX Firestore/Functions, so its auth listeners and AsyncStorage
 * persistence continue to own the app session.
 */
export function createNativePhoneVerifier(clients: FirebaseClients): NativePhoneVerifier {
  return {
    async start(e164) {
      const confirmation = await nativeSignInWithPhoneNumber(
        getNativeAuth(getNativeApp()),
        e164,
      );
      const verificationId = confirmation.verificationId;

      if (!verificationId) {
        throw new Error('Firebase did not return an SMS verification ID. Request a new code.');
      }

      return {
        verificationId,
        confirm: async (code) => {
          const credential = PhoneAuthProvider.credential(verificationId, code);
          return (await signInWithCredential(clients.auth, credential)).user;
        },
      };
    },
  };
}
