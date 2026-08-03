import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  availableLeaveDays,
  countRequestedDays,
  findLeaveConflicts,
  hasConfiguredLeaveDays,
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
import { normalizeLeaveDateKey, pocketBaseDateBoundary } from '../../core/pocketbase-date';

interface CalendarCell {
  date: Date;
  key: string;
  inMonth: boolean;
  requests: LeaveRequestRecord[];
  holiday?: PublicHolidayRecord;
}

interface YearMonth {
  date: Date;
  label: string;
  cells: CalendarCell[];
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
  protected readonly resolvingRequest = signal('');
  protected readonly cancellingRequest = signal('');
  protected readonly savingHoliday = signal('');
  protected readonly editingHoliday = signal('');
  protected readonly pendingHolidayDeletion = signal('');
  protected readonly requestStatusFilter = signal<'all' | LeaveStatus>('all');
  protected readonly view = signal<'requests' | 'management' | 'calendar' | 'settings'>('requests');
  protected readonly calendarMonth = signal(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  protected readonly calendarYear = signal(new Date().getFullYear());
  protected readonly datePickerOpen = signal(false);
  protected readonly datePickerMonth = signal(
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
  protected holidayYear = new Date().getFullYear();
  protected balanceYear = new Date().getFullYear();
  protected requestSearch = '';

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

  protected holidaysForYear(): PublicHolidayRecord[] {
    return this.holidays()
      .filter((holiday) => Number(this.holidayDateKey(holiday).slice(0, 4)) === this.holidayYear)
      .sort((left, right) => this.holidayDateKey(left).localeCompare(this.holidayDateKey(right)));
  }

  protected visibleBalances(): LeaveBalanceRecord[] {
    return this.balances().filter((balance) =>
      hasConfiguredLeaveDays(balance.allowance, balance.carriedOver, balance.adjustment),
    );
  }

  protected overviewBalances(): LeaveBalanceRecord[] {
    const userId = this.auth.user()?.id;
    const own = this.visibleBalances().filter((balance) => balance.employee === userId);
    return (own.length ? own : this.visibleBalances()).filter(
      (balance) => balance.year === this.calendarYear(),
    );
  }

  protected overviewRequests(): LeaveRequestRecord[] {
    return this.requests()
      .filter((request) => Number(request.startDate.slice(0, 4)) === this.calendarYear())
      .sort(
        (left, right) => new Date(right.startDate).getTime() - new Date(left.startDate).getTime(),
      );
  }

  protected reviewRequests(): LeaveRequestRecord[] {
    if (!this.canManage()) return [];
    return this.requests().filter((request) => request.status === 'pending');
  }

  protected managementRequests(): LeaveRequestRecord[] {
    if (!this.canManage()) return [];
    const status = this.requestStatusFilter();
    const search = this.requestSearch.trim().toLocaleLowerCase('es');
    return this.requests().filter((request) => {
      if (status !== 'all' && request.status !== status) return false;
      if (!search) return true;
      return [
        request.expand?.employee?.name,
        request.expand?.employee?.employeeCode,
        this.typeFor(request)?.name,
        request.reason,
        request.response,
      ].some((value) => value?.toLocaleLowerCase('es').includes(search));
    });
  }

  protected requestStatusCount(status: LeaveStatus): number {
    return this.requests().filter((request) => request.status === status).length;
  }

  protected requestableLeaveTypes(): LeaveTypeRecord[] {
    const year = new Date().getUTCFullYear();
    return this.leaveTypes().filter((type) => {
      if (!type.deductsBalance) return true;
      const balance = this.balances().find(
        (item) =>
          item.employee === this.employee && item.leaveType === type.id && item.year === year,
      );
      return Boolean(
        balance &&
        hasConfiguredLeaveDays(balance.allowance, balance.carriedOver, balance.adjustment),
      );
    });
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
                fields: 'id,name,employeeCode,role,scheduleMode,flexibleWeekdays',
              })
            : Promise.resolve([]),
          this.pb.collection('work_schedules').getFullList({
            sort: '-validFrom',
            filter: 'active = true',
          }),
        ]);
      this.leaveTypes.set(types as LeaveTypeRecord[]);
      this.requests.set(
        (requests as LeaveRequestRecord[]).map((request) => ({
          ...request,
          startDate: pocketBaseDateBoundary(
            normalizeLeaveDateKey(request.startDate, 'start'),
            'start',
          ),
          endDate: pocketBaseDateBoundary(normalizeLeaveDateKey(request.endDate, 'end'), 'end'),
        })),
      );
      this.balances.set(balances as LeaveBalanceRecord[]);
      this.blackouts.set(blackouts as LeaveBlackoutRecord[]);
      this.holidays.set(holidays as PublicHolidayRecord[]);
      this.members.set(members as UserRecord[]);
      this.schedules.set(schedules as WorkScheduleRecord[]);
      this.employee ||= this.canManage()
        ? ((members[0] as UserRecord | undefined)?.id ?? user.id)
        : user.id;
      this.ensureRequestableLeaveType();
    } catch {
      this.error.set('No se ha podido cargar la gestión de ausencias.');
    } finally {
      this.loading.set(false);
    }
  }

  protected openRequest(assign = false): void {
    this.assigning.set(assign);
    this.formOpen.set(true);
    this.datePickerOpen.set(false);
    this.error.set('');
    this.success.set('');
    if (!assign) this.employee = this.auth.user()?.id ?? '';
    this.ensureRequestableLeaveType();
  }

  protected selectView(view: 'requests' | 'management' | 'calendar' | 'settings'): void {
    this.view.set(view);
    window.scrollTo({ top: 0, left: 0 });
  }

  protected closeRequest(): void {
    if (this.saving()) return;
    this.formOpen.set(false);
    this.datePickerOpen.set(false);
    this.resetForm();
  }

  protected closeRequestFromBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeRequest();
  }

  protected setRequestEmployee(employeeId: string): void {
    this.employee = employeeId;
    this.ensureRequestableLeaveType();
  }

  protected requestedDays(): number {
    const selectedEmployee =
      this.members().find((member) => member.id === this.employee) ??
      (this.auth.user()?.id === this.employee ? this.auth.user() : undefined);
    return countRequestedDays(
      this.startDate,
      this.endDate,
      this.dayPart,
      this.holidays().map((holiday) => holiday.date),
      this.schedules(),
      this.employee,
      selectedEmployee?.scheduleMode ?? 'scheduled',
      selectedEmployee?.flexibleWeekdays ?? [1, 2, 3, 4, 5],
    );
  }

  protected async createRequest(): Promise<void> {
    const user = this.auth.user();
    const type = this.requestableLeaveTypes().find((item) => item.id === this.leaveType);
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
      data.set('startDate', pocketBaseDateBoundary(this.startDate, 'start'));
      data.set('endDate', pocketBaseDateBoundary(this.endDate, 'end'));
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
    return this.requestableLeaveTypes().find((type) => type.id === this.leaveType);
  }

  protected selectedEmployeeName(): string {
    if (!this.assigning()) return this.auth.user()?.name ?? 'Mi ausencia';
    return this.members().find((member) => member.id === this.employee)?.name ?? 'Persona';
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
    if (this.resolvingRequest()) return;
    this.resolvingRequest.set(request.id);
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
    } finally {
      this.resolvingRequest.set('');
    }
  }

  protected async cancel(request: LeaveRequestRecord): Promise<void> {
    if (this.cancellingRequest() || request.status !== 'pending') return;
    this.cancellingRequest.set(request.id);
    this.error.set('');
    this.success.set('');
    try {
      await this.pb.collection('leave_requests').update(request.id, {
        status: 'cancelled',
      });
      this.success.set('Solicitud cancelada.');
      await this.load();
    } catch {
      this.error.set('No se pudo cancelar la solicitud.');
    } finally {
      this.cancellingRequest.set('');
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
    const name = this.holidayName.trim();
    if (!user || !this.isAdmin() || !name || !this.holidayDate || this.savingHoliday()) return;
    const editingId = this.editingHoliday();
    this.savingHoliday.set(editingId || 'new');
    this.error.set('');
    this.success.set('');
    try {
      const payload = {
        name,
        date: new Date(`${this.holidayDate}T12:00:00`).toISOString(),
        scope: 'manual',
        source: '',
        sourceUrl: '',
        importProvider: '',
        importedAt: '',
      };
      if (editingId) {
        await this.pb.collection('public_holidays').update(editingId, payload);
      } else {
        await this.pb.collection('public_holidays').create({
          organization: user.organization,
          ...payload,
        });
      }
      this.resetHolidayForm();
      this.success.set(
        editingId ? 'Festivo actualizado en el calendario.' : 'Festivo añadido al calendario.',
      );
      await this.load();
    } catch {
      this.error.set('No se pudo guardar el festivo.');
    } finally {
      this.savingHoliday.set('');
    }
  }

  protected editHoliday(holiday: PublicHolidayRecord): void {
    if (this.savingHoliday()) return;
    this.editingHoliday.set(holiday.id);
    this.pendingHolidayDeletion.set('');
    this.holidayName = holiday.name;
    this.holidayDate = this.holidayDateKey(holiday);
  }

  protected cancelHolidayEdit(): void {
    if (this.savingHoliday()) return;
    this.resetHolidayForm();
  }

  protected requestHolidayDeletion(holiday: PublicHolidayRecord): void {
    if (this.savingHoliday()) return;
    this.pendingHolidayDeletion.set(holiday.id);
  }

  protected cancelHolidayDeletion(): void {
    this.pendingHolidayDeletion.set('');
  }

  protected async deleteHoliday(holiday: PublicHolidayRecord): Promise<void> {
    if (!this.isAdmin() || this.savingHoliday() || this.pendingHolidayDeletion() !== holiday.id) {
      return;
    }
    this.savingHoliday.set(holiday.id);
    this.error.set('');
    this.success.set('');
    try {
      await this.pb.collection('public_holidays').delete(holiday.id);
      if (this.editingHoliday() === holiday.id) this.resetHolidayForm();
      this.pendingHolidayDeletion.set('');
      this.holidays.update((items) => items.filter((item) => item.id !== holiday.id));
      this.success.set('Festivo eliminado del calendario.');
    } catch {
      this.error.set('No se pudo eliminar el festivo.');
    } finally {
      this.savingHoliday.set('');
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
      this.ensureRequestableLeaveType();
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
    return availableLeaveDays(
      balance.allowance,
      balance.carriedOver,
      balance.adjustment,
      this.balanceApproved(balance),
    );
  }

  protected balanceGenerated(balance: LeaveBalanceRecord): number {
    return balance.allowance + balance.carriedOver + balance.adjustment;
  }

  protected balanceApproved(balance: LeaveBalanceRecord): number {
    return this.requests()
      .filter(
        (request) =>
          request.employee === balance.employee &&
          request.leaveType === balance.leaveType &&
          request.status === 'approved' &&
          new Date(request.startDate).getFullYear() === balance.year,
      )
      .reduce((total, request) => total + request.requestedDays, 0);
  }

  private ensureRequestableLeaveType(): void {
    const types = this.requestableLeaveTypes();
    if (types.some((type) => type.id === this.leaveType)) return;
    this.leaveType = types.find((type) => type.code === 'vacation')?.id ?? types[0]?.id ?? '';
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

  protected dayPartLabel(dayPart: LeaveRequestRecord['dayPart']): string {
    return {
      full: 'Día completo',
      morning: 'Sólo mañana',
      afternoon: 'Sólo tarde',
    }[dayPart];
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
    return this.buildMonthCells(this.calendarMonth());
  }

  protected annualMonths(): YearMonth[] {
    return Array.from({ length: 12 }, (_, monthIndex) => {
      const date = new Date(this.calendarYear(), monthIndex, 1);
      return {
        date,
        label: new Intl.DateTimeFormat('es-ES', { month: 'long' }).format(date),
        cells: this.buildMonthCells(date),
      };
    });
  }

  protected moveYear(offset: number): void {
    this.calendarYear.update((year) => year + offset);
  }

  protected isToday(key: string): boolean {
    return key === this.localDateKey(new Date());
  }

  protected dayColor(cell: CalendarCell): string {
    const request = cell.requests[0];
    return request ? (this.typeFor(request)?.color ?? '#f97360') : '';
  }

  protected dateTileMonth(value: string): string {
    return new Intl.DateTimeFormat('es-ES', { month: 'short' })
      .format(new Date(`${value.slice(0, 10)}T12:00:00`))
      .replace('.', '')
      .toUpperCase();
  }

  protected dateTileDay(value: string): string {
    return String(new Date(`${value.slice(0, 10)}T12:00:00`).getDate());
  }

  protected requestYear(request: LeaveRequestRecord): number {
    return new Date(request.startDate).getFullYear();
  }

  protected requestDateRangeLabel(): string {
    if (!this.startDate) return 'Selecciona las fechas';
    if (!this.endDate || this.startDate === this.endDate) return this.formatDateKey(this.startDate);
    return `${this.formatDateKey(this.startDate)} — ${this.formatDateKey(this.endDate)}`;
  }

  protected toggleDatePicker(): void {
    if (!this.datePickerOpen()) {
      const reference = this.startDate ? new Date(`${this.startDate}T12:00:00`) : new Date();
      this.datePickerMonth.set(new Date(reference.getFullYear(), reference.getMonth(), 1));
    }
    this.datePickerOpen.update((open) => !open);
  }

  protected pickerMonthLabel(): string {
    return new Intl.DateTimeFormat('es-ES', {
      month: 'long',
      year: 'numeric',
    }).format(this.datePickerMonth());
  }

  protected movePickerMonth(offset: number): void {
    const current = this.datePickerMonth();
    this.datePickerMonth.set(new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  protected pickerCells(): CalendarCell[] {
    const month = this.datePickerMonth();
    const firstDayOffset = (new Date(month.getFullYear(), month.getMonth(), 1).getDay() + 6) % 7;
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    return this.buildMonthCells(month).slice(0, firstDayOffset + daysInMonth <= 35 ? 35 : 42);
  }

  protected selectPickerDate(key: string): void {
    if (!this.startDate || (this.startDate && this.endDate) || key < this.startDate) {
      this.startDate = key;
      this.endDate = '';
      return;
    }
    this.endDate = key;
    this.datePickerOpen.set(false);
  }

  protected isSelectedDate(key: string): boolean {
    return key === this.startDate || key === this.endDate;
  }

  protected isInSelectedRange(key: string): boolean {
    return Boolean(this.startDate && this.endDate && key > this.startDate && key < this.endDate);
  }

  protected updateStartDate(value: string): void {
    this.startDate = value;
    if (this.endDate && value > this.endDate) this.endDate = value;
  }

  protected updateEndDate(value: string): void {
    this.endDate = value;
    if (this.startDate && value < this.startDate) this.startDate = value;
    if (this.startDate && this.endDate) this.datePickerOpen.set(false);
  }

  private buildMonthCells(month: Date): CalendarCell[] {
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
    this.datePickerOpen.set(false);
    this.assigning.set(false);
  }

  private resetHolidayForm(): void {
    this.holidayName = '';
    this.holidayDate = '';
    this.editingHoliday.set('');
    this.pendingHolidayDeletion.set('');
  }

  private holidayDateKey(holiday: PublicHolidayRecord): string {
    return holiday.date.slice(0, 10);
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
