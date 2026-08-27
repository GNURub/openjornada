import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalPingResult, TerminalRecord } from '../../core/terminal.models';
import { TerminalService } from '../../core/terminal.service';
import { TerminalDiagnosticsCardComponent } from './terminal-diagnostics-card.component';

function terminalRecord(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    id: 'terminal-1',
    collectionId: 'attendance_terminals',
    collectionName: 'attendance_terminals',
    organization: 'organization-1',
    name: 'Recepción',
    prefix: 'demo',
    protocolVersion: 1,
    clientVersion: '1.2.3',
    cacheRevision: 7,
    lastSeenAt: '2026-08-27T11:59:30Z',
    lastPendingCount: 2,
    revokedAt: '',
    createdBy: 'admin-1',
    created: '2026-08-20T08:00:00Z',
    updated: '2026-08-27T12:00:00Z',
    expand: {},
    connectionStatus: 'online',
    lastHeartbeatAt: '2026-08-27T11:59:30Z',
    lastAttendanceSyncAt: '2026-08-27T11:58:00Z',
    lastClockStatus: 'synced',
    lastNtpSyncAt: '2026-08-27T11:57:00Z',
    lastWifiRssiDbm: -62,
    lastUptimeSeconds: 90_061,
    ...overrides,
  };
}

function pingResult(): TerminalPingResult {
  return {
    terminalId: 'terminal-1',
    localIp: '192.168.1.44',
    publicIp: '203.0.113.9',
    wifiRssiDbm: -62,
    uptimeSeconds: 81,
    waitForHeartbeatMs: 500,
    responseMs: 120,
    totalLatencyMs: 620,
    checkedAt: '2026-08-27T12:00:00Z',
  };
}

describe('TerminalDiagnosticsCardComponent', () => {
  let fixture: ComponentFixture<TerminalDiagnosticsCardComponent>;
  let pingTerminal: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-08-27T12:00:00Z');
    pingTerminal = vi.fn();
    await TestBed.configureTestingModule({
      imports: [TerminalDiagnosticsCardComponent],
      providers: [{ provide: TerminalService, useValue: { pingTerminal } }],
    }).compileComponents();
    fixture = TestBed.createComponent(TerminalDiagnosticsCardComponent);
    fixture.componentRef.setInput('terminal', terminalRecord());
    fixture.componentRef.setInput('canManage', true);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function button(label: string): HTMLButtonElement {
    const host = fixture.nativeElement as HTMLElement;
    const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  it('uses the li host, presents status as text and exposes exact diagnostic dates', () => {
    const host = fixture.nativeElement as HTMLElement;
    const metadata = (
      TerminalDiagnosticsCardComponent as unknown as {
        ɵcmp: { selectors: string[][] };
      }
    ).ɵcmp;

    expect(metadata.selectors[0]).toContain('li');
    expect(metadata.selectors[0]).toContain('app-terminal-diagnostics-card');
    expect(host.textContent).toContain('En línea');
    expect(host.textContent).toContain('Buena · −62 dBm');
    expect(host.textContent).toContain('1 d 1 h 1 min');
    expect(host.querySelector('[data-testid="last-heartbeat"]')?.getAttribute('title')).toContain(
      '27 ago 2026',
    );
  });

  it('shows live telemetry and clears both IPs after ten minutes', async () => {
    pingTerminal.mockResolvedValue(pingResult());
    button('Comprobar conexión').click();
    await Promise.resolve();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('192.168.1.44');
    expect(host.textContent).toContain('203.0.113.9');
    expect(host.querySelector('[aria-label="Resultado de la comprobación"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    fixture.detectChanges();

    expect(host.textContent).not.toContain('192.168.1.44');
    expect(host.textContent).not.toContain('203.0.113.9');
  });

  it('prevents concurrent checks and announces that it is waiting', async () => {
    let resolvePing!: (value: TerminalPingResult) => void;
    pingTerminal.mockReturnValue(
      new Promise<TerminalPingResult>((resolve) => {
        resolvePing = resolve;
      }),
    );

    button('Comprobar conexión').click();
    fixture.detectChanges();
    const waiting = button('Esperando respuesta…');
    waiting.click();

    expect(waiting.disabled).toBe(true);
    expect(pingTerminal).toHaveBeenCalledTimes(1);
    resolvePing(pingResult());
    await Promise.resolve();
  });

  it('maps timeout errors to a retryable Spanish message', async () => {
    pingTerminal.mockRejectedValue({ status: 504, response: { code: 'terminal_ping_timeout' } });

    button('Comprobar conexión').click();
    await Promise.resolve();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'El terminal no respondió',
    );
    expect(button('Comprobar conexión').disabled).toBe(false);
  });

  it.each([
    ['terminal_revoked', 'El terminal está revocado.'],
    ['ping_in_progress', 'Ya hay una comprobación en curso.'],
  ])('maps %s errors to Spanish', async (code, message) => {
    pingTerminal.mockRejectedValue({ status: 409, response: { code } });

    button('Comprobar conexión').click();
    await Promise.resolve();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(message);
  });

  it('lets a manager-compatible view ping but hides admin-only actions', () => {
    fixture.componentRef.setInput('canManage', false);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(button('Comprobar conexión')).toBeDefined();
    expect(text).not.toContain('Renombrar');
    expect(text).not.toContain('Rotar key');
    expect(text).not.toContain('Revocar');
  });

  it('does not offer ping or management actions for a revoked terminal', () => {
    fixture.componentRef.setInput(
      'terminal',
      terminalRecord({ connectionStatus: 'revoked', revokedAt: '2026-08-27T12:00:00Z' }),
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';

    expect(text).toContain('Revocado');
    expect(text).not.toContain('Comprobar conexión');
    expect(text).not.toContain('Renombrar');
  });

  it('discards a late ping and clears sensitive data synchronously on destroy', async () => {
    let resolvePing!: (value: TerminalPingResult) => void;
    pingTerminal.mockReturnValue(
      new Promise<TerminalPingResult>((resolve) => {
        resolvePing = resolve;
      }),
    );
    const host = fixture.nativeElement as HTMLElement;
    button('Comprobar conexión').click();

    fixture.destroy();
    resolvePing(pingResult());
    await Promise.resolve();

    expect(host.textContent).not.toContain('192.168.1.44');
    expect(host.textContent).not.toContain('203.0.113.9');
  });

  it('clears both IPs synchronously on pagehide for browser cache restores', async () => {
    pingTerminal.mockResolvedValue(pingResult());
    button('Comprobar conexión').click();
    await Promise.resolve();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('192.168.1.44');

    window.dispatchEvent(new Event('pagehide'));
    fixture.detectChanges();

    expect(host.textContent).not.toContain('192.168.1.44');
    expect(host.textContent).not.toContain('203.0.113.9');
  });

  it('never writes a ping result to browser storage', async () => {
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const indexedDbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: indexedDbOpen });
    pingTerminal.mockResolvedValue(pingResult());

    button('Comprobar conexión').click();
    await Promise.resolve();

    expect(storageSpy).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
  });
});
