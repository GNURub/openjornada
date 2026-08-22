import QRCode from 'qrcode';

export const TERMINAL_PROVISIONING_QR_MAX_BYTES = 600;
const QR_PREFIX = 'http://192.168.4.1/#ojp=';
const encoder = new TextEncoder();

export interface TerminalProvisioningInput {
  ssid: string;
  wifiPassword: string;
  baseUrl: string;
  terminalToken: string;
}

export type TerminalProvisioningQrErrorCode =
  | 'ssid_required'
  | 'ssid_too_long'
  | 'wifi_password_too_long'
  | 'base_url_required'
  | 'base_url_too_long'
  | 'base_url_invalid'
  | 'terminal_token_required'
  | 'terminal_token_too_long'
  | 'terminal_token_invalid'
  | 'invalid_text'
  | 'qr_url_too_long';

export type TerminalProvisioningQrResult =
  | { ok: true; url: string; byteLength: number }
  | { ok: false; error: TerminalProvisioningQrErrorCode };

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function hasForbiddenText(value: string): boolean {
  return value.includes('\0') || value.includes('\r') || value.includes('\n');
}

function isVisibleAscii(value: string): boolean {
  return [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x21 && code <= 0x7e;
  });
}

function isEarlyValidBaseUrl(value: string): boolean {
  if (
    !isVisibleAscii(value) ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function isProvisioningQrUrlWithinLimit(value: string): boolean {
  return byteLength(value) <= TERMINAL_PROVISIONING_QR_MAX_BYTES;
}

export function buildTerminalProvisioningUrl(
  input: TerminalProvisioningInput,
): TerminalProvisioningQrResult {
  if (input.ssid.length === 0) return { ok: false, error: 'ssid_required' };
  if (byteLength(input.ssid) > 32) return { ok: false, error: 'ssid_too_long' };
  if (byteLength(input.wifiPassword) > 63) {
    return { ok: false, error: 'wifi_password_too_long' };
  }
  if (input.baseUrl.length === 0) return { ok: false, error: 'base_url_required' };
  if (byteLength(input.baseUrl) > 255) return { ok: false, error: 'base_url_too_long' };
  if (!isEarlyValidBaseUrl(input.baseUrl)) return { ok: false, error: 'base_url_invalid' };
  if (input.terminalToken.length === 0) {
    return { ok: false, error: 'terminal_token_required' };
  }
  if (byteLength(input.terminalToken) > 96) {
    return { ok: false, error: 'terminal_token_too_long' };
  }
  if (!isVisibleAscii(input.terminalToken) || !input.terminalToken.startsWith('ojterm_')) {
    return { ok: false, error: 'terminal_token_invalid' };
  }
  if ([input.ssid, input.wifiPassword, input.baseUrl, input.terminalToken].some(hasForbiddenText)) {
    return { ok: false, error: 'invalid_text' };
  }

  const canonicalJson = JSON.stringify({
    v: 1,
    s: input.ssid,
    p: input.wifiPassword,
    u: input.baseUrl,
    t: input.terminalToken,
  });
  const url = `${QR_PREFIX}${base64Url(encoder.encode(canonicalJson))}`;
  if (!isProvisioningQrUrlWithinLimit(url)) return { ok: false, error: 'qr_url_too_long' };
  return { ok: true, url, byteLength: byteLength(url) };
}

export async function renderTerminalProvisioningQr(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 320,
  });
  return `data:image/svg+xml;base64,${base64ForDataUri(encoder.encode(svg))}`;
}

function base64ForDataUri(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
