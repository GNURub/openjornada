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
  role: UserRole;
  password: string;
}

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
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected newMember: NewMember = this.emptyMember();

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
        [...members, created as UserRecord].sort((a, b) =>
          a.name.localeCompare(b.name, 'es'),
        ),
      );
      try {
        await this.pb
          .collection('users')
          .requestVerification(this.newMember.email);
      } catch {
        // The account remains usable after an administrator shares the password.
      }
      this.newMember = this.emptyMember();
      this.formOpen.set(false);
      this.success.set('Persona añadida. Se ha solicitado el correo de bienvenida.');
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

  protected async updateMember(
    member: UserRecord,
    changes: Partial<Pick<UserRecord, 'active' | 'role'>>,
  ): Promise<void> {
    this.error.set('');
    this.success.set('');
    try {
      const updated = await this.pb
        .collection('users')
        .update(member.id, changes);
      this.members.update((members) =>
        members.map((item) =>
          item.id === member.id ? (updated as UserRecord) : item,
        ),
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

  private emptyMember(): NewMember {
    return {
      name: '',
      email: '',
      employeeCode: '',
      jobTitle: 'Esteticista',
      weeklyHours: 40,
      role: 'employee',
      password: '',
    };
  }
}
