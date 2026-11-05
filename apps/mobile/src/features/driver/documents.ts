import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { driverDocumentDownloadUrl, toEpochMs, uploadAvatar, uploadDriverDocument } from '@drivx/firebase-client';
import {
  COLLECTIONS,
  SUBCOLLECTIONS,
  documentNumberSchema,
  driverDocumentUploadInputSchema,
  type DocumentType,
  type VerificationStatus,
} from '@drivx/domain';
import { doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { useSession } from '../auth/AuthProvider';
import { firebase } from '../../lib/firebase';

/**
 * The driver's own paperwork.
 *
 * Two writes per document, in this order: the file to Cloud Storage at
 * `drivers/{uid}/{type}`, then the Firestore pointer at
 * `driverProfiles/{uid}/documents/{type}`. The order matters because the rules
 * rebuild the storage path from the caller's uid and the document id, so a
 * pointer can only ever describe a file the same driver is allowed to write.
 *
 * The photograph is written three times. Its third write is the copy at
 * `avatars/{uid}/profile.jpg` — the one object in the bucket a signed-in
 * customer may read, and therefore the only face a customer's driver card can
 * point at.
 *
 * A driver never sets their own `status` to `approved`. `pending_review` is the
 * only value the create rule accepts, and the review columns are held by
 * `setDriverVerification` on the admin side.
 */

/** One row of the checklist, with whatever the driver has already filed. */
export type DriverDocumentView = {
  type: DocumentType;
  status: VerificationStatus | 'not_uploaded';
  numberMasked: string | null;
  uploadedAtMs: number | null;
  rejectionNote: string | null;
  /** True once a file exists, so the screen can offer "view your upload". */
  hasFile: boolean;
};

export type PickedAsset = {
  uri: string;
  fileName?: string | null;
  mimeType?: string | null;
};

const documentRef = (uid: string, type: DocumentType) =>
  doc(
    firebase().firestore,
    `${COLLECTIONS.driverProfiles}/${uid}/${SUBCOLLECTIONS.driverDocuments}/${type}`,
  );

/**
 * Read a picked file as a native Blob.
 *
 * Do not request base64 from Expo ImagePicker here. Passing the decoded
 * Uint8Array to Firebase Web Storage makes React Native's XHR/Blob polyfill
 * attempt to construct a Blob from an ArrayBuffer, which React Native rejects.
 * XHR's `blob` response type reads the local `file://` URI into a Blob without
 * that conversion and is also supported by browser `blob:`/file responses.
 */
async function assetBlob(asset: PickedAsset): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.onload = () => {
      if (request.status >= 400) {
        reject(new Error(`Could not read the selected file (HTTP ${request.status}).`));
        return;
      }
      if (!(request.response instanceof Blob)) {
        reject(new Error('Could not read the selected file as an image. Please choose it again.'));
        return;
      }
      resolve(request.response);
    };
    request.onerror = () => reject(new Error('Could not read the selected file. Check its permissions and try again.'));
    request.onabort = () => reject(new Error('Reading the selected file was cancelled.'));
    request.open('GET', asset.uri, true);
    request.responseType = 'blob';
    request.send();
  });
}

/** Reads the checklist against what this driver has actually filed. */
export function useDriverDocuments() {
  const { user } = useSession();
  const uid = user?.uid ?? null;

  return useQuery({
    queryKey: ['driverDocuments', uid],
    enabled: uid !== null,
    queryFn: async () => {
      const types = driverDocumentTypes();
      const rows = await Promise.all(
        types.map(async (type): Promise<DriverDocumentView> => {
          const snap = await getDoc(documentRef(uid!, type));
          if (!snap.exists()) {
            return {
              type,
              status: 'not_uploaded',
              numberMasked: null,
              uploadedAtMs: null,
              rejectionNote: null,
              hasFile: false,
            };
          }
          const data = snap.data();
          return {
            type,
            status: (data.status as VerificationStatus) ?? 'not_uploaded',
            numberMasked: (data.numberMasked as string | null) ?? null,
            uploadedAtMs: toEpochMs(data.uploadedAtMs),
            rejectionNote: (data.rejectionNote as string | null) ?? null,
            hasFile: typeof data.storagePath === 'string' && data.storagePath.length > 0,
          };
        }),
      );
      return rows;
    },
  });
}

/**
 * Upload the file, then file the pointer.
 *
 * A document the reviewer already approved is not replaced from here: the rules
 * deny updating an `approved` row, and silently overwriting the evidence behind
 * an approval would be worse than telling the driver to contact the office.
 */
export function useUploadDriverDocument() {
  const { user } = useSession();
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      type: DocumentType;
      asset: PickedAsset;
      /** Typed by the driver; stored only as its last four characters. */
      number?: string | null;
    }) => {
      const uid = user?.uid;
      if (!uid) throw new Error('Sign in again to upload a document.');

      const blob = await assetBlob(input.asset);
      const contentType = input.asset.mimeType ?? 'image/jpeg';
      const sizeBytes = blob.size;

      const file = driverDocumentUploadInputSchema.safeParse({
        type: input.type,
        fileName: input.asset.fileName ?? input.type,
        sizeBytes,
        contentType,
      });
      if (!file.success) throw new Error(file.error.issues[0]?.message ?? 'That file cannot be uploaded.');

      const existing = await getDoc(documentRef(uid, input.type));
      const status = existing.exists() ? (existing.data().status as VerificationStatus) : null;
      if (status === 'approved' || status === 'expired') {
        throw new Error(
          `This document is already ${status}. Ask the office to reopen it before uploading a new one.`,
        );
      }

      const clients = firebase();
      const storagePath = await uploadDriverDocument(clients, { uid, documentId: input.type }, blob, contentType);

      // The face the customer is shown cannot be the file the office reviews:
      // `drivers/{uid}/…` is readable only by its owner and staff, so a
      // stranger's download of it would be refused by the rules. The same image
      // is copied to `avatars/{uid}/…`, which any signed-in reader may open,
      // and the profile stores that path rather than a minted URL.
      let publicPhotoPath: string | null = null;
      if (input.type === 'driver_photograph') {
        publicPhotoPath = (await uploadAvatar(clients, { uid }, blob, contentType)).path;
      }

      const numberMasked =
        input.number && input.number.trim().length > 0
          ? documentNumberSchema.parse(input.number)
          : null;

      const fields = {
        id: input.type,
        driverUid: uid,
        type: input.type,
        storagePath: storagePath.path,
        status: 'pending_review' as VerificationStatus,
        numberMasked,
        // A native Timestamp, like every other `*Ms` field in this database: the
        // reviewer sorts and reads it, and `toEpochMs` turns it back into a
        // number at the read boundary.
        uploadedAtMs: serverTimestamp(),
        rejectionNote: null,
      };

      if (existing.exists()) {
        // The review columns belong to the reviewer, so they are not re-sent.
        await updateDoc(documentRef(uid, input.type), fields);
      } else {
        await setDoc(documentRef(uid, input.type), {
          ...fields,
          sha256: null,
          issuedBy: null,
          validFromMs: null,
          validUntilMs: null,
          reviewedAtMs: null,
          reviewedByUid: null,
        });
      }

      if (publicPhotoPath) {
        // Filed last: an assignment builds the customer's driver card off this
        // path, and a row that claims a face before the copy exists would put
        // a broken image on a stranger's trip screen.
        await updateDoc(doc(firebase().firestore, COLLECTIONS.driverProfiles, uid), {
          photoUrl: publicPhotoPath,
        });
      }
      return fields;
    },
    onSuccess: async () => {
      // The verification state itself arrives by listener (see profile.ts), so
      // only the checklist needs re-reading here.
      await client.invalidateQueries({ queryKey: ['driverDocuments', user?.uid] });
    },
  });
}

/**
 * A download URL for the driver's own upload, so they can confirm the photo is
 * legible before the office looks at it. Rules refuse another driver's path.
 */
export async function ownDocumentUrl(uid: string, type: DocumentType): Promise<string> {
  return driverDocumentDownloadUrl(firebase(), { uid, documentId: type });
}

/**
 * The document kinds the checklist asks for — all three of them, in the order a
 * driver should photograph them. The face first, because it is the one thing
 * standing between a phone camera and a usable image.
 */
export function driverDocumentTypes(): DocumentType[] {
  return ['driver_photograph', 'photo_id', 'driving_licence'];
}
