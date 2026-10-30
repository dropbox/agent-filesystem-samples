import {afterEach, describe, expect, it} from 'vitest';

import {redact} from './e2e/log';

describe('redact', () => {
  afterEach(() => {
    delete process.env.DBX_APP_SECRET;
  });

  it('hides tokens and connection keys in JSON', () => {
    const body = JSON.stringify({
      access_token: 'sl.secret-token',
      connection_key: 'ck-123',
      refresh_token: 'rt-456',
      user_public_id: 'pid_user:abc',
    });

    const out = redact(`/token 200: ${body}`);

    expect(out).not.toMatch(/sl\.secret-token|ck-123|rt-456/);
    expect(out).toContain('"access_token":"<redacted>"');
    expect(out).toContain('pid_user:abc');
  });

  it('hides bearer tokens', () => {
    expect(redact('Authorization: Bearer ck-123.abc_DEF')).toBe('Authorization: Bearer <redacted>');
  });

  it('hides the app secret wherever it appears', () => {
    process.env.DBX_APP_SECRET = 's3cr3t-value';

    expect(redact('failed with s3cr3t-value in the URL')).toBe('failed with <redacted> in the URL');
  });
});
