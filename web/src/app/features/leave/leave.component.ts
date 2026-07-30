import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  availableLeaveDays,
  countRequestedDays,
  findLeaveConflicts,
  normalizeLeaveAllowance,
  type LeaveConflict,
  type LeaveConflictStatus,
} from '../../core/leave-calculations';
import {
  LeaveBalanceRecord,
  LeaveBlackoutRecord,
  LeaveRequestRecord,
  LeaveStatus,
  LeaveTypeRecord,
  PublicHolidayRecord,
  UserRecord,
  WorkScheduleRecord,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

interface CalendarCell {
  date: Date;
  key: string;
  inMonth: boolean;
  requests: LeaveRequestRecord[];
  holiday?: PublicHolidayRecord;
}

interface LeaveConflictGroups {
  approved: LeaveConflict[];
  pending: LeaveConflict[];
}

const EMPTY_CONFLICT_GROUPS: LeaveConflictGroups = {
  approved: [],
  pending: [],
};

@Component({
  selector: 'app-leave',
  imports: [FormsModule],
  templateUrl: './leave.component.html',
})
export class LeaveComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly requests = signal<LeaveRequestRecord[]>([]);
  protected readonly leaveTypes = signal<LeaveTypeRecord[]>([]);
  protected readonly balances = signal<LeaveBalanceRecord[]>([]);
  protected readonly blackouts = signal<LeaveBlackoutRecord[]>([]);
  protected readonly holidays = signal<PublicHolidayRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly schedules = signal<WorkScheduleRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly assigning = signal(false);
  protected readonly savingAllowance = signal('');
  protected readonly view = signal<'requests' | 'calendar' | 'settings'>('requests');
  protected readonly calendarMonth = signal(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly isAdmin = computed(() => this.auth.user()?.role === 'admin');
  protected readonly pendingCount = computed(
    () => this.requests().filter((request) => request.status === 'pending').length,
  );
  protected readonly requestConflicts = computed(() => {
    const conflictsByRequest = new Map<string, LeaveConflictGroups>();
    if (!this.canManage()) return conflictsByRequest;

    const requests = this.requests();
    for (const request of requests) {
      if (request.status !== 'pending') continue;
      const groups: LeaveConflictGroups = { approved: [], pending: [] };
      for (const conflict of findLeaveConflicts(request, requests)) {
        groups[conflict.status].push(conflict);
      }
      conflictsByRequest.set(request.id, groups);
    }
    return conflictsByRequest;
  });

  protected employee = '';
  protected leaveType = '';
  protected startDate = '';
  protected endDate = '';
  protected dayPart: LeaveRequestRecord['dayPart'] = 'full';
  protected reason = '';
  protected attachment: File | null = null;

  protected newTypeName = '';
  protected newTypeCode = '';
  protected newTypeColor = '#f97360';
  protected newTypeAllowance = 0;
  protected newTypeDeducts = false;
  protected newTypeApproval = true;
  protected newTypeRequiresDocument = false;
  protected blackoutName = '';
  protected blackoutStart = '';
  protected blackoutEnd = '';
  protected blackoutLeaveType = '';
  protected holidayName = '';
  protected holidayDate = '';
  protected balanceYear = new Date().getFullYear();

  protected editableBalances(): LeaveBalanceRecord[] {
    return this.balances()
      .filter((balance) => balance.year === Number(this.balanceYear))
      .sort(
        (left, right) =>
          (left.expand?.employee?.name ?? '').localeCompare(
            right.expand?.employee?.name ?? '',
            'es',
          ) ||
          (left.expand?.leaveType?.name ?? '').localeCompare(
            right.expand?.leaveType?.name ?? '',
            'es',
          ),
      );
  }

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [types, requests, balances, blackouts, holidays, members, schedules] =
        await Promise.all([
          this.pb.collection('leave_types').getFullList({
            sort: 'name',
            filter: 'active = true',
          }),
          this.pb.collection('leave_requests').getFullList({
            sort: '-created',
            expand: 'employee,leaveType',
          }),
          this.pb.collection('leave_balances').getFullList({
            sort: 'year',
            expand: 'employee,leaveType',
          }),
          this.pb.collection('leave_blackout_periods').getFullList({
            sort: 'startDate',
            expand: 'leaveType',
          }),
          this.pb.collection('public_holidays').getFullList({ sort: 'date' }),
          this.canManage()
            ? this.pb.collection('users').getFullList({
                sort: 'name',
                filter: 'active = true',
                fields: 'id,name,employeeCode,role',
              })
            : Promise.resolve([]),
          this.pb.collection('work_schedules').getFullList({
            sort: '-validFrom',
            filter: 'active = true',
          }),
        ]);
      this.leaveTypes.set(types as LeaveTypeRecord[]);
      this.requests.set(requests as LeaveRequestRecord[]);
      this.balances.set(balances as LeaveBalanceRecord[]);
      this.blackouts.set(blackouts as LeaveBlackoutRecord[]);
      this.holidays.set(holidays as PublicHolidayRecord[]);
      this.members.set(members as UserRecord[]);
      this.schedules.set(schedules as WorkScheduleRecord[]);
      this.leaveType ||=
        (types as LeaveTypeRecord[]).find((type) => type.code === 'vacation')?.id ??
        (types[0] as LeaveTypeRecord | undefined)?.id ??
        '';
      this.employee ||= this.canManage()
        ? ((members[0] as UserRecord | undefined)?.id ?? user.id)
        : user.id;
    } catch {
      this.error.set('No se ha podido cargar la gestión de ausencias.');
    } finally {
      this.loading.set(false);
    }
  }

  protected openRequest(assign = false): void {
    this.assigning.set(assign);
    this.formOpen.set(true);
    this.error.set('');
    this.success.set('');
    if (!assign) this.employee = this.auth.user()?.id ?? '';
  }

  protected requestedDays(): number {
    return countRequestedDays(
      this.startDate,
      this.endDate,
      this.dayPart,
      this.holidays().map((holiday) => holiday.date),
      this.schedules(),
      this.employee,
    );
  }

  protected async createRequest(): Promise<void> {
    const user = this.auth.user();
    const type = this.leaveTypes().find((item) => item.id === this.leaveType);
    if (!user || !type || !this.employee) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const data = new FormData();
      data.set('organization', user.organization);
      data.set('employee', this.employee);
      data.set('type', type.code);
      data.set('leaveType', type.id);
      data.set('startDate', new Date(`${this.startDate}T00:00:00`).toISOString());
      data.set('endDate', new Date(`${this.endDate}T23:59:59`).toISOString());
      data.set('dayPart', this.dayPart);
      data.set('requestedDays', String(this.requestedDays()));
      data.set('reason', this.reason);
      data.set('status', this.assigning() ? 'approved' : 'pending');
      data.set('assignedBy', this.assigning() ? user.id : '');
      if (this.attachment) data.set('attachment', this.attachment);
      await this.pb.collection('leave_requests').create(data);
      this.formOpen.set(false);
      const assigned = this.assigning();
      this.resetForm();
      this.success.set(
        assigned
          ? 'Ausencia asignada y aprobada.'
          : 'Solicitud enviada. Recibirás un aviso cuando se resuelva.',
      );
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo crear la ausencia.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected onAttachment(event: Event): void {
    this.attachment = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  protected selectedType(): LeaveTypeRecord | undefined {
    return this.leaveTypes().find((type) => type.id === this.leaveType);
  }

  protected async openAttachment(request: LeaveRequestRecord): Promise<void> {
    if (!request.attachment) return;
    try {
      const token = await this.pb.files.getToken();
      const url = this.pb.files.getURL(request, request.attachment, { token });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      this.error.set('No se pudo abrir el documento justificativo.');
    }
  }

  protected async resolve(
    request: LeaveRequestRecord,
    status: 'approved' | 'rejected',
  ): Promise<void> {
    this.error.set('');
    try {
      await this.pb.collection('leave_requests').update(request.id, {
        status,
        response:
          status === 'approved'
            ? 'Solicitud aprobada.'
            : 'Solicitud rechazada por la persona responsable.',
      });
      this.success.set(status === 'approved' ? 'Ausencia aprobada.' : 'Solicitud rechazada.');
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo resolver la solicitud.'));
    }
  }

  protected async cancel(request: LeaveRequestRecord): Promise<void> {
    try {
      await this.pb.collection('leave_requests').update(request.id, {
        status: 'cancelled',
      });
      this.success.set('Solicitud cancelada.');
      await this.load();
    } catch {
      this.error.set('No se pudo cancelar la solicitud.');
    }
  }

  protected async createLeaveType(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const type = (await this.pb.collection('leave_types').create({
        organization: user.organization,
        code: this.newTypeCode.trim().toLowerCase().replaceAll(/\s+/g, '_'),
        name: this.newTypeName,
        color: this.newTypeColor,
        deductsBalance: this.newTypeDeducts,
        requiresApproval: this.newTypeApproval,
        requiresDocument: this.newTypeRequiresDocument,
        active: true,
      })) as LeaveTypeRecord;
      if (this.newTypeDeducts && this.newTypeAllowance > 0) {
        for (const member of this.members()) {
          await this.pb.collection('leave_balances').create({
            organization: user.organization,
            employee: member.id,
            leaveType: type.id,
            year: new Date().getFullYear(),
            allowance: this.newTypeAllowance,
            carriedOver: 0,
            adjustment: 0,
          });
        }
      }
      this.newTypeName = '';
      this.newTypeCode = '';
      this.success.set('Tipo de ausencia creado.');
      await this.load();
    } catch {
      this.error.set('No se pudo crear el tipo de ausencia.');
    }
  }

  protected async createBlackout(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.pb.collection('leave_blackout_periods').create({
        organization: user.organization,
        leaveType: this.blackoutLeaveType,
        name: this.blackoutName,
        startDate: new Date(`${this.blackoutStart}T00:00:00`).toISOString(),
        endDate: new Date(`${this.blackoutEnd}T23:59:59`).toISOString(),
        reason: 'Período bloqueado por planificación.',
      });
      this.blackoutName = '';
      this.blackoutStart = '';
      this.blackoutEnd = '';
      this.success.set('Período bloqueado creado.');
      await this.load();
    } catch {
      this.error.set('No se pudo crear el período bloqueado.');
    }
  }

  protected async createHoliday(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.pb.collection('public_holidays').create({
        organization: user.organization,
        name: this.holidayName,
        date: new Date(`${this.holidayDate}T12:00:00`).toISOString(),
      });
      this.holidayName = '';
      this.holidayDate = '';
      this.success.set('Festivo añadido al calendario.');
      await this.load();
    } catch {
      this.error.set('No se pudo guardar el festivo.');
    }
  }

  protected async adjustBalance(balance: LeaveBalanceRecord, amount: number): Promise<void> {
    try {
      await this.pb.collection('leave_balances').update(balance.id, {
        adjustment: balance.adjustment + amount,
      });
      this.success.set('Saldo ajustado.');
      await this.load();
    } catch {
      this.error.set('No se pudo ajustar el saldo.');
    }
  }

  protected async saveAllowance(
    balance: LeaveBalanceRecord,
    rawAllowance: number | string,
  ): Promise<void> {
    const allowance = normalizeLeaveAllowance(rawAllowance);
    if (allowance === null) {
      this.error.set(
        'El cupo anual debe estar entre 0 y 366 días, en días completos o medios días.',
      );
      return;
    }
    if (allowance === balance.allowance || this.savingAllowance()) return;

    this.savingAllowance.set(balance.id);
    this.error.set('');
    this.success.set('');
    try {
      const updated = (await this.pb
        .collection('leave_balances')
        .update(balance.id, { allowance })) as LeaveBalanceRecord;
      updated.expand = balance.expand;
      this.balances.update((items) =>
        items.map((item) => (item.id === balance.id ? updated : item)),
      );
      this.success.set(
        `Cupo anual de ${balance.expand?.employee?.name ?? 'la persona'} actualizado a ${allowance} días.`,
      );
    } catch {
      this.error.set('No se pudo actualizar el cupo anual.');
    } finally {
      this.savingAllowance.set('');
    }
  }

  protected balanceAvailable(balance: LeaveBalanceRecord): number {
    const used = this.requests()
      .filter(
        (request) =>
          request.employee === balance.employee &&
          request.leaveType === balance.leaveType &&
          request.status === 'approved' &&
          new Date(request.startDate).getFullYear() === balance.year,
      )
      .reduce((total, request) => total + request.requestedDays, 0);
    return availableLeaveDays(balance.allowance, balance.carriedOver, balance.adjustment, used);
  }

  protected typeFor(request: LeaveRequestRecord): LeaveTypeRecord | undefined {
    return (
      request.expand?.leaveType ??
      this.leaveTypes().find((type) => type.id === request.leaveType || type.code === request.type)
    );
  }

  protected conflictsFor(request: LeaveRequestRecord): LeaveConflictGroups {
    return this.requestConflicts().get(request.id) ?? EMPTY_CONFLICT_GROUPS;
  }

  protected conflictTitle(status: LeaveConflictStatus, count: number): string {
    if (status === 'approved') {
      return count === 1
        ? '1 ausencia aprobada coincidente'
        : `${count} ausencias aprobadas coincidentes`;
    }
    return count === 1
      ? '1 solicitud pendiente coincidente'
      : `${count} solicitudes pendientes coincidentes`;
  }

  protected conflictDateRange(conflict: LeaveConflict): string {
    const start = this.formatDateKey(conflict.overlapStart);
    return conflict.overlapStart === conflict.overlapEnd
      ? start
      : `${start} — ${this.formatDateKey(conflict.overlapEnd)}`;
  }

  protected statusLabel(status: LeaveStatus): string {
    return {
      pending: 'Pendiente',
      approved: 'Aprobada',
      rejected: 'Rechazada',
      cancelled: 'Cancelada',
    }[status];
  }

  protected formatDate(value: string): string {
    return this.formatDateKey(value.slice(0, 10));
  }

  private formatDateKey(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(`${value}T12:00:00`));
  }

  protected monthLabel(): string {
    return new Intl.DateTimeFormat('es-ES', {
      month: 'long',
      year: 'numeric',
    }).format(this.calendarMonth());
  }

  protected moveMonth(offset: number): void {
    const current = this.calendarMonth();
    this.calendarMonth.set(new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  protected calendarCells(): CalendarCell[] {
    const month = this.calendarMonth();
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const start = new Date(first);
    start.setDate(start.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = this.localDateKey(date);
      return {
        date,
        key,
        inMonth: date.getMonth() === month.getMonth(),
        requests: this.requests().filter(
          (request) =>
            request.status !== 'rejected' &&
            request.status !== 'cancelled' &&
            key >= request.startDate.slice(0, 10) &&
            key <= request.endDate.slice(0, 10),
        ),
        holiday: this.holidays().find((holiday) => holiday.date.slice(0, 10) === key),
      };
    });
  }

  private resetForm(): void {
    this.startDate = '';
    this.endDate = '';
    this.dayPart = 'full';
    this.reason = '';
    this.attachment = null;
    this.assigning.set(false);
  }

  private localDateKey(date: Date): string {
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  private apiMessage(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'message' in error.response
    ) {
      return String(error.response.message || fallback);
    }
    return fallback;
  }
}
