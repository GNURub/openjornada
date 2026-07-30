import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { UserRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

interface InvitationDetails {
  name: string;
  email: string;
  organization: string;
  expiresAt: string;
}

@Component({
  selector: 'app-accept-invitation',
  imports: [FormsModule, RouterLink],
  template: `
    <main class="grid min-h-dvh place-items-center bg-[#f7f4ef] px-5 py-10">
      <section
        class="w-full max-w-md rounded-[2rem] border border-stone-200 bg-white p-7 shadow-xl shadow-stone-200/60 sm:p-9"
      >
        <a routerLink="/login" class="mb-9 flex items-center gap-3">
          <img
            src="/brand/openjornada-mark.png"
            alt=""
            width="40"
            height="40"
            class="size-10 object-contain"
          />
          <span class="font-display text-xl font-bold">OpenJornada</span>
        </a>

        @if (loadingInvitation()) {
          <p class="text-sm font-bold uppercase tracking-[0.18em] text-coral-600">
            Comprobando invitación
          </p>
          <h1 class="mt-3 font-display text-3xl font-bold">Un momento…</h1>
          <div class="mt-7 h-2 animate-pulse rounded-full bg-stone-100"></div>
        } @else if (!invitation()) {
          <div class="grid size-14 place-items-center rounded-full bg-red-50 text-red-700">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              class="size-7"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                d="M12 9v4m0 4h.01M10.3 3.7 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"
              />
            </svg>
          </div>
          <h1 class="mt-6 font-display text-3xl font-bold">Invitación no disponible</h1>
          <p class="mt-3 leading-7 text-stone-500">
            El enlace ha caducado, ya se ha utilizado o ha sido sustituido. Solicita uno nuevo a tu
            responsable.
          </p>
          <a routerLink="/login" class="btn-secondary mt-8 w-full">Volver al acceso</a>
        } @else {
          <p class="text-sm font-bold uppercase tracking-[0.18em] text-coral-600">
            Invitación de {{ invitation()?.organization }}
          </p>
          <h1 class="mt-3 font-display text-3xl font-bold">Hola, {{ invitation()?.name }}</h1>
          <p class="mt-3 leading-7 text-stone-500">
            Crea tu contraseña para activar el acceso. Al terminar entrarás automáticamente.
          </p>
          <p class="mt-3 rounded-xl bg-stone-50 px-4 py-3 text-xs text-stone-500">
            El enlace caduca {{ expirationLabel() }} y sólo puede usarse una vez.
          </p>

          <form (ngSubmit)="accept()" class="mt-7 space-y-5">
            <label class="block">
              <span class="field-label">Nueva contraseña</span>
              <input
                [(ngModel)]="password"
                name="password"
                type="password"
                minlength="10"
                required
                autocomplete="new-password"
                class="field-input"
              />
            </label>
            <label class="block">
              <span class="field-label">Repite la contraseña</span>
              <input
                [(ngModel)]="confirm"
                name="confirm"
                type="password"
                minlength="10"
                required
                autocomplete="new-password"
                class="field-input"
              />
            </label>
            @if (error()) {
              <p
                role="alert"
                class="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
              >
                {{ error() }}
              </p>
            }
            <button
              type="submit"
              [disabled]="submitting() || password.length < 10 || password !== confirm"
              class="btn-primary w-full"
            >
              {{ submitting() ? 'Activando acceso…' : 'Crear contraseña y entrar' }}
            </button>
          </form>
        }
      </section>
    </main>
  `,
})
export class AcceptInvitationComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token') ?? '';
  protected readonly loadingInvitation = signal(true);
  protected readonly submitting = signal(false);
  protected readonly invitation = signal<InvitationDetails | null>(null);
  protected readonly error = signal('');
  protected password = '';
  protected confirm = '';

  constructor() {
    void this.load();
  }

  protected expirationLabel(): string {
    const value = this.invitation()?.expiresAt;
    return value
      ? new Intl.DateTimeFormat('es-ES', {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(value))
      : '';
  }

  protected async accept(): Promise<void> {
    const invitation = this.invitation();
    if (!invitation || !this.token) return;
    if (this.password !== this.confirm || this.password.length < 10) {
      this.error.set('Las contraseñas deben coincidir y tener al menos 10 caracteres.');
      return;
    }
    this.submitting.set(true);
    this.error.set('');
    try {
      const result = await this.pb.send<{ token: string; record: UserRecord }>(
        `/api/openjornada/invitations/${encodeURIComponent(this.token)}/accept`,
        {
          method: 'POST',
          body: {
            password: this.password,
            passwordConfirm: this.confirm,
          },
        },
      );
      this.pb.authStore.save(result.token, result.record);
      this.auth.user.set(result.record);
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.error.set(
        this.errorMessage(
          error,
          'El enlace ha caducado, ya se ha utilizado o no se pudo activar la cuenta.',
        ),
      );
    } finally {
      this.submitting.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      if (!this.token) throw new Error('Missing token');
      this.invitation.set(
        await this.pb.send<InvitationDetails>(
          `/api/openjornada/invitations/${encodeURIComponent(this.token)}`,
          { method: 'GET' },
        ),
      );
    } catch {
      this.invitation.set(null);
    } finally {
      this.loadingInvitation.set(false);
    }
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
}
