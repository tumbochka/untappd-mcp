import { createHmac, timingSafeEqual } from 'node:crypto';

export type ConnectState = {
  firebaseUid: string;
  expiresAt: number;
};

export class ConnectStateSigner {
  constructor(private readonly secret: string) {}

  sign(state: ConnectState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
    return `${payload}.${this.signature(payload)}`;
  }

  verify(value: string, nowSeconds = Math.floor(Date.now() / 1000)): ConnectState {
    const [payload, suppliedSignature, ...rest] = value.split('.');
    if (!payload || !suppliedSignature || rest.length > 0) {
      throw new Error('Invalid OAuth state');
    }

    const expectedSignature = this.signature(payload);
    const expectedBuffer = Buffer.from(expectedSignature);
    const suppliedBuffer = Buffer.from(suppliedSignature);
    if (
      expectedBuffer.byteLength !== suppliedBuffer.byteLength ||
      !timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
      throw new Error('Invalid OAuth state signature');
    }

    let state: ConnectState;
    try {
      state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ConnectState;
    } catch {
      throw new Error('Invalid OAuth state payload');
    }

    if (!state.firebaseUid || !Number.isInteger(state.expiresAt) || state.expiresAt <= nowSeconds) {
      throw new Error('OAuth state has expired');
    }
    return state;
  }

  private signature(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
}
