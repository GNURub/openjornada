import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { UserRecord, UserRole } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';
import { TerminalService } from '../../core/terminal.service';

interface NewMember {
  name: string;
  email: string;
  employeeCode: string;
  jobTitle: string;
  weeklyHours: number;
  employmentType: UserRecord['employmentType'];
  contractedWeeklyMinutes: number;
  complementaryHoursAgreement: boolean;
  scheduleMode: UserRecord['scheduleMode'];
  flexibleWeekdays: number[];
  role: UserRole;
  password: string;
}

interface InvitationResponse {
  userId: string;
  status: 'pending';
  sentAt: string;
  expiresAt: string;
}

type InvitationDisplayState = 'none' | 'pending' | 'expired' | 'accepted';

@Component({
  selector: 'app-team',
  imports: [FormsModule],
  templateUrl: './team.component.html',
})
export class TeamComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly terminals = inject(TerminalService);
  protected readonly auth = inject(AuthService);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly inviting = signal('');
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);
  protected readonly rfidTarget = signal<UserRecord | null>(null);
  protected readonly savingRfid = signal(false);
  protected rfidUid = '';
  protected newMember: NewMember = this.emptyMember();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const records = await this.pb.collection('users').getFullList({
        sort: 'name',
      });
      const members = records as UserRecord[];
      try {
        const statuses = await this.terminals.listEmployees();
        const byId = new Map(statuses.items.map((item) => [item.id, item.hasRfidTag]));
        this.members.set(
          members.map((member) => ({ ...member, hasRfidTag: byId.get(member.id) ?? false })),
        );
      } catch {
        this.members.set(members);
      }
    } catch {
      this.error.set('No se ha podido cargar el equipo.');
    } finally {
      this.loading.set(false);
    }
  }

  protected openRfid(member: UserRecord): void {
    this.rfidTarget.set(member);
    this.rfidUid = '';
    this.error.set('');
  }

  protected async saveRfid(): Promise<void> {
    const member = this.rfidTarget();
    if (!member || this.savingRfid()) return;
    if (!/^[0-9a-fA-F:\- ]{8,30}$/.test(this.rfidUid.trim())) {
      this.error.set('Introduce un UID RFID válido, por ejemplo 04:A1:B2:C3.');
      return;
    }
    if (member.hasRfidTag && !confirm(`¿Sustituir el tag actual de ${member.name}?`)) return;
    this.savingRfid.set(true);
    try {
      await this.terminals.assignEmployee(member.id, this.rfidUid, !!member.hasRfidTag);
      this.members.update((items) =>
        items.map((item) => (item.id === member.id ? { ...item, hasRfidTag: true } : item)),
      );
      this.rfidTarget.set(null);
      this.success.set(`Tag asignado a ${member.name}.`);
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo asignar el tag.'));
    } finally {
      this.savingRfid.set(false);
    }
  }

  protected async revokeRfid(member: UserRecord): Promise<void> {
    if (!confirm(`¿Revocar el tag de ${member.name}?`)) return;
    this.savingRfid.set(true);
    try {
      await this.terminals.revokeEmployee(member.id);
      this.members.update((items) =>
        items.map((item) => (item.id === member.id ? { ...item, hasRfidTag: false } : item)),
      );
      this.rfidTarget.set(null);
      this.success.set(`Tag revocado para ${member.name}.`);
    } catch (error) {
      this.error.set(this.errorMessage(error, 'No se pudo revocar el tag.'));
    } finally {
      this.savingRfid.set(false);
    }
  }

  protected async createMember(): Promise<void> {
    const organization = this.auth.user()?.organization;
    if (!organization) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const created = await this.pb.collection('users').create({
        ...this.newMember,
        passwordConfirm: this.newMember.password,
        organization,
        active: true,
      });
      this.members.update((members) =>
        [...members, created as UserRecord].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      );
      this.newMember = this.emptyMember();
      this.formOpen.set(false);
      this.success.set('Persona añadida. Ya puedes enviarle una invitación por correo.');
    } catch (error) {
      const data =
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        typeof error.response === 'object' &&
        error.response !== null &&
        'data' in error.response
          ? error.response.data
          : null;
      this.error.set(
        data && typeof data === 'object'
          ? 'Revisa el correo, el código y la contraseña.'
          : 'No se ha podido añadir a la persona.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected async sendInvitation(member: UserRecord): Promise<void> {
    if (this.inviting()) return;
    this.inviting.set(member.id);
    this.error.set('');
    this.success.set('');
    try {
      const invitation = await this.pb.send<InvitationResponse>(
        `/api/openjornada/team/${member.id}/invitation`,
        { method: 'POST' },
      );
      this.members.update((members) =>
        members.map((item) =>
          item.id === member.id
            ? {
                ...item,
                invitationStatus: invitation.status,
                invitationSentAt: invitation.sentAt,
                invitationExpiresAt: invitation.expiresAt,
                invitationAcceptedAt: '',
              }
            : item,
        ),
      );
      this.showToast(`Invitación enviada a ${member.email}.`, 'success');
    } catch (error) {
      this.showToast(
        this.errorMessage(error, 'No se pudo enviar la invitación. Revisa la configuración SMTP.'),
        'error',
      );
    } finally {
      this.inviting.set('');
    }
  }

  protected async updateMember(
    member: UserRecord,
    changes: Partial<
      Pick<
        UserRecord,
        | 'active'
        | 'role'
        | 'employmentType'
        | 'contractedWeeklyMinutes'
        | 'complementaryHoursAgreement'
        | 'scheduleMode'
        | 'flexibleWeekdays'
      >
    >,
  ): Promise<void> {
    this.error.set('');
    this.success.set('');
    try {
      const updated = await this.pb.collection('users').update(member.id, changes);
      this.members.update((members) =>
        members.map((item) => (item.id === member.id ? (updated as UserRecord) : item)),
      );
      this.success.set('La configuración de la persona se ha actualizado.');
    } catch {
      this.error.set('No se han podido actualizar los permisos.');
      await this.load();
    }
  }

  protected roleLabel(role: UserRole): string {
    return {
      admin: 'Administración',
      manager: 'Responsable',
      employee: 'Empleada',
      representative: 'Representante',
    }[role];
  }

  protected readonly weekdays = [
    { value: 1, label: 'L', name: 'lunes' },
    { value: 2, label: 'M', name: 'martes' },
    { value: 3, label: 'X', name: 'miércoles' },
    { value: 4, label: 'J', name: 'jueves' },
    { value: 5, label: 'V', name: 'viernes' },
    { value: 6, label: 'S', name: 'sábado' },
    { value: 0, label: 'D', name: 'domingo' },
  ] as const;

  protected updateNewWeeklyHours(hours: number): void {
    this.newMember.weeklyHours = hours;
    if (Number.isFinite(Number(hours))) {
      this.newMember.contractedWeeklyMinutes = Math.max(0, Math.round(Number(hours) * 60));
    }
  }

  protected toggleNewFlexibleWeekday(weekday: number): void {
    const selected = new Set(this.newMember.flexibleWeekdays);
    if (selected.has(weekday) && selected.size > 1) selected.delete(weekday);
    else selected.add(weekday);
    this.newMember.flexibleWeekdays = this.orderedWeekdays(selected);
  }

  protected toggleFlexibleWeekday(member: UserRecord, weekday: number): void {
    const selected = new Set(
      member.flexibleWeekdays?.length ? member.flexibleWeekdays : [1, 2, 3, 4, 5],
    );
    if (selected.has(weekday) && selected.size > 1) selected.delete(weekday);
    else selected.add(weekday);
    void this.updateMember(member, { flexibleWeekdays: this.orderedWeekdays(selected) });
  }

  protected contractedWeeklyHours(member: UserRecord): number {
    return (member.contractedWeeklyMinutes || 0) / 60;
  }

  protected formatContractedWeeklyHours(member: UserRecord): string {
    return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 }).format(
      this.contractedWeeklyHours(member),
    );
  }

  protected saveContractedHours(member: UserRecord, rawValue: string): void {
    const hours = Number(rawValue);
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 80) {
      this.error.set('Las horas semanales deben estar entre 0,25 y 80.');
      return;
    }
    void this.updateMember(member, { contractedWeeklyMinutes: Math.round(hours * 60) });
  }

  private orderedWeekdays(values: Set<number>): number[] {
    return [1, 2, 3, 4, 5, 6, 0].filter((weekday) => values.has(weekday));
  }

  protected invitationState(member: UserRecord): InvitationDisplayState {
    if (member.invitationStatus === 'accepted') return 'accepted';
    if (member.invitationStatus !== 'pending') return 'none';
    return new Date(member.invitationExpiresAt).getTime() <= Date.now() ? 'expired' : 'pending';
  }

  protected invitationDate(value: string): string {
    if (!value) return '';
    return new Intl.DateTimeFormat('es-ES', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  private showToast(message: string, type: 'success' | 'error'): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast.set({ message, type });
    this.toastTimer = setTimeout(() => this.toast.set(null), 6_000);
  }

  private errorMessage(error: unknown, fallback: string): string {
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

  private emptyMember(): NewMember {
    return {
      name: '',
      email: '',
      employeeCode: '',
      jobTitle: 'Esteticista',
      weeklyHours: 40,
      employmentType: 'full_time',
      contractedWeeklyMinutes: 2400,
      complementaryHoursAgreement: false,
      scheduleMode: 'scheduled',
      flexibleWeekdays: [1, 2, 3, 4, 5],
      role: 'employee',
      password: '',
    };
  }
}
