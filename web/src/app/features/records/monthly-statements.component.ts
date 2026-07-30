import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  buildMonthlyStatementCsv,
  monthlyStatementCsvFilename,
} from '../../core/monthly-statement-csv';
import {
  MonthlyStatementAcknowledgement,
  MonthlyTimeStatement,
  UserRecord,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import { formatMinutes, shiftMonth } from '../../core/timesheet-calculations';

@Component({
  selector: 'app-monthly-statements',
  imports: [FormsModule],
  templateUrl: './monthly-statements.component.html',
})
export class MonthlyStatementsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly statements = signal<MonthlyTimeStatement[]>([]);
  protected readonly acknowledgements = signal<MonthlyStatementAcknowledgement[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canClose = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly formatMinutes = formatMinutes;
  protected period = shiftMonth(new Date().toISOString().slice(0, 7), -1);
  protected employee = this.auth.user()?.id ?? '';

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [statements, acknowledgements, members] = await Promise.all([
        this.pb.collection('monthly_time_statements').getFullList({
          sort: '-period,-version',
          expand: 'employee,generatedBy',
        }),
        this.pb
          .collection('monthly_statement_acknowledgements')
          .getFullList({ sort: '-acknowledgedAt' }),
        this.canClose()
          ? this.pb.collection('users').getFullList({
              filter: "active = true && role = 'employee'",
              sort: 'name',
              fields:
                'id,name,employeeCode,employmentType,contractedWeeklyMinutes,complementaryHoursAgreement',
            })
          : Promise.resolve([]),
      ]);
      this.statements.set(statements as MonthlyTimeStatement[]);
      this.acknowledgements.set(acknowledgements as MonthlyStatementAcknowledgement[]);
      this.members.set(members as UserRecord[]);
      if (this.canClose()) {
        this.employee ||= (members[0] as UserRecord | undefined)?.id ?? '';
      }
    } catch {
      this.error.set('No se pudieron cargar los resúmenes mensuales.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async closePeriod(): Promise<void> {
    if (!this.employee || !this.period || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      await this.pb.send('/api/openjornada/monthly-statements/close', {
        method: 'POST',
        body: { employee: this.employee, period: this.period },
      });
      this.success.set('Periodo cerrado y resumen puesto a disposición de la persona.');
      await this.load();
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo cerrar el periodo mensual.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async acknowledge(statement: MonthlyTimeStatement): Promise<void> {
    this.error.set('');
    try {
      await this.pb.send(`/api/openjornada/monthly-statements/${statement.id}/acknowledge`, {
        method: 'POST',
      });
      this.success.set('Recepción del resumen confirmada.');
      await this.load();
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo confirmar la recepción.'));
    }
  }

  protected acknowledged(statement: MonthlyTimeStatement): boolean {
    return this.acknowledgements().some((item) => item.statement === statement.id);
  }

  protected isOwn(statement: MonthlyTimeStatement): boolean {
    return statement.employee === this.auth.user()?.id;
  }

  protected exportCsv(statement: MonthlyTimeStatement): void {
    const url = URL.createObjectURL(
      new Blob([buildMonthlyStatementCsv(statement)], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = monthlyStatementCsvFilename(statement);
    anchor.click();
    URL.revokeObjectURL(url);
  }

  protected print(): void {
    window.print();
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  private responseMessage(error: unknown, fallback: string): string {
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
}
