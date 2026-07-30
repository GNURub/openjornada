import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  BreakTypeRecord,
  ManualTimeInterval,
  ManualTimeRequestRecord,
  TimesheetDay,
  TimesheetResponse,
  UserRecord,
} from '../../core/models';
import { AuthService } from '../../core/auth.service';
import { PocketBaseService } from '../../core/pocketbase.service';
import {
  formatMinutes,
  manualTimeDraftError,
  monthRange,
  shiftDate,
  shiftMonth,
} from '../../core/timesheet-calculations';
import { TimesheetService } from '../../core/timesheet.service';
import { eventLabel } from '../../core/time-calculations';

@Component({
  selector: 'app-timesheet',
  imports: [FormsModule],
  templateUrl: './timesheet.component.html',
})
export class TimesheetComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly timesheet = inject(TimesheetService);
  protected readonly auth = inject(AuthService);
  protected readonly sheet = signal<TimesheetResponse | null>(null);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly breakTypes = signal<BreakTypeRecord[]>([]);
  protected readonly pendingRequests = signal<ManualTimeRequestRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly resolving = signal('');
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly editorDate = signal('');
  protected readonly editorMode = signal<'addition' | 'replacement'>('addition');
  protected readonly expandedDates = signal(new Set<string>());
  protected readonly canResolve = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly canViewCompany = computed(() => this.auth.user()?.role !== 'employee');
  protected readonly formatMinutes = formatMinutes;
  protected readonly eventLabel = eventLabel;
  protected viewMode: 'day' | 'month' = 'day';
  protected selectedDay = this.today();
  protected selectedMonth = this.selectedDay.slice(0, 7);
  protected selectedEmployee = this.auth.user()?.id ?? '';
  protected draftIntervals: ManualTimeInterval[] = [];
  protected reason = '';

  constructor() {
    void this.initialize();
  }

  protected async load(): Promise<void> {
    if (!this.selectedEmployee) return;
    this.loading.set(true);
    this.error.set('');
    const range =
      this.viewMode === 'day'
        ? { from: this.selectedDay, to: this.selectedDay }
        : monthRange(this.selectedMonth);
    try {
      this.sheet.set(await this.timesheet.load(range.from, range.to, this.selectedEmployee));
      if (this.viewMode === 'day') {
        this.expandedDates.set(new Set([this.selectedDay]));
      }
      if (this.canResolve()) await this.loadPending();
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo cargar la hoja de fichajes.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected setView(mode: 'day' | 'month'): void {
    this.viewMode = mode;
    if (mode === 'month') this.selectedMonth = this.selectedDay.slice(0, 7);
    else if (!this.selectedDay.startsWith(this.selectedMonth)) {
      this.selectedDay = `${this.selectedMonth}-01`;
    }
    void this.load();
  }

  protected movePeriod(amount: number): void {
    if (this.viewMode === 'day') {
      this.selectedDay = shiftDate(this.selectedDay, amount);
    } else {
      this.selectedMonth = shiftMonth(this.selectedMonth, amount);
    }
    void this.load();
  }

  protected goToday(): void {
    this.selectedDay = this.today();
    this.selectedMonth = this.selectedDay.slice(0, 7);
    void this.load();
  }

  protected toggleDay(date: string): void {
    this.expandedDates.update((dates) => {
      const next = new Set(dates);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  protected isExpanded(date: string): boolean {
    return this.viewMode === 'day' || this.expandedDates().has(date);
  }

  protected hasPendingCorrection(day: TimesheetDay): boolean {
    return day.requests.some(
      (request) => request.requestType === 'replacement' && request.status === 'pending',
    );
  }

  protected openEditor(day: TimesheetDay): void {
    this.editorMode.set('addition');
    this.editorDate.set(day.date);
    this.draftIntervals = [
      {
        kind: 'work',
        start: '',
        end: '',
        startNextDay: false,
        breakType: '',
      },
    ];
    this.reason = '';
    this.error.set('');
    this.success.set('');
  }

  protected openCorrectionEditor(day: TimesheetDay): void {
    this.editorMode.set('replacement');
    this.editorDate.set(day.date);
    this.draftIntervals = day.editableIntervals.map((interval) => ({
      ...interval,
    }));
    this.reason = '';
    this.error.set('');
    this.success.set('');
  }

  protected closeEditor(): void {
    this.editorDate.set('');
    this.editorMode.set('addition');
    this.draftIntervals = [];
    this.reason = '';
  }

  protected addInterval(kind: 'work' | 'break'): void {
    const previous = this.draftIntervals[this.draftIntervals.length - 1];
    const start = previous?.end || (kind === 'work' ? '09:00' : '13:00');
    this.draftIntervals = [
      ...this.draftIntervals,
      {
        kind,
        start,
        end: kind === 'work' ? '17:00' : '13:30',
        startNextDay: previous?.startNextDay ?? false,
        breakType: kind === 'break' ? (this.breakTypes()[0]?.id ?? '') : '',
      },
    ];
  }

  protected removeInterval(index: number): void {
    this.draftIntervals = this.draftIntervals.filter((_interval, itemIndex) => itemIndex !== index);
  }

  protected setIntervalKind(index: number, kind: ManualTimeInterval['kind']): void {
    const interval = this.draftIntervals[index];
    if (!interval) return;
    interval.kind = kind;
    interval.breakType = kind === 'break' ? (this.breakTypes()[0]?.id ?? '') : '';
  }

  protected setIntervalStart(index: number, value: string): void {
    const interval = this.draftIntervals[index];
    if (!interval) return;
    const previous = this.draftIntervals[index - 1];
    const oldStart = interval.start;
    interval.start = value;
    if (previous?.end === oldStart) previous.end = value;
  }

  protected setIntervalEnd(index: number, value: string): void {
    const interval = this.draftIntervals[index];
    if (!interval) return;
    const next = this.draftIntervals[index + 1];
    const oldEnd = interval.end;
    interval.end = value;
    if (next?.start === oldEnd) next.start = value;
  }

  protected manualDraftValid(): boolean {
    return !this.manualDraftError();
  }

  protected manualDraftError(): string {
    return manualTimeDraftError(this.draftIntervals, this.editorMode() === 'replacement');
  }

  protected reasonError(): string {
    if (this.editorMode() !== 'replacement') return '';
    const missing = 8 - this.reason.trim().length;
    if (missing <= 0) return '';
    return missing === 1
      ? 'Añade 1 carácter más para explicar el motivo.'
      : `Añade ${missing} caracteres más para explicar el motivo.`;
  }

  protected isToday(date: string): boolean {
    return date === this.today();
  }

  protected async submitManualTime(): Promise<void> {
    const date = this.editorDate();
    if (!date || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const request =
        this.editorMode() === 'replacement'
          ? await this.timesheet.correct(
              date,
              this.draftIntervals.map((interval) => ({ ...interval })),
              this.reason,
            )
          : await this.timesheet.create(
              date,
              this.draftIntervals.map((interval) => ({ ...interval })),
              this.reason,
            );
      const replacement = request.requestType === 'replacement';
      this.closeEditor();
      this.success.set(
        request.status === 'pending'
          ? replacement
            ? 'La corrección se ha enviado para aprobación.'
            : 'La jornada se ha enviado para aprobación.'
          : replacement
            ? 'La corrección se ha aplicado con trazabilidad.'
            : 'La jornada se ha incorporado con trazabilidad.',
      );
      await this.load();
    } catch (error) {
      this.error.set(
        this.errorMessage(
          error,
          this.editorMode() === 'replacement'
            ? 'No se pudo guardar la corrección. Revisa los tramos y el motivo.'
            : 'No se pudo guardar la jornada. Revisa los tramos.',
        ),
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected async resolve(
    request: ManualTimeRequestRecord,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    if (this.resolving()) return;
    this.resolving.set(request.id);
    this.error.set('');
    try {
      const replacement = request.requestType === 'replacement';
      await this.timesheet.resolve(
        request.id,
        status,
        status === 'approved'
          ? replacement
            ? 'Corrección revisada y aprobada.'
            : 'Jornada revisada y aprobada.'
          : replacement
            ? 'La corrección no ha sido aprobada.'
            : 'La jornada no ha sido aprobada.',
      );
      this.success.set(
        status === 'approved'
          ? replacement
            ? 'Corrección aprobada e incorporada.'
            : 'Jornada aprobada e incorporada.'
          : replacement
            ? 'Corrección rechazada.'
            : 'Jornada rechazada.',
      );
      await this.load();
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo resolver la jornada.'));
    } finally {
      this.resolving.set('');
    }
  }

  protected async cancel(requestId: string): Promise<void> {
    if (this.resolving()) return;
    this.resolving.set(requestId);
    this.error.set('');
    try {
      await this.timesheet.cancel(requestId);
      this.success.set('Solicitud cancelada.');
      await this.load();
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo cancelar la solicitud.'));
    } finally {
      this.resolving.set('');
    }
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${value}T12:00:00Z`));
  }

  protected formatRequestDate(request: ManualTimeRequestRecord): string {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      timeZone: request.timezone,
    }).format(new Date(request.workDate));
  }

  protected formatTime(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: this.sheet()?.timezone,
    }).format(new Date(value));
  }

  protected statusLabel(status: ManualTimeRequestRecord['status']): string {
    return {
      pending: 'Pendiente',
      approved: 'Aprobada',
      rejected: 'Rechazada',
      cancelled: 'Cancelada',
    }[status];
  }

  protected requestLabel(request: { requestType: 'addition' | 'replacement' }): string {
    return request.requestType === 'replacement' ? 'Corrección' : 'Alta manual';
  }

  protected intervalLabel(interval: ManualTimeInterval): string {
    return `${interval.kind === 'work' ? 'Trabajo' : interval.breakTypeName || 'Pausa'} · ${interval.start}–${interval.end}${interval.startNextDay ? ' (+1d)' : ''}`;
  }

  protected breakTypeName(id: string): string {
    return this.breakTypes().find((item) => item.id === id)?.name || 'Pausa';
  }

  private async initialize(): Promise<void> {
    try {
      const requests: Promise<unknown>[] = [
        this.pb.collection('break_types').getFullList({
          filter: 'active = true',
          sort: 'name',
        }),
      ];
      if (this.canViewCompany()) {
        requests.push(
          this.pb.collection('users').getFullList({
            filter: 'active = true',
            sort: 'name',
            fields: 'id,name,employeeCode,role',
          }),
        );
      }
      const [breakTypes, members] = await Promise.all(requests);
      this.breakTypes.set(breakTypes as BreakTypeRecord[]);
      if (members) this.members.set(members as UserRecord[]);
    } catch {
      this.error.set('No se pudo preparar la hoja de fichajes.');
    }
    await this.load();
  }

  private async loadPending(): Promise<void> {
    const records = await this.pb.collection('manual_time_requests').getFullList({
      filter: "status = 'pending'",
      sort: '-created',
      expand: 'employee',
    });
    this.pendingRequests.set(records as ManualTimeRequestRecord[]);
  }

  private errorMessage(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'message' in error.response
    ) {
      return String(error.response.message);
    }
    return fallback;
  }

  private today(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
}
