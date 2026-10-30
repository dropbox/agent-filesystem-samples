// The live tests' run log. Lines go to the file in FOLDERSYNC_E2E_LOG, with
// tokens, connection keys, and the app secret replaced by <redacted>.
import {appendFileSync} from 'node:fs';

export function redact(text: string): string {
  let out = text
    .replace(
      /("(?:access_token|connection_key|refresh_token|app_secret)"\s*:\s*")[^"]*(")/g,
      '$1<redacted>$2'
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1<redacted>');
  const secret = process.env.DBX_APP_SECRET;
  if (secret) {
    out = out.split(secret).join('<redacted>');
  }
  return out;
}

export function e2eLog(line: string): void {
  const path = process.env.FOLDERSYNC_E2E_LOG;
  if (path) {
    appendFileSync(path, `${new Date().toISOString()} ${redact(line)}\n`);
  }
}
