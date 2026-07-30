import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-verify-email',
  imports: [RouterLink],
  template: `
    <main class="grid min-h-dvh place-items-center bg-[#f7f4ef] px-5 py-10">
      <section class="w-full max-w-md rounded-[2rem] border border-stone-200 bg-white p-8 text-center shadow-xl shadow-stone-200/60">
        <span class="mx-auto grid size-12 place-items-center rounded-2xl bg-coral-500 font-black text-white">A</span>
        @if (loading()) {
          <h1 class="mt-7 font-display text-3xl font-bold">Verificando tu correo…</h1>
          <p class="mt-3 text-stone-500">Sólo tardará un momento.</p>
        } @else if (verified()) {
          <h1 class="mt-7 font-display text-3xl font-bold">Correo verificado</h1>
          <p class="mt-3 leading-7 text-stone-500">Tu cuenta ya está preparada para acceder a Aura.</p>
          <a routerLink="/login" class="btn-primary mt-8 w-full">Entrar</a>
        } @else {
          <h1 class="mt-7 font-display text-3xl font-bold">El enlace no es válido</h1>
          <p class="mt-3 leading-7 text-stone-500">Puede que haya caducado o ya se haya utilizado. Solicita otro a tu responsable.</p>
          <a routerLink="/login" class="btn-secondary mt-8 w-full">Volver</a>
        }
      </section>
    </main>
  `,
})
export class VerifyEmailComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly token = inject(ActivatedRoute).snapshot.paramMap.get('token');
  protected readonly loading = signal(true);
  protected readonly verified = signal(false);

  constructor() {
    void this.verify();
  }

  private async verify(): Promise<void> {
    try {
      if (!this.token) throw new Error('Missing token');
      await this.pb.collection('users').confirmVerification(this.token);
      this.verified.set(true);
    } catch {
      this.verified.set(false);
    } finally {
      this.loading.set(false);
    }
  }
}
