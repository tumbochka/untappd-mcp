import { createHmac, timingSafeEqual } from 'node:crypto';

export type PersonalAccessTokenFormAction = 'create' | 'revoke';

type FormTokenPayload = {
  firebaseUid: string;
  action: PersonalAccessTokenFormAction;
  expiresAt: number;
};

export class FormTokenSigner {
  constructor(private readonly secret: string) {}

  sign(firebaseUid: string, action: PersonalAccessTokenFormAction, expiresAt: number): string {
    const payload = Buffer.from(JSON.stringify({ firebaseUid, action, expiresAt })).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  verify(value: string | null, firebaseUid: string, action: PersonalAccessTokenFormAction, nowSeconds: number): void {
    if (!value) {
      throw new Error('Missing form token');
    }
    const [payload, suppliedSignature, ...rest] = value.split('.');
    if (!payload || !suppliedSignature || rest.length > 0) {
      throw new Error('Invalid form token');
    }
    const expectedSignature = this.signature(payload);
    const expected = Buffer.from(expectedSignature);
    const supplied = Buffer.from(suppliedSignature);
    if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) {
      throw new Error('Invalid form token signature');
    }
    let data: FormTokenPayload;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FormTokenPayload;
    } catch {
      throw new Error('Invalid form token payload');
    }
    if (data.firebaseUid !== firebaseUid || data.action !== action || !Number.isInteger(data.expiresAt) || data.expiresAt <= nowSeconds) {
      throw new Error('Form token has expired');
    }
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(`personal-access-token-form.${payload}`).digest('base64url');
  }
}
