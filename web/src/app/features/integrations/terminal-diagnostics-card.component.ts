import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { TerminalPingResult, TerminalRecord } from '../../core/terminal.models';
import { TerminalService } from '../../core/terminal.service';
import {
  clockStatusLabel,
  formatLatency,
  formatTerminalUptime,
  terminalDatePresentation,
  wifiQuality,
} from './terminal-diagnostics';

const pingResultTtlMs = 600_000;

@Component({
  selector: 'li[app-terminal-diagnostics-card]',
  templateUrl: './terminal-diagnostics-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block px-5 py-5',
  },
})
export class TerminalDiagnosticsCardComponent implements OnDestroy {
  private readonly terminalService = inject(TerminalService);

  readonly terminal = input.required<TerminalRecord>();
  readonly canManage = input(false);
  readonly renameRequested = output<TerminalRecord>();
  readonly rotateRequested = output<TerminalRecord>();
  readonly revokeRequested = output<TerminalRecord>();

  protected readonly pingPending = signal(false);
  protected readonly pingResult = signal<TerminalPingResult | null>(null);
  protected readonly pingError = signal('');
  private pingGeneration = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  protected statusLabel(status: TerminalRecord['connectionStatus']): string {
    switch (status) {
      case 'online':
        return 'En línea';
      case 'revoked':
        return 'Revocado';
      default:
        return 'Sin conexión';
    }
  }

  protected date(value: string): { relative: string; exact: string } {
    return terminalDatePresentation(value);
  }

  protected wifi(rssi: number | null): string {
    const quality = wifiQuality(rssi);
    if (rssi === null || quality === 'Sin datos') return quality;
    const value = rssi < 0 ? `−${Math.abs(rssi)}` : String(rssi);
    return `${quality} · ${value} dBm`;
  }

  protected uptime(seconds: number | null): string {
    return formatTerminalUptime(seconds);
  }

  protected latency(milliseconds: number): string {
    return formatLatency(milliseconds);
  }

  protected clock(value: TerminalRecord['lastClockStatus']): string {
    return clockStatusLabel(value);
  }

  protected async checkConnection(): Promise<void> {
    if (this.pingPending() || this.terminal().connectionStatus === 'revoked') return;
    const generation = ++this.pingGeneration;
    this.clearExpiryTimer();
    this.pingResult.set(null);
    this.pingError.set('');
    this.pingPending.set(true);
    try {
      const result = await this.terminalService.pingTerminal(this.terminal().id);
      if (generation !== this.pingGeneration) return;
      this.pingResult.set(result);
      this.expiryTimer = setTimeout(() => {
        if (generation === this.pingGeneration) this.pingResult.set(null);
      }, pingResultTtlMs);
    } catch (error) {
      if (generation !== this.pingGeneration) return;
      this.pingError.set(this.pingErrorMessage(error));
    } finally {
      if (generation === this.pingGeneration) this.pingPending.set(false);
    }
  }

  ngOnDestroy(): void {
    this.clearPingState();
  }

  @HostListener('window:pagehide')
  protected onPageHide(): void {
    this.clearPingState();
  }

  private clearPingState(): void {
    ++this.pingGeneration;
    this.clearExpiryTimer();
    this.pingPending.set(false);
    this.pingResult.set(null);
    this.pingError.set('');
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer !== undefined) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
  }

  private pingErrorMessage(error: unknown): string {
    const response = this.objectValue(error, 'response');
    const data = this.objectValue(response, 'data');
    const code = String(this.scalarValue(response, 'code') ?? this.scalarValue(data, 'code') ?? '');
    const status = Number(
      this.scalarValue(error, 'status') ?? this.scalarValue(response, 'status') ?? 0,
    );
    if (status === 504 || code === 'terminal_ping_timeout') return 'El terminal no respondió.';
    if (code === 'terminal_revoked') return 'El terminal está revocado.';
    if (code === 'ping_in_progress') return 'Ya hay una comprobación en curso.';
    return 'No se pudo comprobar la conexión del terminal.';
  }

  private objectValue(value: unknown, key: string): object | null {
    if (typeof value !== 'object' || value === null || !(key in value)) return null;
    const nested = (value as Record<string, unknown>)[key];
    return typeof nested === 'object' && nested !== null ? nested : null;
  }

  private scalarValue(value: unknown, key: string): string | number | undefined {
    if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
    const nested = (value as Record<string, unknown>)[key];
    return typeof nested === 'string' || typeof nested === 'number' ? nested : undefined;
  }
}
