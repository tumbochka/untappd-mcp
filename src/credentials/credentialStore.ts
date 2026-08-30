import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { TokenCipher, type EncryptedToken } from './tokenCipher.js';

export type UntappdCredential = {
  accessToken: string;
  untappdUserName?: string;
};

export interface CredentialStore {
  get(firebaseUid: string): Promise<UntappdCredential | null>;
  save(firebaseUid: string, credential: UntappdCredential): Promise<void>;
  delete(firebaseUid: string): Promise<void>;
}

type StoredCredential = {
  encryptedAccessToken?: EncryptedToken;
  untappdUserName?: string;
};

export class FirestoreCredentialStore implements CredentialStore {
  private readonly firestore = getFirestore();

  constructor(private readonly cipher: TokenCipher) {}

  async get(firebaseUid: string): Promise<UntappdCredential | null> {
    const snapshot = await this.document(firebaseUid).get();
    if (!snapshot.exists) {
      return null;
    }
    const stored = snapshot.data() as StoredCredential;
    if (!stored.encryptedAccessToken) {
      return null;
    }
    return {
      accessToken: this.cipher.decrypt(stored.encryptedAccessToken),
      untappdUserName: stored.untappdUserName,
    };
  }

  async save(firebaseUid: string, credential: UntappdCredential): Promise<void> {
    await this.document(firebaseUid).set(
      {
        encryptedAccessToken: this.cipher.encrypt(credential.accessToken),
        untappdUserName: credential.untappdUserName ?? null,
        connectedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  async delete(firebaseUid: string): Promise<void> {
    await this.document(firebaseUid).delete();
  }

  private document(firebaseUid: string) {
    return this.firestore.collection('untappd_credentials').doc(firebaseUid);
  }
}
