import { computed, inject, Injectable, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { WorkEventKind, WorkEventRecord } from './models';
import { PocketBaseService } from './pocketbase.service';
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

  async loadToday(): Promise<void> {
    const user = this.auth.user();
    if (!user) {
      return;
    }
    this.loading.set(true);
    this.error.set('');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    try {
      const records = await this.pb.collection('work_events').getFullList({
        filter: this.pb.filter(
          'employee = {:employee} && occurredAt >= {:start}',
          { employee: user.id, start: start.toISOString() },
        ),
        sort: '-occurredAt',
      });
      this.events.set(records as WorkEventRecord[]);
    } catch {
      this.error.set('No se han podido cargar los fichajes de hoy.');
    } finally {
      this.loading.set(false);
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
    this.reviewEndAt.set(this.localDateTimeValue(new Date()));
    this.reviewKind.set(kind);
  }

  closeReview(): void {
    if (this.submitting()) return;
    this.reviewKind.set(null);
    this.reviewEndAt.set('');
  }

  async record(kind: WorkEventKind, reviewedAt?: string): Promise<boolean> {
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
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source: this.deviceSource(),
        createdBy: user.id,
        integrityHash: 'server-generated',
        clientRequestId: crypto.randomUUID(),
      });
      this.events.update((events) => [
        created as WorkEventRecord,
        ...events,
      ]);
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
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 19);
  }
}
