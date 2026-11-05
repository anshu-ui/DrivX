import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import type { FirebaseClients } from './client';

/**
 * The driver's own document files.
 *
 * A document is written by its owner into a path the Security Rules reconstruct
 * from the caller's uid (`drivers/{uid}/{documentId}` in storage.rules), so the
 * client cannot deposit a file in someone else's folder and the metadata
 * document in Firestore can only point at the object the rules already allow.
 * A download URL is minted per view, by the session that is looking, and never
 * stored — see the avatar section below for why that distinction matters.
 */

export type DriverDocumentLocation = { uid: string; documentId: string };

export const driverDocumentPath = ({ uid, documentId }: DriverDocumentLocation): string =>
  `drivers/${uid}/${documentId}`;

export type DriverDocumentUpload = { path: string; bytes: number };

/** Upload or replace the file behind a driver document. */
export async function uploadDriverDocument(
  clients: FirebaseClients,
  location: DriverDocumentLocation,
  data: Blob | Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<DriverDocumentUpload> {
  const path = driverDocumentPath(location);
  const snap = await uploadBytes(ref(clients.storage, path), data, { contentType });
  // `size` comes back from the server, so the number the driver is shown is
  // what Storage actually stored rather than what the picker claimed.
  return { path, bytes: snap.metadata.size };
}

/**
 * A short-lived https URL for the object, used to show a driver their own
 * upload and to let the reviewer open the file. It is a download token for an
 * authenticated read, not a public link: the rules re-check the caller.
 */
export async function driverDocumentDownloadUrl(
  clients: FirebaseClients,
  location: DriverDocumentLocation,
): Promise<string> {
  return getDownloadURL(ref(clients.storage, driverDocumentPath(location)));
}

export async function deleteDriverDocument(
  clients: FirebaseClients,
  location: DriverDocumentLocation,
): Promise<void> {
  await deleteObject(ref(clients.storage, driverDocumentPath(location)));
}

/**
 * The face the counterparty is shown.
 *
 * `drivers/{uid}/driver_photograph` is the file the office reviews, and its rule
 * reads only the owning driver and staff — which is exactly why a customer can
 * never be pointed at it. `avatars/{uid}/{fileName}` is the one object in this
 * bucket a signed-in stranger may read, so the photograph that is safe to show
 * gets written there a second time, by its own owner, at upload.
 *
 * What a profile stores is the *path*, never a download URL: `getDownloadURL`
 * hands back a bearer token that works without re-checking the rules, so a
 * stored link would leave a driver's face readable in a database dump. Each
 * viewer mints its own from the path, in its own session.
 */

export const PROFILE_AVATAR_FILE = 'profile.jpg';

export type AvatarLocation = { uid: string; fileName?: string };

export const avatarPath = ({ uid, fileName = PROFILE_AVATAR_FILE }: AvatarLocation): string =>
  `avatars/${uid}/${fileName}`;

/** Upload or replace this user's public-facing profile image. */
export async function uploadAvatar(
  clients: FirebaseClients,
  location: AvatarLocation,
  data: Blob | Uint8Array | ArrayBuffer,
  contentType: string,
): Promise<DriverDocumentUpload> {
  const path = avatarPath(location);
  const snap = await uploadBytes(ref(clients.storage, path), data, { contentType });
  return { path, bytes: snap.metadata.size };
}

/** A download URL for the avatar, minted by whoever is looking at it. */
export async function avatarDownloadUrl(
  clients: FirebaseClients,
  location: AvatarLocation,
): Promise<string> {
  return getDownloadURL(ref(clients.storage, avatarPath(location)));
}
