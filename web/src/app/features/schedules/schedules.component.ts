import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { UserRecord, WorkScheduleRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import {
  workScheduleStatus,
  type WorkScheduleStatus,
} from '../../core/schedule-status';

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
  protected readonly peoplePickerOpen = signal(false);
  protected readonly memberSearch = signal('');
  protected readonly selectedEmployeeIds = signal<string[]>([]);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly filteredMembers = computed(() => {
    const query = this.memberSearch().trim().toLocaleLowerCase('es');
    if (!query) return this.members();
    return this.members().filter((member) =>
      [member.name, member.employeeCode, member.jobTitle]
        .join(' ')
        .toLocaleLowerCase('es')
        .includes(query),
    );
  });
  protected readonly selectedMembers = computed(() => {
    const selected = new Set(this.selectedEmployeeIds());
    return this.members().filter((member) => selected.has(member.id));
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

  protected openForm(): void {
    this.formOpen.set(true);
    this.peoplePickerOpen.set(false);
    this.memberSearch.set('');
    this.selectedEmployeeIds.set([]);
    this.error.set('');
    this.success.set('');
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.peoplePickerOpen.set(false);
    this.memberSearch.set('');
    this.selectedEmployeeIds.set([]);
  }

  protected toggleEmployee(employeeId: string): void {
    this.selectedEmployeeIds.update((selected) =>
      selected.includes(employeeId)
        ? selected.filter((id) => id !== employeeId)
        : [...selected, employeeId],
    );
  }

  protected removeEmployee(employeeId: string): void {
    this.selectedEmployeeIds.update((selected) =>
      selected.filter((id) => id !== employeeId),
    );
  }

  protected selectVisibleEmployees(): void {
    const selected = new Set(this.selectedEmployeeIds());
    for (const member of this.filteredMembers()) selected.add(member.id);
    this.selectedEmployeeIds.set([...selected]);
  }

  protected clearEmployees(): void {
    this.selectedEmployeeIds.set([]);
  }

  protected isEmployeeSelected(employeeId: string): boolean {
    return this.selectedEmployeeIds().includes(employeeId);
  }

  protected async createSchedule(): Promise<void> {
    const user = this.auth.user();
    const employeeIds = this.selectedEmployeeIds();
    if (!user || employeeIds.length === 0) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const response = await this.pb.send<{ total: number }>(
        '/api/openjornada/work-schedules/bulk',
        {
          method: 'POST',
          body: {
            employeeIds,
            name: this.name,
            validFrom: this.validFrom,
            validUntil: this.validUntil,
            weekdays: this.weekdays,
            startTime: this.startTime,
            endTime: this.endTime,
            breakMinutes: this.breakMinutes,
          },
        },
      );
      this.closeForm();
      this.success.set(
        response.total === 1
          ? 'Horario asignado correctamente.'
          : `Horario asignado a ${response.total} personas.`,
      );
      await this.load();
    } catch (error) {
      this.error.set(
        this.responseMessage(
          error,
          'No se pudo guardar el horario. Comprueba las horas y las personas seleccionadas.',
        ),
      );
    } finally {
      this.saving.set(false);
    }
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

  protected scheduleStatus(
    schedule: WorkScheduleRecord,
  ): WorkScheduleStatus {
    return workScheduleStatus(schedule);
  }

  protected scheduleStatusLabel(schedule: WorkScheduleRecord): string {
    const labels = {
      active: 'Activo',
      upcoming: 'Próximo',
      finished: 'Finalizado',
      archived: 'Archivado',
    } as const;
    return labels[this.scheduleStatus(schedule)];
  }

  private async initialize(): Promise<void> {
    if (this.canManage()) {
      try {
        const users = await this.pb.collection('users').getFullList({
          sort: 'name',
          filter: 'active = true',
          fields: 'id,name,employeeCode,role,jobTitle',
        });
        this.members.set(users as UserRecord[]);
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
