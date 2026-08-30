import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export type EncryptedToken = {
  ciphertext: string;
  iv: string;
  tag: string;
  version: 1;
};

export class TokenCipher {
  constructor(private readonly key: Buffer) {
    if (key.byteLength !== 32) {
      throw new Error('TokenCipher requires a 32-byte key');
    }
  }

  encrypt(accessToken: string): EncryptedToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      version: 1,
    };
  }

  decrypt(token: EncryptedToken): string {
    if (token.version !== 1) {
      throw new Error(`Unsupported encrypted token version: ${token.version}`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(token.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(token.tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(token.ciphertext, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}
