import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import PocketBase, { ClientResponseError, LocalAuthStore, RecordModel } from 'pocketbase';
import { resolveApiUrl } from './pocketbase.service';

export interface PlatformOperator extends RecordModel {
  name: string;
  email: string;
  role: 'admin' | 'support';
  active: boolean;
}

@Injectable({ providedIn: 'root' })
export class PlatformAuthService {
  private readonly router = inject(Router);
  readonly client = new PocketBase(
    resolveApiUrl(),
    new LocalAuthStore('openjornada_platform_auth'),
  );
  readonly operator = signal<PlatformOperator | null>(
    this.client.authStore.record as PlatformOperator | null,
  );
  readonly loading = signal(false);
  readonly error = signal('');
  readonly otpRequired = signal(false);
  readonly authenticated = computed(
    () => Boolean(this.operator()) && this.client.authStore.isValid,
  );
  readonly canWrite = computed(() => this.operator()?.role === 'admin');

  private mfaId = '';
  private otpId = '';

  constructor() {
    this.client.autoCancellation(false);
    this.client.authStore.onChange((_token, record) => {
      this.operator.set(record as PlatformOperator | null);
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.client.authStore.isValid) return;
    try {
      await this.client.collection('platform_operators').authRefresh();
    } catch {
      this.client.authStore.clear();
    }
  }

  async login(email: string, password: string): Promise<boolean> {
    this.loading.set(true);
    this.error.set('');
    try {
      await this.client.collection('platform_operators').authWithPassword(email.trim(), password);
      await this.router.navigateByUrl('/proveedor');
      return true;
    } catch (error) {
      const mfaId = this.responseString(error, 'mfaId');
      if (error instanceof ClientResponseError && error.status === 401 && mfaId) {
        try {
          const otp = await this.client.collection('platform_operators').requestOTP(email.trim());
          this.mfaId = mfaId;
          this.otpId = otp.otpId;
          this.otpRequired.set(true);
          return false;
        } catch {
          this.error.set('No se pudo enviar el código de un solo uso.');
          return false;
        }
      }
      this.error.set(
        error instanceof ClientResponseError && error.status === 0
          ? 'No se puede conectar con el servidor.'
          : 'El correo o la contraseña no son correctos.',
      );
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  async verifyOtp(code: string): Promise<boolean> {
    if (!this.mfaId || !this.otpId) return false;
    this.loading.set(true);
    this.error.set('');
    try {
      await this.client.collection('platform_operators').authWithOTP(this.otpId, code.trim(), {
        query: { mfaId: this.mfaId },
      });
      this.clearMfa();
      await this.router.navigateByUrl('/proveedor');
      return true;
    } catch {
      this.error.set('El código no es válido o ha caducado.');
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  cancelOtp(): void {
    this.clearMfa();
    this.error.set('');
  }

  async logout(): Promise<void> {
    this.client.authStore.clear();
    this.clearMfa();
    await this.router.navigateByUrl('/proveedor/login');
  }

  private clearMfa(): void {
    this.mfaId = '';
    this.otpId = '';
    this.otpRequired.set(false);
  }

  private responseString(error: unknown, field: string): string {
    if (!(error instanceof ClientResponseError)) return '';
    const value = (error.response as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : '';
  }
}
