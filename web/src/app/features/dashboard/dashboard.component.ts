import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { WorkEventKind } from '../../core/models';
import { eventLabel } from '../../core/time-calculations';
import { WorktimeService } from '../../core/worktime.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  protected readonly auth = inject(AuthService);
  protected readonly worktime = inject(WorktimeService);
  protected readonly now = signal(new Date());
  protected readonly eventLabel = eventLabel;
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
    void this.worktime.loadToday();
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
}
