import { Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../core/auth.service';
import { PrivacyNotice } from '../core/models';
import { PocketBaseService } from '../core/pocketbase.service';

@Component({
  selector: 'app-privacy-notice-modal',
  templateUrl: './privacy-notice-modal.component.html',
})
export class PrivacyNoticeModalComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly notice = signal<PrivacyNotice | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly open = computed(() => {
    const user = this.auth.user();
    const notice = this.notice();
    return Boolean(user) && (!notice || !notice.acknowledged);
  });

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.notice.set(
        await this.pb.send<PrivacyNotice>('/api/openjornada/privacy-notice', { method: 'GET' }),
      );
    } catch {
      this.error.set(
        'No se pudo cargar la información de privacidad. Reinténtalo antes de continuar.',
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected async acknowledge(): Promise<void> {
    if (!this.notice() || this.saving()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.pb.send('/api/openjornada/privacy-notice/acknowledge', {
        method: 'POST',
      });
      await this.auth.refresh();
      this.notice.update((notice) => (notice ? { ...notice, acknowledged: true } : notice));
    } catch {
      this.error.set('No se pudo registrar la entrega de la información.');
    } finally {
      this.saving.set(false);
    }
  }
}
