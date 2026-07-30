import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { UserRecord, WorkEventRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import {
  applyCorrections,
  calculateWorkedMs,
  deriveStatus,
  formatDuration,
} from '../../core/time-calculations';

interface EmployeeSummary {
  user: UserRecord;
  events: WorkEventRecord[];
  durationMs: number;
  workedDays: number;
  openSequence: boolean;
}

@Component({
  selector: 'app-reports',
  imports: [FormsModule],
  templateUrl: './reports.component.html',
})
export class ReportsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly summaries = signal<EmployeeSummary[]>([]);
  protected month = new Date().toISOString().slice(0, 7);
  protected readonly totalDuration = computed(() =>
    this.summaries().reduce((total, item) => total + item.durationMs, 0),
  );
  protected readonly totalEvents = computed(() =>
    this.summaries().reduce((total, item) => total + item.events.length, 0),
  );
  protected readonly anomalies = computed(
    () => this.summaries().filter((item) => item.openSequence).length,
  );
  protected readonly formatDuration = formatDuration;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    const start = new Date(`${this.month}-01T00:00:00`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    end.setMilliseconds(-1);
    const calculationEnd = end > new Date() ? new Date() : end;
    try {
      const [users, events] = await Promise.all([
        this.pb.collection('users').getFullList({
          sort: 'name',
          filter: 'active = true',
        }),
        this.pb.collection('work_events').getFullList({
          filter: this.pb.filter(
            'occurredAt >= {:start} && occurredAt <= {:end}',
            { start: start.toISOString(), end: end.toISOString() },
          ),
          sort: 'occurredAt',
        }),
      ]);
      const typedEvents = events as WorkEventRecord[];
      this.summaries.set(
        (users as UserRecord[]).map((user) => {
          const employeeEvents = typedEvents.filter(
            (event) => event.employee === user.id,
          );
          const effective = applyCorrections(employeeEvents);
          const days = new Set(
            effective
              .filter((event) => event.kind === 'clock_in')
              .map((event) => event.occurredAt.slice(0, 10)),
          );
          return {
            user,
            events: employeeEvents,
            durationMs: calculateWorkedMs(employeeEvents, calculationEnd),
            workedDays: days.size,
            openSequence:
              end < new Date() && deriveStatus(employeeEvents) !== 'off',
          };
        }),
      );
    } catch {
      this.error.set('No se ha podido generar el informe mensual.');
    } finally {
      this.loading.set(false);
    }
  }

  protected exportCsv(): void {
    const rows = [
      [
        'Persona',
        'Código',
        'Mes',
        'Días con entrada',
        'Tiempo efectivo',
        'Eventos',
        'Secuencia abierta',
      ],
      ...this.summaries().map((summary) => [
        summary.user.name,
        summary.user.employeeCode,
        this.month,
        summary.workedDays,
        formatDuration(summary.durationMs),
        summary.events.length,
        summary.openSequence ? 'Sí' : 'No',
      ]),
    ];
    const csv = rows
      .map((row) =>
        row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','),
      )
      .join('\r\n');
    const url = URL.createObjectURL(
      new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `informe-jornada-${this.month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
