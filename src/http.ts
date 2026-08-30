import type { IncomingMessage } from 'node:http';

export class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}

export async function readRequestBody(request: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let rejected = false;
    request.on('data', (chunk: Buffer) => {
      if (rejected) {
        return;
      }
      length += chunk.byteLength;
      if (length > limit) {
        rejected = true;
        reject(new HttpRequestError(413, 'Request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', error => reject(error));
  });
}

export async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new HttpRequestError(415, 'Expected application/x-www-form-urlencoded');
  }
  return new URLSearchParams(await readRequestBody(request));
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new HttpRequestError(415, 'Expected application/json');
  }
  try {
    return JSON.parse(await readRequestBody(request)) as unknown;
  } catch {
    throw new HttpRequestError(400, 'Malformed JSON request body');
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const [key, ...values] = part.trim().split('=');
    if (key === name) {
      return values.join('=');
    }
  }
  return undefined;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function expiredCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
