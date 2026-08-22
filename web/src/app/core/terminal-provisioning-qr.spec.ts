import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTerminalProvisioningUrl,
  isProvisioningQrUrlWithinLimit,
  renderTerminalProvisioningQr,
} from './terminal-provisioning-qr';
import { TERMINAL_PROVISIONING_V1_VECTOR } from './terminal-provisioning-qr.fixture';

describe('terminal provisioning QR v1', () => {
  it('matches the exact canonical vector', () => {
    expect(buildTerminalProvisioningUrl(TERMINAL_PROVISIONING_V1_VECTOR.input)).toEqual({
      ok: true,
      url: TERMINAL_PROVISIONING_V1_VECTOR.url,
      byteLength: 167,
    });
  });

  it('uses UTF-8 byte limits rather than JavaScript character counts', () => {
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        ssid: 'ñ'.repeat(16),
        wifiPassword: '🔐'.repeat(15) + 'abc',
      }).ok,
    ).toBe(true);
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        ssid: 'ñ'.repeat(17),
      }),
    ).toEqual({ ok: false, error: 'ssid_too_long' });
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        wifiPassword: '🔐'.repeat(16),
      }),
    ).toEqual({ ok: false, error: 'wifi_password_too_long' });
  });

  it.each([
    { ssid: 'Red\ud800Demo' },
    { wifiPassword: 'Clave\udc00WiFi' },
    { baseUrl: 'https://jornada.example.com/\ud800' },
    { terminalToken: 'ojterm_demo\udc00' },
  ])('rejects malformed UTF-16 before encoding: %o', (patch) => {
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        ...patch,
      }),
    ).toEqual({ ok: false, error: 'invalid_text' });
  });

  it('accepts a well-formed UTF-16 surrogate pair', () => {
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        ssid: 'Red \ud83d\ude00',
      }).ok,
    ).toBe(true);
  });

  it.each([
    [{ ssid: '' }, 'ssid_required'],
    [{ baseUrl: '' }, 'base_url_required'],
    [{ baseUrl: 'ftp://jornada.example.com' }, 'base_url_invalid'],
    [{ baseUrl: 'https://user:pass@jornada.example.com' }, 'base_url_invalid'],
    [{ baseUrl: 'https://jornada.example.com?token=x' }, 'base_url_invalid'],
    [{ baseUrl: 'https://jornada.example.com/#secret' }, 'base_url_invalid'],
    [{ baseUrl: `https://example.com/${'x'.repeat(236)}` }, 'base_url_too_long'],
    [{ terminalToken: '' }, 'terminal_token_required'],
    [{ terminalToken: 'ojterm_' }, 'terminal_token_invalid'],
    [{ terminalToken: 'incorrecta' }, 'terminal_token_invalid'],
    [{ terminalToken: `ojterm_${'x'.repeat(90)}` }, 'terminal_token_too_long'],
    [{ ssid: 'Red\nDemo' }, 'invalid_text'],
    [{ wifiPassword: 'Clave\0' }, 'invalid_text'],
  ] as const)('rejects invalid input %o', (patch, error) => {
    expect(
      buildTerminalProvisioningUrl({
        ...TERMINAL_PROVISIONING_V1_VECTOR.input,
        ...patch,
      }),
    ).toEqual({ ok: false, error });
  });

  it('enforces the full URL boundary at 600 bytes', () => {
    expect(isProvisioningQrUrlWithinLimit('x'.repeat(600))).toBe(true);
    expect(isProvisioningQrUrlWithinLimit('x'.repeat(601))).toBe(false);
    const exactly600 = buildTerminalProvisioningUrl({
      ssid: 's',
      wifiPassword: 'p'.repeat(60),
      baseUrl: `https://example.com/${'u'.repeat(220)}`,
      terminalToken: `ojterm_${'t'.repeat(89)}`,
    });
    expect(exactly600).toMatchObject({ ok: true, byteLength: 600 });
    expect(
      buildTerminalProvisioningUrl({
        ssid: 's',
        wifiPassword: 'p'.repeat(60),
        baseUrl: `https://example.com/${'u'.repeat(221)}`,
        terminalToken: `ojterm_${'t'.repeat(89)}`,
      }),
    ).toEqual({ ok: false, error: 'qr_url_too_long' });
  });

  it('accepts an open Wi-Fi network and the 255-byte URL limit', () => {
    const result = buildTerminalProvisioningUrl({
      ssid: 's',
      wifiPassword: '',
      baseUrl: `https://example.com/${'u'.repeat(235)}`,
      terminalToken: 'ojterm_x',
    });
    expect(result.ok).toBe(true);
  });

  it('uses URL-safe Base64 without padding', () => {
    const result = buildTerminalProvisioningUrl({
      ...TERMINAL_PROVISIONING_V1_VECTOR.input,
      ssid: '௿',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const payload = result.url.split('#ojp=', 2)[1];
    expect(payload).toContain('-_');
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(payload).not.toMatch(/[+/=]/u);
  });

  it('renders an SVG with the fixed production QR options', async () => {
    const realToString = QRCode.toString;
    const toStringSpy = vi.spyOn(QRCode, 'toString');
    toStringSpy.mockImplementation((text, options, callback) => {
      const isolatedOptions = { ...options };
      return callback
        ? realToString(text, isolatedOptions, callback)
        : realToString(text, isolatedOptions);
    });

    try {
      const dataUrl = await renderTerminalProvisioningQr(TERMINAL_PROVISIONING_V1_VECTOR.url);
      expect(toStringSpy).toHaveBeenCalledOnce();
      expect(toStringSpy).toHaveBeenCalledWith(TERMINAL_PROVISIONING_V1_VECTOR.url, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 4,
        width: 320,
      });
      expect(dataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
      const svg = atob(dataUrl.split(',', 2)[1]);
      expect(svg).toContain('<svg');
      expect(svg).toContain('width="320"');
    } finally {
      toStringSpy.mockRestore();
    }
  });
});
