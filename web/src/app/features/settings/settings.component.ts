import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClientResponseError } from 'pocketbase';
import { AuthService } from '../../core/auth.service';
import {
  BrandingService,
  DEFAULT_LOGO_URL,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  normalizeBrandColor,
} from '../../core/branding.service';
import { BreakTypeRecord, OrganizationRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

@Component({
  selector: 'app-settings',
  imports: [FormsModule],
  templateUrl: './settings.component.html',
})
export class SettingsComponent {
  private readonly pb = inject(PocketBaseService).client;
  private readonly auth = inject(AuthService);
  protected readonly branding = inject(BrandingService);
  protected readonly organization = signal<OrganizationRecord | null>(null);
  protected readonly breakTypes = signal<BreakTypeRecord[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly logoPreview = signal(DEFAULT_LOGO_URL);
  protected readonly iconPreview = signal('/icons/icon-512x512.png');
  protected readonly logoError = signal('');
  protected readonly savingBreakType = signal('');
  protected newBreakTypeName = '';
  protected newBreakTypePaid = false;
  private logoFile: File | null = null;
  private iconFile: File | null = null;
  private removeLogo = false;

  constructor() {
    void this.load();
  }

  protected async selectLogo(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.logoError.set('');
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type) || file.size > 5 * 1024 * 1024) {
      this.logoError.set('Usa una imagen PNG, JPEG o WebP de un máximo de 5 MB.');
      input.value = '';
      return;
    }
    try {
      const generated = await this.generateSquareIcon(
        file,
        this.organization()?.brandSecondaryColor ?? DEFAULT_SECONDARY_COLOR,
      );
      this.logoFile = file;
      this.iconFile = generated.file;
      this.removeLogo = false;
      this.logoPreview.set(await this.readAsDataUrl(file));
      this.iconPreview.set(generated.preview);
    } catch {
      this.logoFile = null;
      this.iconFile = null;
      this.logoError.set('No se pudo generar el icono a partir del logotipo.');
      input.value = '';
    }
  }

  protected clearLogo(): void {
    this.logoFile = null;
    this.iconFile = null;
    this.removeLogo = true;
    this.logoPreview.set(DEFAULT_LOGO_URL);
    this.iconPreview.set('/icons/icon-512x512.png');
    this.logoError.set('');
  }

  protected async save(): Promise<void> {
    const organization = this.organization();
    if (!organization || this.logoError()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const payload: Record<string, unknown> = {
        name: organization.name.trim(),
        timezone: organization.timezone,
        retentionYears: organization.retentionYears,
        privacyContact: organization.privacyContact.trim(),
        brandPrimaryColor: normalizeBrandColor(
          organization.brandPrimaryColor,
          DEFAULT_PRIMARY_COLOR,
        ),
        brandSecondaryColor: normalizeBrandColor(
          organization.brandSecondaryColor,
          DEFAULT_SECONDARY_COLOR,
        ),
        pwaName: organization.pwaName.trim(),
        pwaShortName: organization.pwaShortName.trim(),
        manualTimeApprovalRequired: organization.manualTimeApprovalRequired,
        timeCorrectionApprovalRequired: organization.timeCorrectionApprovalRequired,
      };
      if (this.logoFile && this.iconFile) {
        payload['brandLogo'] = this.logoFile;
        payload['pwaIcon'] = this.iconFile;
      } else if (this.removeLogo) {
        payload['brandLogo'] = null;
        payload['pwaIcon'] = null;
      }

      const updated = (await this.pb
        .collection('organizations')
        .update(organization.id, payload)) as OrganizationRecord;
      this.organization.set(updated);
      this.branding.applyOrganization(updated);
      this.logoPreview.set(
        updated.brandLogo ? this.pb.files.getURL(updated, updated.brandLogo) : DEFAULT_LOGO_URL,
      );
      this.iconPreview.set(
        updated.pwaIcon
          ? this.pb.files.getURL(updated, updated.pwaIcon)
          : '/icons/icon-512x512.png',
      );
      this.logoFile = null;
      this.iconFile = null;
      this.removeLogo = false;
      this.success.set('Configuración guardada. La identidad corporativa ya está aplicada.');
    } catch (error) {
      this.error.set(
        error instanceof ClientResponseError && error.response?.['message']
          ? String(error.response['message'])
          : 'No se pudo guardar la configuración.',
      );
    } finally {
      this.saving.set(false);
    }
  }

  protected async createBreakType(): Promise<void> {
    const organization = this.organization();
    const name = this.newBreakTypeName.trim();
    if (!organization || name.length < 2 || this.savingBreakType()) return;
    this.savingBreakType.set('new');
    this.error.set('');
    this.success.set('');
    try {
      const created = (await this.pb.collection('break_types').create({
        organization: organization.id,
        name,
        paid: this.newBreakTypePaid,
        active: true,
      })) as BreakTypeRecord;
      this.breakTypes.update((items) =>
        [...items, created].sort((left, right) => left.name.localeCompare(right.name, 'es')),
      );
      this.newBreakTypeName = '';
      this.newBreakTypePaid = false;
      this.success.set('Tipo de pausa creado.');
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo crear el tipo de pausa.'));
    } finally {
      this.savingBreakType.set('');
    }
  }

  protected async saveBreakType(item: BreakTypeRecord): Promise<void> {
    if (this.savingBreakType() || item.name.trim().length < 2) return;
    this.savingBreakType.set(item.id);
    this.error.set('');
    this.success.set('');
    try {
      const updated = (await this.pb.collection('break_types').update(item.id, {
        name: item.name.trim(),
        paid: item.paid,
        active: item.active,
      })) as BreakTypeRecord;
      this.breakTypes.update((items) =>
        items.map((current) => (current.id === updated.id ? updated : current)),
      );
      this.success.set('Tipo de pausa actualizado.');
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo actualizar el tipo de pausa.'));
    } finally {
      this.savingBreakType.set('');
    }
  }

  private async load(): Promise<void> {
    const organizationId = this.auth.user()?.organization;
    if (!organizationId) {
      this.loading.set(false);
      return;
    }
    try {
      const record = (await this.pb
        .collection('organizations')
        .getOne(organizationId)) as OrganizationRecord;
      record.brandPrimaryColor = normalizeBrandColor(
        record.brandPrimaryColor,
        DEFAULT_PRIMARY_COLOR,
      );
      record.brandSecondaryColor = normalizeBrandColor(
        record.brandSecondaryColor,
        DEFAULT_SECONDARY_COLOR,
      );
      record.pwaName = record.pwaName?.trim() || record.name || 'OpenJornada';
      record.pwaShortName = record.pwaShortName?.trim() || record.pwaName.slice(0, 20);
      record.manualTimeApprovalRequired = Boolean(record.manualTimeApprovalRequired);
      record.timeCorrectionApprovalRequired = record.timeCorrectionApprovalRequired !== false;
      this.organization.set(record);
      const breakTypes = await this.pb.collection('break_types').getFullList({
        sort: 'name',
      });
      this.breakTypes.set(breakTypes as BreakTypeRecord[]);
      this.logoPreview.set(
        record.brandLogo ? this.pb.files.getURL(record, record.brandLogo) : DEFAULT_LOGO_URL,
      );
      this.iconPreview.set(
        record.pwaIcon ? this.pb.files.getURL(record, record.pwaIcon) : '/icons/icon-512x512.png',
      );
    } catch {
      this.error.set('No se pudo cargar la empresa.');
    } finally {
      this.loading.set(false);
    }
  }

  private responseMessage(error: unknown, fallback: string): string {
    return error instanceof ClientResponseError && error.response?.['message']
      ? String(error.response['message'])
      : fallback;
  }

  private readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private async generateSquareIcon(
    file: File,
    background: string,
  ): Promise<{ file: File; preview: string }> {
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        image.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context || !image.naturalWidth || !image.naturalHeight) {
        throw new Error('No se pudo preparar el icono.');
      }

      context.fillStyle = normalizeBrandColor(background, DEFAULT_SECONDARY_COLOR);
      context.fillRect(0, 0, 512, 512);
      const available = 384;
      const scale = Math.min(available / image.naturalWidth, available / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.drawImage(image, (512 - width) / 2, (512 - height) / 2, width, height);

      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(new Error('No se pudo exportar el icono.'))),
          'image/png',
        );
      });
      return {
        file: new File([blob], 'pwa-icon.png', { type: 'image/png' }),
        preview: canvas.toDataURL('image/png'),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
