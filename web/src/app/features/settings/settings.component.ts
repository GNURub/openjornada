import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { RecordModel } from 'pocketbase';
import { AuthService } from '../../core/auth.service';
import { PocketBaseService } from '../../core/pocketbase.service';

interface OrganizationRecord extends RecordModel {
  name: string;
  taxId: string;
  timezone: string;
  retentionYears: number;
  privacyContact: string;
}

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly auth = inject(AuthService);
  protected readonly organization = signal<OrganizationRecord | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');

  constructor() {
    void this.load();
  }

  protected async save(): Promise<void> {
    const organization = this.organization();
    if (!organization) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const updated = await this.pb
        .collection('organizations')
        .update(organization.id, {
          name: organization.name,
          timezone: organization.timezone,
          retentionYears: organization.retentionYears,
          privacyContact: organization.privacyContact,
        });
      this.organization.set(updated as OrganizationRecord);
      this.success.set('Configuración guardada.');
    } catch {
      this.error.set('No se pudo guardar la configuración.');
    } finally {
      this.saving.set(false);
    }
  }

  private async load(): Promise<void> {
    const organizationId = this.auth.user()?.organization;
    if (!organizationId) return;
    try {
      const record = await this.pb
        .collection('organizations')
        .getOne(organizationId);
      this.organization.set(record as OrganizationRecord);
    } catch {
      this.error.set('No se pudo cargar la empresa.');
    } finally {
      this.loading.set(false);
    }
  }
}
