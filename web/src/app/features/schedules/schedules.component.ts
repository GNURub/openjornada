import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { UserRecord, WorkScheduleRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-schedules',
  imports: [FormsModule],
  templateUrl: './schedules.component.html',
})
export class SchedulesComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly schedules = signal<WorkScheduleRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly weekdayOptions = [
    { value: 1, label: 'L' },
    { value: 2, label: 'M' },
    { value: 3, label: 'X' },
    { value: 4, label: 'J' },
    { value: 5, label: 'V' },
    { value: 6, label: 'S' },
    { value: 0, label: 'D' },
  ];
  protected employee = '';
  protected name = 'Horario habitual';
  protected validFrom = this.today();
  protected validUntil = '';
  protected weekdays = [1, 2, 3, 4, 5];
  protected startTime = '09:00';
  protected endTime = '17:00';
  protected breakMinutes = 30;

  constructor() {
    void this.initialize();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const records = await this.pb.collection('work_schedules').getFullList({
        sort: '-active,-validFrom',
        expand: 'employee',
      });
      this.schedules.set(records as WorkScheduleRecord[]);
    } catch {
      this.error.set('No se han podido cargar los horarios.');
    } finally {
      this.loading.set(false);
    }
  }

  protected toggleWeekday(day: number): void {
    this.weekdays = this.weekdays.includes(day)
      ? this.weekdays.filter((item) => item !== day)
      : [...this.weekdays, day];
  }

  protected async createSchedule(): Promise<void> {
    const user = this.auth.user();
    if (!user || !this.employee) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      await this.pb.collection('work_schedules').create({
        organization: user.organization,
        employee: this.employee,
        name: this.name,
        validFrom: new Date(`${this.validFrom}T00:00:00`).toISOString(),
        validUntil: this.validUntil
          ? new Date(`${this.validUntil}T23:59:59`).toISOString()
          : '',
        weekdays: this.weekdays,
        startTime: this.startTime,
        endTime: this.endTime,
        breakMinutes: this.breakMinutes,
        active: true,
        createdBy: user.id,
      });
      this.formOpen.set(false);
      this.success.set('Horario asignado correctamente.');
      await this.load();
    } catch {
      this.error.set(
        'No se pudo guardar el horario. Comprueba las horas y la persona seleccionada.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected async setActive(
    schedule: WorkScheduleRecord,
    active: boolean,
  ): Promise<void> {
    try {
      await this.pb.collection('work_schedules').update(schedule.id, { active });
      this.success.set(active ? 'Horario activado.' : 'Horario archivado.');
      await this.load();
    } catch {
      this.error.set('No se pudo modificar el horario.');
    }
  }

  protected weekdayNames(days: number[]): string {
    const labels: Record<number, string> = {
      0: 'D',
      1: 'L',
      2: 'M',
      3: 'X',
      4: 'J',
      5: 'V',
      6: 'S',
    };
    return days.map((day) => labels[day]).join(' · ');
  }

  protected formatDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(value));
  }

  private async initialize(): Promise<void> {
    if (this.canManage()) {
      try {
        const users = await this.pb.collection('users').getFullList({
          sort: 'name',
          filter: 'active = true',
          fields: 'id,name,employeeCode,role',
        });
        this.members.set(users as UserRecord[]);
        this.employee = users[0]?.id ?? '';
      } catch {
        this.error.set('No se pudo cargar el equipo.');
      }
    }
    await this.load();
  }

  private today(): string {
    const date = new Date();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
}
