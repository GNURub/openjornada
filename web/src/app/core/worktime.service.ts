import { computed, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { WorkEventKind, WorkEventRecord } from './models';
import { PocketBaseService } from './pocketbase.service';
import { pocketBaseDateTime } from './pocketbase-date';
import {
  calculateWorkedMs,
  deriveStatus,
  formatDuration,
  formatDurationWithSeconds,
} from './time-calculations';

export type ReviewableWorkEventKind = 'clock_out' | 'break_end';

@Injectable({ providedIn: 'root' })
export class WorktimeService {
  private readonly pb = inject(PocketBaseService).client;
  private readonly auth = inject(AuthService);

  readonly events = signal<WorkEventRecord[]>([]);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  readonly error = signal('');
  readonly status = computed(() => deriveStatus(this.events()));
  readonly reviewKind = signal<ReviewableWorkEventKind | null>(null);
  readonly reviewEndAt = signal('');
  readonly reviewRecordedAt = signal('');
  readonly reviewReason = signal('');

  async loadToday(): Promise<void> {
    const user = this.auth.user();
    if (!user) {
      return;
    }
    this.loading.set(true);
    this.error.set('');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since = (start: Date) =>
      this.pb.collection('work_events').getFullList({
        filter: this.pb.filter('employee = {:employee} && occurredAt >= {:start}', {
          employee: user.id,
          start: pocketBaseDateTime(start),
        }),
        sort: '-occurredAt',
      });
    try {
      // Las dos consultas van a la vez para que la carga no tarde más que antes; solo si la
      // jornada anterior sigue abierta hace falta una tercera desde su entrada.
      const [todayRecords, start] = await Promise.all([
        since(today),
        this.openShiftStart(user.id, today),
      ]);
      const records = start.getTime() === today.getTime() ? todayRecords : await since(start);
      this.events.set(records as WorkEventRecord[]);
    } catch {
      this.error.set('No se han podido cargar los fichajes de hoy.');
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Inicio desde el que hay que cargar los fichajes. Normalmente es hoy a las 00:00, pero si
   * la jornada anterior quedó abierta (el último fichaje previo no es una salida), se carga
   * desde su entrada: así la persona ve la jornada en curso y puede cerrarla con la hora real
   * en lugar de quedarse en «Fuera de jornada» con un «Empezar jornada» que el servidor rechaza.
   */
  private async openShiftStart(employee: string, today: Date): Promise<Date> {
    try {
      const previous = await this.pb.collection('work_events').getList(1, 1, {
        filter: this.pb.filter(
          "employee = {:employee} && kind != 'correction' && occurredAt < {:start}",
          { employee, start: pocketBaseDateTime(today) },
        ),
        sort: '-occurredAt',
      });
      const last = previous.items[0] as WorkEventRecord | undefined;
      if (!last || last.kind === 'clock_out') {
        return today;
      }
      const clockIn = await this.pb.collection('work_events').getList(1, 1, {
        filter: this.pb.filter(
          "employee = {:employee} && kind = 'clock_in' && occurredAt <= {:at}",
          { employee, at: last.occurredAt },
        ),
        sort: '-occurredAt',
      });
      const opened = clockIn.items[0] as WorkEventRecord | undefined;
      return opened ? new Date(String(opened.occurredAt).replace(' ', 'T')) : today;
    } catch {
      return today;
    }
  }

  workedToday(now = new Date()): string {
    return formatDuration(calculateWorkedMs(this.events(), now));
  }

  workedTodayTimer(now = new Date()): string {
    return formatDurationWithSeconds(calculateWorkedMs(this.events(), now));
  }

  openReview(kind: ReviewableWorkEventKind): void {
    this.error.set('');
    const now = new Date();
    this.reviewRecordedAt.set(now.toISOString());
    this.reviewEndAt.set(this.localDateTimeValue(now));
    this.reviewReason.set('');
    this.reviewKind.set(kind);
  }

  closeReview(): void {
    if (this.submitting()) return;
    this.reviewKind.set(null);
    this.reviewEndAt.set('');
    this.reviewRecordedAt.set('');
    this.reviewReason.set('');
  }

  async record(kind: WorkEventKind, reviewedAt?: string, adjustmentReason = ''): Promise<boolean> {
    const user = this.auth.user();
    if (!user || this.submitting()) {
      return false;
    }
    this.submitting.set(true);
    this.error.set('');
    try {
      const created = await this.pb.collection('work_events').create({
        employee: user.id,
        organization: user.organization,
        kind,
        occurredAt:
          reviewedAt && (kind === 'clock_out' || kind === 'break_end')
            ? reviewedAt
            : new Date().toISOString(),
        adjustmentReason:
          kind === 'clock_out' || kind === 'break_end' ? adjustmentReason.trim() : '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source: this.deviceSource(),
        createdBy: user.id,
        integrityHash: 'server-generated',
        clientRequestId: crypto.randomUUID(),
      });
      this.events.update((events) => [created as WorkEventRecord, ...events]);
      return true;
    } catch (error) {
      const detail =
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        typeof error.response === 'object' &&
        error.response !== null &&
        'message' in error.response
          ? String(error.response.message)
          : '';
      this.error.set(detail || 'No se ha podido guardar el fichaje.');
      return false;
    } finally {
      this.submitting.set(false);
    }
  }

  private deviceSource(): 'desktop' | 'mobile' | 'tablet' {
    if (window.innerWidth < 640) {
      return 'mobile';
    }
    if (window.innerWidth < 1024) {
      return 'tablet';
    }
    return 'desktop';
  }

  private localDateTimeValue(date: Date): string {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  }
}
