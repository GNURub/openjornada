import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TimesheetResponse, WorkEventKind } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import {
  calculateDailyProgress,
  calculateWorkedMs,
  eventLabel,
} from '../../core/time-calculations';
import { formatMinutes } from '../../core/timesheet-calculations';
import { WorktimeService } from '../../core/worktime.service';
import { WorktimePictureInPictureService } from '../../shared/worktime-picture-in-picture.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly worktime = inject(WorktimeService);
  protected readonly pip = inject(WorktimePictureInPictureService);
  protected readonly now = signal(new Date());
  protected readonly plannedMinutes = signal(0);
  protected readonly planLoading = signal(true);
  protected readonly eventLabel = eventLabel;
  protected readonly dailyTarget = computed(() =>
    this.planLoading()
      ? 'Cargando…'
      : this.plannedMinutes() > 0
        ? formatMinutes(this.plannedMinutes())
        : 'Sin planificación',
  );
  protected readonly dailyProgress = computed(() => {
    const worked = calculateWorkedMs(this.worktime.events(), this.now());
    return calculateDailyProgress(worked, this.plannedMinutes());
  });
  protected readonly greeting = computed(() => {
    const hour = this.now().getHours();
    if (hour < 13) return 'Buenos días';
    if (hour < 20) return 'Buenas tardes';
    return 'Buenas noches';
  });
  protected readonly primaryAction = computed<{
    label: string;
    kind: WorkEventKind;
  }>(() => {
    if (this.worktime.status() === 'off') {
      return { label: 'Empezar jornada', kind: 'clock_in' };
    }
    if (this.worktime.status() === 'paused') {
      return { label: 'Terminar pausa', kind: 'break_end' };
    }
    return { label: 'Terminar jornada', kind: 'clock_out' };
  });

  constructor() {
    const timer = window.setInterval(() => this.now.set(new Date()), 1_000);
    inject(DestroyRef).onDestroy(() => window.clearInterval(timer));
    void this.loadDailyPlan();
  }

  protected formatClock(date: Date): string {
    return new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  }

  protected formatDate(date: Date): string {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(date);
  }

  protected formatEventTime(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  }

  protected triggerPrimaryAction(): void {
    const kind = this.primaryAction().kind;
    if (kind === 'clock_out' || kind === 'break_end') {
      this.worktime.openReview(kind);
      return;
    }
    const pipRequested = kind === 'clock_in' && this.pip.openForClockIn();
    void this.worktime.record(kind).then((saved) => {
      if (!saved && pipRequested) this.pip.close();
    });
  }

  protected setAutomaticPictureInPicture(event: Event): void {
    this.pip.setAutoOpen((event.target as HTMLInputElement).checked);
  }

  private async loadDailyPlan(): Promise<void> {
    const today = this.localDateKey(new Date());
    try {
      const response = await this.pb.send<TimesheetResponse>(
        `/api/openjornada/timesheet?from=${today}&to=${today}`,
        { method: 'GET' },
      );
      this.plannedMinutes.set(response.days[0]?.plannedMinutes ?? 0);
    } catch {
      this.plannedMinutes.set(0);
    } finally {
      this.planLoading.set(false);
    }
  }

  private localDateKey(date: Date): string {
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
  }
}
