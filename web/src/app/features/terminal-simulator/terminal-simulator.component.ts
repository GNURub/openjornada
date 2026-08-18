import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  TerminalAction,
  TerminalCommand,
  TerminalQueuedAction,
  TerminalResolveResponse,
  TerminalWorkState,
} from '../../core/terminal.models';
import { TerminalService } from '../../core/terminal.service';
import {
  adjustedTime,
  offlineClockTrusted,
  pinDigit,
  refreshedLocalState,
  SimulatorButton,
  visibleButtonLabels,
} from './terminal-simulator.state';

type Screen =
  | 'idle'
  | 'message'
  | 'actions'
  | 'time-picker'
  | 'close-confirm'
  | 'admin-pin'
  | 'admin-employees'
  | 'admin-scan';

interface CachedEmployee {
  employeeId: string;
  displayName: string;
  uid: string;
  state: TerminalWorkState;
}

@Component({
  selector: 'app-terminal-simulator',
  imports: [FormsModule],
  templateUrl: './terminal-simulator.component.html',
})
export class TerminalSimulatorComponent {
  private readonly terminals = inject(TerminalService);
  protected readonly screen = signal<Screen>('idle');
  protected readonly connected = signal(false);
  protected readonly online = signal(true);
  protected readonly busy = signal(false);
  protected readonly message = signal('Configura la API key');
  protected readonly resolved = signal<TerminalResolveResponse | null>(null);
  protected readonly queue = signal<TerminalQueuedAction[]>([]);
  protected readonly cache = signal<CachedEmployee[]>([]);
  protected readonly cacheRevision = signal(0);
  protected readonly selectedTime = signal(new Date());
  protected readonly pickerCommand = signal<TerminalCommand>('clock_out');
  protected readonly pickerClosesBreak = signal(false);
  protected readonly pinDigits = signal([0, 0, 0, 0]);
  protected readonly pinIndex = signal(0);
  protected readonly adminSession = signal('');
  protected readonly adminEmployees = signal<
    Array<{ id: string; name: string; hasRfidTag: boolean }>
  >([]);
  protected readonly adminEmployeeIndex = signal(0);
  protected readonly heldButtons = signal(new Set<SimulatorButton>());
  protected readonly buttonLabels = computed(() => {
    const state = this.resolved()?.state;
    return state ? visibleButtonLabels(state) : {};
  });
  protected readonly currentEmployee = computed(
    () => this.adminEmployees()[this.adminEmployeeIndex()],
  );
  protected readonly clockTrusted = computed(() =>
    offlineClockTrusted(this.lastNtpAt, this.now(), this.rebooted),
  );
  protected token = '';
  protected uid = '';
  protected clientVersion = 'simulator-1.0.0';
  protected nowOffsetMs = 0;
  private sequence = 0;
  private terminalId = '';
  private rebootId = crypto.randomUUID();
  private lastNtpAt: Date | null = null;
  private rebooted = false;
  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private actionTimer: ReturnType<typeof setTimeout> | undefined;
  private adminHoldTimer: ReturnType<typeof setTimeout> | undefined;

  protected now(): Date {
    return new Date(Date.now() + this.nowOffsetMs);
  }

  protected formattedTime(): string {
    return new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(
      this.now(),
    );
  }

  protected formattedSelectedTime(): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(this.selectedTime());
  }

  protected async connect(): Promise<void> {
    if (!this.token.trim()) return;
    this.busy.set(true);
    try {
      const response = await this.terminals.bootstrap(this.token.trim(), {
        protocolVersion: 1,
        clientVersion: this.clientVersion,
        pendingCount: this.queue().length,
      });
      this.connected.set(true);
      this.terminalId = response.terminal.id;
      this.lastNtpAt = new Date(response.serverTime);
      this.rebooted = false;
      this.cacheRevision.set(response.cacheRevision);
      await this.refreshCache(0);
      this.showMessage('Terminal conectado', 2_000);
    } catch (error) {
      this.showMessage(this.errorMessage(error, 'API key no válida'), 5_000);
    } finally {
      this.busy.set(false);
    }
  }

  protected async scan(): Promise<void> {
    if (!this.connected() || !this.uid.trim()) return;
    this.busy.set(true);
    try {
      if (this.screen() === 'admin-scan') {
        const employee = this.currentEmployee();
        if (!employee) return;
        await this.terminals.deviceAssign(
          this.token,
          this.adminSession(),
          employee.id,
          this.uid,
          employee.hasRfidTag,
        );
        employee.hasRfidTag = true;
        this.showMessage(`Tag asignado a ${employee.name}`, 3_000, 'admin-employees');
        return;
      }
      if (this.online()) {
        const response = await this.terminals.resolveTag(this.token, this.uid);
        this.resolved.set(response);
      } else {
        if (!this.clockTrusted()) {
          this.showMessage('Sin hora fiable. Conecta Internet.', 5_000);
          return;
        }
        const normalized = this.normalizeUid(this.uid);
        const employee = this.cache().find((item) => this.normalizeUid(item.uid) === normalized);
        if (!employee) {
          this.showMessage('Tag no asignado; avisa a un responsable', 5_000);
          return;
        }
        employee.state = refreshedLocalState(employee.state, this.now());
        this.resolved.set({
          scanContext: '',
          expiresAt: '',
          employee: { id: employee.employeeId, displayName: employee.displayName },
          state: employee.state,
        });
      }
      this.screen.set('actions');
      this.armActionTimeout();
    } catch (error) {
      this.showMessage(this.errorMessage(error, 'Tag no asignado; avisa a un responsable'), 5_000);
    } finally {
      this.busy.set(false);
    }
  }

  protected pointerDown(button: SimulatorButton): void {
    const next = new Set(this.heldButtons());
    next.add(button);
    this.heldButtons.set(next);
    if (next.has('A') && next.has('C') && this.screen() === 'idle') {
      clearTimeout(this.adminHoldTimer);
      this.adminHoldTimer = setTimeout(() => this.openAdminPin(), 3_000);
    }
  }

  protected pointerUp(button: SimulatorButton): void {
    const next = new Set(this.heldButtons());
    next.delete(button);
    this.heldButtons.set(next);
    if (!(next.has('A') && next.has('C'))) clearTimeout(this.adminHoldTimer);
  }

  protected async press(button: SimulatorButton): Promise<void> {
    if (this.busy()) return;
    switch (this.screen()) {
      case 'actions':
        await this.pressAction(button);
        break;
      case 'time-picker':
        if (button === 'B') await this.confirmSelectedTime();
        else this.selectedTime.set(adjustedTime(this.selectedTime(), button, false));
        break;
      case 'close-confirm':
        if (button === 'A') this.returnToIdle();
        if (button === 'C') await this.execute('clock_out');
        break;
      case 'admin-pin':
        await this.pressPin(button);
        break;
      case 'admin-employees':
        if (button === 'A') this.adminEmployeeIndex.update((value) => Math.max(0, value - 1));
        if (button === 'C')
          this.adminEmployeeIndex.update((value) =>
            Math.min(this.adminEmployees().length - 1, value + 1),
          );
        if (button === 'B' && this.currentEmployee()) this.screen.set('admin-scan');
        break;
      case 'admin-scan':
        if (button === 'A') this.screen.set('admin-employees');
        break;
      default:
        break;
    }
  }

  protected holdTime(button: 'A' | 'C'): void {
    if (this.screen() === 'time-picker')
      this.selectedTime.set(adjustedTime(this.selectedTime(), button, true));
  }

  private async pressAction(button: SimulatorButton): Promise<void> {
    const state = this.resolved()?.state;
    if (!state) return;
    if (state.kind === 'idle' && button === 'B') await this.execute('clock_in');
    if (state.kind === 'working') {
      if (button === 'A') await this.execute('break_start');
      if ((!state.longShift && button === 'C') || (state.longShift && button === 'B'))
        await this.execute('clock_out');
      if (state.longShift && button === 'C') this.openTimePicker('clock_out', false);
    }
    if (state.kind === 'on_break') {
      if (button === 'A') await this.execute('break_end');
      if (button === 'C') this.openTimePicker('break_end', true);
    }
  }

  private openTimePicker(command: TerminalCommand, closesBreak: boolean): void {
    clearTimeout(this.actionTimer);
    this.pickerCommand.set(command);
    this.pickerClosesBreak.set(closesBreak);
    this.selectedTime.set(this.now());
    this.screen.set('time-picker');
  }

  private async confirmSelectedTime(): Promise<void> {
    const succeeded = await this.execute(
      this.pickerCommand(),
      this.selectedTime().toISOString(),
      false,
    );
    if (succeeded && this.pickerClosesBreak()) this.screen.set('close-confirm');
  }

  private async execute(
    command: TerminalCommand,
    appliedAt?: string,
    returnToIdle = true,
  ): Promise<boolean> {
    const resolved = this.resolved();
    if (!resolved) return false;
    this.busy.set(true);
    const capturedAt = this.now().toISOString();
    const requestId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`;
    try {
      if (this.online()) {
        const result = await this.terminals.performAction(this.token, {
          clientRequestId: requestId,
          scanContext: resolved.scanContext,
          command,
          deviceCapturedAt: capturedAt,
          appliedAt,
          clockSyncedAt: (this.lastNtpAt ?? this.now()).toISOString(),
          deviceSequence: this.sequence,
        });
        resolved.state = result.state;
      } else {
        if (!this.clockTrusted() || this.queue().length >= 10_000) {
          this.showMessage('No se puede guardar otro fichaje offline', 5_000);
          return false;
        }
        const queued: TerminalQueuedAction = {
          clientRequestId: requestId,
          uid: this.uid,
          command,
          deviceCapturedAt: capturedAt,
          appliedAt,
          clockSyncedAt: this.lastNtpAt!.toISOString(),
          deviceSequence: this.sequence,
          rebootId: this.rebootId,
          previousLocalHash:
            this.queue().at(-1)?.rebootId === this.rebootId
              ? (this.queue().at(-1)?.signature ?? '')
              : '',
          signature: '',
        };
        queued.signature = await this.signQueuedAction(queued);
        this.queue.update((items) => [...items, queued]);
        resolved.state = this.advanceLocalState(resolved.state, command);
        this.cache.update((items) =>
          items.map((item) =>
            item.employeeId === resolved.employee.id ? { ...item, state: resolved.state } : item,
          ),
        );
      }
      if (returnToIdle) this.showMessage(this.actionMessage(command), 2_500);
      return true;
    } catch (error) {
      this.showMessage(this.errorMessage(error, 'No se pudo registrar la acción'), 5_000);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  protected async synchronize(): Promise<void> {
    if (!this.online() || this.queue().length === 0) return;
    this.busy.set(true);
    try {
      const response = await this.terminals.sync(this.token, this.queue(), this.queue().length);
      const final = new Set(
        response.items
          .filter((item) => ['accepted', 'duplicate', 'incident'].includes(item.status))
          .map((item) => item.clientRequestId),
      );
      this.queue.update((items) => items.filter((item) => !final.has(item.clientRequestId)));
      this.lastNtpAt = new Date(response.serverTime);
      await this.refreshCache(0);
      this.showMessage('Sincronización completada', 2_500);
    } catch (error) {
      this.showMessage(this.errorMessage(error, 'No se pudo sincronizar'), 5_000);
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleOnline(): void {
    this.online.update((value) => !value);
    if (this.online() && this.connected()) void this.connect();
  }

  protected advance(minutes: number): void {
    this.nowOffsetMs += minutes * 60_000;
    const resolved = this.resolved();
    if (resolved) resolved.state = refreshedLocalState(resolved.state, this.now());
  }

  protected reboot(): void {
    this.rebooted = true;
    this.rebootId = crypto.randomUUID();
    this.sequence = 0;
    this.resolved.set(null);
    this.screen.set('idle');
    if (this.online()) void this.connect();
    else this.showMessage('Reinicio sin NTP: fichaje bloqueado', 5_000);
  }

  private async openAdminPin(): Promise<void> {
    if (!this.online()) {
      this.showMessage('La asignación de tags necesita Internet', 5_000);
      return;
    }
    this.pinDigits.set([0, 0, 0, 0]);
    this.pinIndex.set(0);
    this.screen.set('admin-pin');
  }

  private async pressPin(button: SimulatorButton): Promise<void> {
    if (button === 'A' || button === 'C') {
      const digits = [...this.pinDigits()];
      digits[this.pinIndex()] = pinDigit(digits[this.pinIndex()], button);
      this.pinDigits.set(digits);
      return;
    }
    if (this.pinIndex() < 3) {
      this.pinIndex.update((value) => value + 1);
      return;
    }
    try {
      const response = await this.terminals.openAdminSession(this.token, this.pinDigits().join(''));
      this.adminSession.set(response.token);
      const employees = await this.terminals.deviceEmployees(this.token, response.token);
      this.adminEmployees.set(employees.items);
      this.adminEmployeeIndex.set(0);
      this.screen.set('admin-employees');
    } catch (error) {
      this.showMessage(this.errorMessage(error, 'PIN no válido'), 5_000);
    }
  }

  private async refreshCache(revision: number): Promise<void> {
    const response = await this.terminals.deviceCache(this.token, revision);
    if (!response.unchanged) this.cache.set(response.items);
    this.cacheRevision.set(response.revision);
  }

  private armActionTimeout(): void {
    clearTimeout(this.actionTimer);
    this.actionTimer = setTimeout(() => this.returnToIdle(), 10_000);
  }

  private showMessage(message: string, duration: number, next: Screen = 'idle'): void {
    clearTimeout(this.messageTimer);
    clearTimeout(this.actionTimer);
    this.message.set(message);
    this.screen.set('message');
    this.messageTimer = setTimeout(() => this.screen.set(next), duration);
  }

  private returnToIdle(): void {
    clearTimeout(this.actionTimer);
    this.resolved.set(null);
    this.screen.set('idle');
  }

  private advanceLocalState(state: TerminalWorkState, command: TerminalCommand): TerminalWorkState {
    const refreshed = refreshedLocalState(state, this.now());
    const kind =
      command === 'clock_in' || command === 'break_end'
        ? 'working'
        : command === 'break_start'
          ? 'on_break'
          : 'idle';
    return {
      ...refreshed,
      kind,
      since: kind === 'idle' ? null : this.now().toISOString(),
      workedSeconds:
        command === 'clock_in' || command === 'clock_out' ? 0 : refreshed.workedSeconds,
      breakSeconds: command === 'clock_in' || command === 'clock_out' ? 0 : refreshed.breakSeconds,
      longShift: false,
      staleBreak: false,
      actions: [],
    };
  }

  private actionMessage(command: TerminalCommand): string {
    return {
      clock_in: 'Jornada iniciada',
      break_start: 'Pausa iniciada',
      break_end: 'Pausa terminada',
      clock_out: 'Jornada terminada',
    }[command];
  }

  private normalizeUid(uid: string): string {
    return uid.replaceAll(/[:\- ]/g, '').toUpperCase();
  }

  private async signQueuedAction(action: TerminalQueuedAction): Promise<string> {
    const keyBytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`openjornada-terminal-signing-v1|${this.token}`),
    );
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const canonical = [
      this.terminalId,
      action.clientRequestId,
      action.uid,
      action.command,
      action.deviceCapturedAt,
      action.appliedAt ?? '',
      action.clockSyncedAt,
      action.deviceSequence,
      action.rebootId,
      action.previousLocalHash,
    ].join('|');
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (typeof error === 'object' && error !== null && 'response' in error) {
      const response = (error as { response?: { message?: string } }).response;
      if (response?.message) return response.message;
    }
    return fallback;
  }
}
