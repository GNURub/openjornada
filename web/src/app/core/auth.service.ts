import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ClientResponseError } from 'pocketbase';
import { BrandingService } from './branding.service';
import { UserRecord } from './models';
import { PocketBaseService } from './pocketbase.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly pb = inject(PocketBaseService).client;
  private readonly router = inject(Router);
  private readonly branding = inject(BrandingService);

  readonly user = signal<UserRecord | null>(this.pb.authStore.record as UserRecord | null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly authenticated = computed(() => Boolean(this.user()));
  readonly canManageTeam = computed(() => {
    const role = this.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  readonly canViewReports = computed(() => {
    const role = this.user()?.role;
    return role === 'admin' || role === 'manager' || role === 'representative';
  });

  constructor() {
    this.pb.authStore.onChange((_token, record) => {
      const user = record as UserRecord | null;
      this.user.set(user);
      void this.branding.syncForOrganization(user?.organization ?? null);
    });
    void this.branding.syncForOrganization(this.user()?.organization ?? null);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.pb.authStore.isValid) {
      return;
    }
    try {
      await this.pb.collection('users').authRefresh();
    } catch {
      this.pb.authStore.clear();
    }
  }

  async login(email: string, password: string): Promise<boolean> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.pb.collection('users').authWithPassword(email.trim(), password);
      await this.router.navigateByUrl('/');
      return true;
    } catch (error) {
      const message =
        error instanceof ClientResponseError && error.status === 0
          ? 'No se puede conectar con el servidor.'
          : 'El correo o la contraseña no son correctos.';
      this.error.set(message);
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  async requestPasswordReset(email: string): Promise<boolean> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.pb.collection('users').requestPasswordReset(email.trim());
      return true;
    } catch {
      this.error.set('No se pudo enviar el correo. Inténtalo de nuevo.');
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  async logout(): Promise<void> {
    this.pb.authStore.clear();
    await this.router.navigateByUrl('/login');
  }
}
