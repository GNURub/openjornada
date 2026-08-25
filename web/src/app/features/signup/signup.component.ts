import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientResponseError } from 'pocketbase';
import { PocketBaseService } from '../../core/pocketbase.service';

interface PublicPlan {
  code: string;
  name: string;
  billingModel: 'fixed' | 'tiered';
  headcountLimit: number;
}

@Component({
  selector: 'app-signup',
  imports: [FormsModule],
  templateUrl: './signup.component.html',
})
export class SignupComponent implements OnInit {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly plans = signal<PublicPlan[]>([]);
  protected readonly loading = signal(false);
  protected readonly sent = signal(false);
  protected readonly invitationSent = signal(false);
  protected readonly error = signal('');
  protected form = {
    organizationName: '',
    taxId: '',
    timezone: 'Europe/Madrid',
    ownerName: '',
    ownerEmail: '',
    declaredHeadcount: 1,
    planCode: '',
  };
  private idempotencyKey = crypto.randomUUID();

  async ngOnInit(): Promise<void> {
    try {
      const plans = await this.pb.send<PublicPlan[]>('/api/openjornada/public/plans', {
        method: 'GET',
      });
      this.plans.set(plans);
      this.form.planCode = plans[0]?.code ?? '';
    } catch {
      this.error.set('El alta de prueba no está disponible en este momento.');
    }
  }

  protected async submit(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.pb.send<{ invitationSent: boolean }>('/api/openjornada/signup', {
        method: 'POST',
        body: { ...this.form, idempotencyKey: this.idempotencyKey },
      });
      this.invitationSent.set(result.invitationSent);
      this.sent.set(true);
    } catch (error) {
      const message =
        error instanceof ClientResponseError && typeof error.response?.['message'] === 'string'
          ? error.response['message']
          : 'No se pudo completar el alta.';
      this.error.set(message);
    } finally {
      this.loading.set(false);
    }
  }
}
