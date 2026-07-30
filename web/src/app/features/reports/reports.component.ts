import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  buildInspectionWorkbook,
  defaultInspectionRange,
  inspectionRangeError,
  inspectionWorkbookFilename,
  splitInspectionRange,
  type InspectionEmployeeData,
} from '../../core/inspection-workbook';
import { UserRecord, WorkEventRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import { TimesheetService } from '../../core/timesheet.service';
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
  private readonly timesheet = inject(TimesheetService);
  protected readonly loading = signal(true);
  protected readonly exportingInspection = signal(false);
  protected readonly inspectionProgress = signal('');
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly summaries = signal<EmployeeSummary[]>([]);
  protected month = new Date().toISOString().slice(0, 7);
  protected inspectionFrom = defaultInspectionRange().from;
  protected inspectionTo = defaultInspectionRange().to;
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
          filter: this.pb.filter('occurredAt >= {:start} && occurredAt <= {:end}', {
            start: start.toISOString(),
            end: end.toISOString(),
          }),
          sort: 'occurredAt',
        }),
      ]);
      const typedEvents = events as WorkEventRecord[];
      this.summaries.set(
        (users as UserRecord[]).map((user) => {
          const employeeEvents = typedEvents.filter((event) => event.employee === user.id);
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
            openSequence: end < new Date() && deriveStatus(employeeEvents) !== 'off',
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
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(','))
      .join('\r\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `informe-jornada-${this.month}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  protected async exportInspectionWorkbook(): Promise<void> {
    if (this.exportingInspection()) return;
    const validation = inspectionRangeError(this.inspectionFrom, this.inspectionTo);
    if (validation) {
      this.error.set(validation);
      return;
    }

    this.exportingInspection.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const employees = (await this.pb.collection('users').getFullList({
        sort: 'name',
        filter:
          "role = 'employee' && (employmentType = 'full_time' || employmentType = 'part_time')",
        fields:
          'id,name,email,organization,role,active,employeeCode,weeklyHours,employmentType,contractedWeeklyMinutes,complementaryHoursAgreement,jobTitle',
      })) as UserRecord[];
      if (!employees.length) {
        throw new Error('No hay personas con contrato clasificado para incluir.');
      }

      const ranges = splitInspectionRange(this.inspectionFrom, this.inspectionTo);
      const inspectionData: InspectionEmployeeData[] = [];
      for (let employeeIndex = 0; employeeIndex < employees.length; employeeIndex += 1) {
        const employee = employees[employeeIndex];
        this.inspectionProgress.set(
          `Preparando ${employeeIndex + 1} de ${employees.length}: ${employee.name}`,
        );
        const timesheets = [];
        for (const range of ranges) {
          timesheets.push(await this.timesheet.load(range.from, range.to, employee.id));
        }
        inspectionData.push({ employee, timesheets });
      }

      this.inspectionProgress.set('Generando el Excel…');
      const { default: writeExcelFile } = await import('write-excel-file/browser');
      await writeExcelFile(
        buildInspectionWorkbook(inspectionData, this.inspectionFrom, this.inspectionTo, new Date()),
        { fontFamily: 'Arial', fontSize: 10 },
      ).toFile(inspectionWorkbookFilename(this.inspectionFrom, this.inspectionTo));
      this.success.set(
        `Excel de inspección generado con ${employees.length} hojas de personal y una hoja resumen.`,
      );
    } catch (error) {
      this.error.set(
        error instanceof Error && error.message
          ? error.message
          : 'No se pudo generar el Excel de inspección.',
      );
    } finally {
      this.exportingInspection.set(false);
      this.inspectionProgress.set('');
    }
  }
}
