import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  CorrectionRequestRecord,
  UserRecord,
  WorkEventKind,
  WorkEventRecord,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import { eventLabel } from '../../core/time-calculations';
import { TimesheetComponent } from './timesheet.component';

@Component({
  selector: 'app-records',
  imports: [FormsModule, TimesheetComponent],
  templateUrl: './records.component.html',
})
export class RecordsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly events = signal<WorkEventRecord[]>([]);
  protected readonly correctionRequests = signal<CorrectionRequestRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly savingCorrection = signal(false);
  protected readonly correctionTarget = signal<WorkEventRecord | null>(null);
  protected readonly eventLabel = eventLabel;
  protected readonly activeTab = signal<'sheet' | 'trace'>('sheet');
  protected readonly canViewCompany = computed(
    () => this.auth.user()?.role !== 'employee',
  );
  protected readonly canResolve = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected correctionKind: Exclude<WorkEventKind, 'correction'> = 'clock_in';
  protected correctionOccurredAt = '';
  protected correctionReason = '';
  protected from = this.toInputDate(
    new Date(new Date().setDate(new Date().getDate() - 30)),
  );
  protected to = this.toInputDate(new Date());
  protected employee = this.auth.user()?.id ?? '';

  constructor() {
    void this.initialize();
  }

  protected async load(): Promise<void> {
    if (!this.employee) return;
    this.loading.set(true);
    this.error.set('');
    const end = new Date(`${this.to}T23:59:59.999`);
    try {
      const records = await this.pb.collection('work_events').getFullList({
        filter: this.pb.filter(
          'employee = {:employee} && occurredAt >= {:from} && occurredAt <= {:to}',
          {
            employee: this.employee,
            from: new Date(`${this.from}T00:00:00`).toISOString(),
            to: end.toISOString(),
          },
        ),
        sort: '-occurredAt',
      });
      this.events.set(records as WorkEventRecord[]);
      await this.loadCorrectionRequests();
    } catch {
      this.error.set('No se han podido cargar los registros.');
    } finally {
      this.loading.set(false);
    }
  }

  protected openCorrection(event: WorkEventRecord): void {
    this.correctionTarget.set(event);
    this.correctionKind =
      event.kind === 'correction' ? 'clock_in' : event.kind;
    const date = new Date(event.occurredAt);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    this.correctionOccurredAt = local.toISOString().slice(0, 23);
    this.correctionReason = '';
    this.error.set('');
    this.success.set('');
  }

  protected async submitCorrection(): Promise<void> {
    const target = this.correctionTarget();
    const user = this.auth.user();
    if (!target || !user) return;
    this.savingCorrection.set(true);
    this.error.set('');
    try {
      await this.pb.collection('correction_requests').create({
        organization: user.organization,
        employee: user.id,
        workEvent: target.id,
        requestedKind: this.correctionKind,
        requestedOccurredAt: new Date(
          this.correctionOccurredAt,
        ).toISOString(),
        reason: this.correctionReason,
        status: 'pending',
      });
      this.correctionTarget.set(null);
      this.success.set(
        'La solicitud se ha enviado a una persona responsable.',
      );
      await this.loadCorrectionRequests();
    } catch {
      this.error.set(
        'No se pudo solicitar la corrección. Revisa el motivo y la fecha.',
      );
    } finally {
      this.savingCorrection.set(false);
    }
  }

  protected async resolveCorrection(
    request: CorrectionRequestRecord,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    this.error.set('');
    try {
      await this.pb.collection('correction_requests').update(request.id, {
        status,
        resolutionNote:
          status === 'approved'
            ? 'Corrección revisada y aprobada.'
            : 'La corrección no ha sido aprobada.',
      });
      this.success.set(
        status === 'approved'
          ? 'Corrección aplicada con trazabilidad.'
          : 'Solicitud rechazada.',
      );
      await this.load();
    } catch {
      this.error.set('No se pudo resolver la solicitud de corrección.');
    }
  }

  protected exportCsv(): void {
    const rows = [
      [
        'Fecha',
        'Hora',
        'Evento',
        'Evento corregido',
        'Dispositivo',
        'Motivo',
        'Huella de integridad',
      ],
      ...this.events().map((event) => {
        const date = new Date(event.occurredAt);
        return [
          new Intl.DateTimeFormat('es-ES').format(date),
          new Intl.DateTimeFormat('es-ES', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }).format(date),
          eventLabel(event.kind),
          event.correctedKind ? eventLabel(event.correctedKind) : '',
          event.source,
          event.note,
          event.integrityHash,
        ];
      }),
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
    anchor.download = `registros-jornada-${this.from}-${this.to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(value));
  }

  protected formatTime(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  }

  private async initialize(): Promise<void> {
    if (this.canViewCompany()) {
      try {
        const records = await this.pb.collection('users').getFullList({
          sort: 'name',
          fields: 'id,name,employeeCode,role',
        });
        this.members.set(records as UserRecord[]);
      } catch {
        this.error.set('No se ha podido cargar la lista de personas.');
      }
    }
    await this.load();
  }

  private async loadCorrectionRequests(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const filter = this.canResolve()
        ? this.pb.filter(
            "organization = {:organization} && status = 'pending'",
            { organization: user.organization },
          )
        : this.pb.filter('employee = {:employee}', { employee: user.id });
      const records = await this.pb
        .collection('correction_requests')
        .getFullList({
          filter,
          sort: '-created',
          expand: 'employee,workEvent',
        });
      this.correctionRequests.set(records as CorrectionRequestRecord[]);
    } catch {
      this.correctionRequests.set([]);
    }
  }

  private toInputDate(date: Date): string {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
}
