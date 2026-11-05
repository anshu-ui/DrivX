import { FunctionCallError, callFunction } from '@drivx/firebase-client';
import { firebase } from '../../lib/firebase';

export async function submitDriverApplication(): Promise<string> {
  try {
    const result = await callFunction<undefined, { status: string; alreadySubmitted: boolean }>(
      firebase(),
      'submitDriverApplication',
      undefined,
    );
    return result.alreadySubmitted ? 'Your application is already with Admin for review.' : 'Documents submitted. Admin will review your application.';
  } catch (error) {
    return error instanceof FunctionCallError ? error.message : 'Could not submit your documents. Please try again.';
  }
}
