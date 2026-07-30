import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink],
  template: `
    <main class="grid min-h-dvh place-items-center bg-[#f7f4ef] px-5 py-10">
      <section class="w-full max-w-md rounded-[2rem] border border-stone-200 bg-white p-7 shadow-xl shadow-stone-200/60 sm:p-9">
        <a routerLink="/login" class="mb-9 flex items-center gap-3">
          <img src="/brand/openjornada-mark.png" alt="" width="40" height="40" class="size-10 object-contain" />
          <span class="font-display text-xl font-bold">OpenJornada</span>
        </a>
        @if (success()) {
          <div class="grid size-14 place-items-center rounded-full bg-emerald-100 text-emerald-700">
            <svg aria-hidden="true" viewBox="0 0 24 24" class="size-7" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6" /></svg>
          </div>
          <h1 class="mt-6 font-display text-3xl font-bold">Contraseña actualizada</h1>
          <p class="mt-3 leading-7 text-stone-500">Ya puedes entrar con tu nueva contraseña.</p>
          <a routerLink="/login" class="btn-primary mt-8 w-full">Ir al acceso</a>
        } @else {
          <p class="text-sm font-bold uppercase tracking-[0.18em] text-coral-600">Acceso seguro</p>
          <h1 class="mt-3 font-display text-3xl font-bold">Crea una nueva contraseña</h1>
          <p class="mt-3 leading-7 text-stone-500">Usa al menos 10 caracteres y evita reutilizar una contraseña anterior.</p>
          <form (ngSubmit)="submit()" class="mt-7 space-y-5">
            <label class="block">
              <span class="field-label">Nueva contraseña</span>
              <input [(ngModel)]="password" name="password" type="password" minlength="10" required autocomplete="new-password" class="field-input" />
            </label>
            <label class="block">
              <span class="field-label">Repite la contraseña</span>
              <input [(ngModel)]="confirm" name="confirm" type="password" minlength="10" required autocomplete="new-password" class="field-input" />
            </label>
            @if (error()) {
              <p role="alert" class="rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{{ error() }}</p>
            }
            <button type="submit" [disabled]="loading()" class="btn-primary w-full">{{ loading() ? 'Guardando…' : 'Guardar contraseña' }}</button>
          </form>
        }
      </section>
    </main>
  `,
})
export class ResetPasswordComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token');
  protected readonly loading = signal(false);
  protected readonly success = signal(false);
  protected readonly error = signal('');
  protected password = '';
  protected confirm = '';

  protected async submit(): Promise<void> {
    if (!this.token) {
      this.error.set('El enlace no es válido.');
      return;
    }
    if (this.password !== this.confirm) {
      this.error.set('Las contraseñas no coinciden.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    try {
      await this.pb
        .collection('users')
        .confirmPasswordReset(this.token, this.password, this.confirm);
      this.success.set(true);
    } catch {
      this.error.set('El enlace ha caducado o ya se ha utilizado.');
    } finally {
      this.loading.set(false);
    }
  }
}
