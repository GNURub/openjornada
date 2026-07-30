import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { UserRecord, UserRole } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

interface NewMember {
  name: string;
  email: string;
  employeeCode: string;
  jobTitle: string;
  weeklyHours: number;
  employmentType: UserRecord['employmentType'];
  contractedWeeklyMinutes: number;
  complementaryHoursAgreement: boolean;
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
  protected readonly auth = inject(AuthService);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly inviting = signal('');
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly toast = signal<{ type: 'success' | 'error'; message: string } | null>(null);
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
      this.members.set(records as UserRecord[]);
    } catch {
      this.error.set('No se ha podido cargar el equipo.');
    } finally {
      this.loading.set(false);
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
      this.success.set('Los permisos se han actualizado.');
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
      role: 'employee',
      password: '',
    };
  }
}
