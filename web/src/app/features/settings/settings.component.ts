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
import {
  BreakTypeRecord,
  LaborCalendarCatalog,
  LaborCalendarCommunity,
  LaborCalendarMunicipality,
  LaborCalendarPreview,
  LaborCalendarPreviewHoliday,
  LaborCalendarProvince,
  LegalHoldRecord,
  OrganizationRecord,
  RetentionPreview,
  UserRecord,
} from '../../core/models';
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
  protected readonly legalHolds = signal<LegalHoldRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly retentionPreview = signal<RetentionPreview | null>(null);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly logoPreview = signal(DEFAULT_LOGO_URL);
  protected readonly iconPreview = signal('/icons/icon-512x512.png');
  protected readonly logoError = signal('');
  protected readonly savingBreakType = signal('');
  protected readonly savingLegalHold = signal('');
  protected readonly communities = signal<LaborCalendarCommunity[]>([]);
  protected readonly provinces = signal<LaborCalendarProvince[]>([]);
  protected readonly municipalities = signal<LaborCalendarMunicipality[]>([]);
  protected readonly calendarPreview = signal<LaborCalendarPreview | null>(null);
  protected readonly selectedHolidayDates = signal<string[]>([]);
  protected readonly loadingLocationCatalog = signal('');
  protected readonly previewingCalendar = signal(false);
  protected readonly importingCalendar = signal(false);
  protected readonly calendarError = signal('');
  protected readonly calendarYears = [
    new Date().getFullYear(),
    new Date().getFullYear() + 1,
  ];
  protected calendarYear = new Date().getFullYear();
  protected newBreakTypeName = '';
  protected newBreakTypePaid = false;
  protected legalHoldEmployee = '';
  protected legalHoldFrom = '';
  protected legalHoldTo = '';
  protected legalHoldReason = '';
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

  protected async save(): Promise<boolean> {
    const organization = this.organization();
    if (!organization || this.logoError()) return false;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const payload: Record<string, unknown> = {
        name: organization.name.trim(),
        taxId: organization.taxId.trim(),
        timezone: organization.timezone,
        retentionYears: organization.retentionYears,
        privacyContact: organization.privacyContact.trim(),
        privacyNoticeVersion: organization.privacyNoticeVersion.trim(),
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
        addressLine1: organization.addressLine1.trim(),
        addressLine2: organization.addressLine2.trim(),
        postalCode: organization.postalCode.trim(),
        countryCode: 'ES',
        autonomousCommunityCode: organization.autonomousCommunityCode,
        autonomousCommunitySlug: organization.autonomousCommunitySlug,
        autonomousCommunityName: organization.autonomousCommunityName,
        provinceCode: organization.provinceCode,
        provinceSlug: organization.provinceSlug,
        provinceName: organization.provinceName,
        municipalityIne: organization.municipalityIne,
        municipalitySlug: organization.municipalitySlug,
        municipalityName: organization.municipalityName,
        locationUpdatedAt: this.locationComplete() ? new Date().toISOString() : '',
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
      return true;
    } catch (error) {
      this.error.set(
        error instanceof ClientResponseError && error.response?.['message']
          ? String(error.response['message'])
          : 'No se pudo guardar la configuración.',
      );
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  protected locationComplete(): boolean {
    const organization = this.organization();
    return Boolean(
      organization?.autonomousCommunitySlug &&
        organization.provinceSlug &&
        organization.municipalitySlug,
    );
  }

  protected async changeCalendarYear(year: number): Promise<void> {
    this.calendarYear = year;
    this.calendarPreview.set(null);
    this.selectedHolidayDates.set([]);
    await this.loadCommunities(true);
    if (this.organization()?.autonomousCommunitySlug) await this.loadProvinces(true);
    if (this.organization()?.provinceSlug) await this.loadMunicipalities(true);
  }

  protected async selectCommunity(slug: string): Promise<void> {
    const organization = this.organization();
    if (!organization) return;
    const selected = this.communities().find((item) => item.slug === slug);
    organization.autonomousCommunitySlug = selected?.slug ?? '';
    organization.autonomousCommunityCode = selected?.code ?? '';
    organization.autonomousCommunityName = selected?.name ?? '';
    organization.provinceSlug = '';
    organization.provinceCode = '';
    organization.provinceName = '';
    organization.municipalitySlug = '';
    organization.municipalityIne = '';
    organization.municipalityName = '';
    this.provinces.set([]);
    this.municipalities.set([]);
    this.clearCalendarProposal();
    if (selected) await this.loadProvinces(false);
  }

  protected async selectProvince(slug: string): Promise<void> {
    const organization = this.organization();
    if (!organization) return;
    const selected = this.provinces().find((item) => item.slug === slug);
    organization.provinceSlug = selected?.slug ?? '';
    organization.provinceCode = selected?.code ?? '';
    organization.provinceName = selected?.name ?? '';
    organization.municipalitySlug = '';
    organization.municipalityIne = '';
    organization.municipalityName = '';
    this.municipalities.set([]);
    this.clearCalendarProposal();
    if (selected) await this.loadMunicipalities(false);
  }

  protected selectMunicipality(slug: string): void {
    const organization = this.organization();
    if (!organization) return;
    const selected = this.municipalities().find((item) => item.slug === slug);
    organization.municipalitySlug = selected?.slug ?? '';
    organization.municipalityIne = selected?.ine ?? '';
    organization.municipalityName = selected?.name ?? '';
    this.clearCalendarProposal();
  }

  protected async saveAndPreviewCalendar(): Promise<void> {
    if (!this.locationComplete() || !(await this.save())) return;
    await this.previewLaborCalendar();
  }

  protected async previewLaborCalendar(): Promise<void> {
    if (!this.locationComplete() || this.previewingCalendar()) return;
    this.previewingCalendar.set(true);
    this.calendarError.set('');
    try {
      const preview = await this.pb.send<LaborCalendarPreview>(
        `/api/openjornada/labor-calendar/preview?year=${this.calendarYear}`,
        { method: 'GET' },
      );
      this.calendarPreview.set(preview);
      this.selectedHolidayDates.set(
        preview.items.filter((holiday) => !holiday.existing).map((holiday) => holiday.date),
      );
    } catch (error) {
      this.calendarPreview.set(null);
      this.selectedHolidayDates.set([]);
      this.calendarError.set(
        this.responseMessage(error, 'No se pudo preparar el calendario laboral.'),
      );
    } finally {
      this.previewingCalendar.set(false);
    }
  }

  protected toggleHolidayDate(date: string, selected: boolean): void {
    this.selectedHolidayDates.update((dates) =>
      selected ? [...new Set([...dates, date])] : dates.filter((item) => item !== date),
    );
  }

  protected selectAllSuggested(selected: boolean): void {
    this.selectedHolidayDates.set(
      selected
        ? (this.calendarPreview()?.items ?? [])
            .filter((holiday) => !holiday.existing)
            .map((holiday) => holiday.date)
        : [],
    );
  }

  protected holidaySelected(date: string): boolean {
    return this.selectedHolidayDates().includes(date);
  }

  protected async importLaborCalendar(): Promise<void> {
    if (!this.selectedHolidayDates().length || this.importingCalendar()) return;
    this.importingCalendar.set(true);
    this.calendarError.set('');
    this.success.set('');
    try {
      const result = await this.pb.send<{ imported: number; skipped: number }>(
        '/api/openjornada/labor-calendar/import',
        {
          method: 'POST',
          body: { year: this.calendarYear, dates: this.selectedHolidayDates() },
        },
      );
      await this.previewLaborCalendar();
      this.success.set(
        `${result.imported} festivos importados${result.skipped ? `; ${result.skipped} ya existían` : ''}.`,
      );
    } catch (error) {
      this.calendarError.set(this.responseMessage(error, 'No se pudo importar el calendario.'));
    } finally {
      this.importingCalendar.set(false);
    }
  }

  protected holidayScopeLabel(scope: LaborCalendarPreviewHoliday['scope']): string {
    return {
      nacional: 'Nacional',
      autonomico: 'Autonómico',
      provincial: 'Provincial',
      local: 'Local',
    }[scope];
  }

  protected holidayPreviewDate(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(new Date(`${value}T12:00:00`));
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

  protected async createLegalHold(): Promise<void> {
    if (this.legalHoldReason.trim().length < 8 || this.savingLegalHold()) {
      return;
    }
    this.savingLegalHold.set('new');
    this.error.set('');
    this.success.set('');
    try {
      const created = await this.pb.send<LegalHoldRecord>('/api/openjornada/legal-holds', {
        method: 'POST',
        body: {
          employee: this.legalHoldEmployee,
          from: this.legalHoldFrom,
          to: this.legalHoldTo,
          reason: this.legalHoldReason.trim(),
        },
      });
      this.legalHolds.update((items) => [created, ...items]);
      this.legalHoldEmployee = '';
      this.legalHoldFrom = '';
      this.legalHoldTo = '';
      this.legalHoldReason = '';
      this.success.set('Preservación legal activada y auditada.');
      await this.loadRetentionPreview();
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo activar la preservación.'));
    } finally {
      this.savingLegalHold.set('');
    }
  }

  protected async releaseLegalHold(item: LegalHoldRecord): Promise<void> {
    if (this.savingLegalHold()) return;
    this.savingLegalHold.set(item.id);
    this.error.set('');
    try {
      const updated = await this.pb.send<LegalHoldRecord>(
        `/api/openjornada/legal-holds/${item.id}/release`,
        { method: 'POST' },
      );
      this.legalHolds.update((items) =>
        items.map((current) => (current.id === updated.id ? updated : current)),
      );
      this.success.set('Preservación liberada con trazabilidad.');
      await this.loadRetentionPreview();
    } catch (error) {
      this.error.set(this.responseMessage(error, 'No se pudo liberar la preservación.'));
    } finally {
      this.savingLegalHold.set('');
    }
  }

  protected async loadRetentionPreview(): Promise<void> {
    try {
      this.retentionPreview.set(
        await this.pb.send<RetentionPreview>('/api/openjornada/retention-preview', {
          method: 'GET',
        }),
      );
    } catch {
      this.retentionPreview.set(null);
    }
  }

  protected memberName(id: string): string {
    if (!id) return 'Toda la empresa';
    return this.members().find((member) => member.id === id)?.name ?? id;
  }

  protected shortDate(value: string): string {
    return value
      ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(new Date(value))
      : 'Sin límite';
  }

  private clearCalendarProposal(): void {
    this.calendarPreview.set(null);
    this.selectedHolidayDates.set([]);
    this.calendarError.set('');
  }

  private async loadCommunities(_preserveSelection: boolean): Promise<void> {
    this.loadingLocationCatalog.set('communities');
    this.calendarError.set('');
    try {
      const response = await this.pb.send<LaborCalendarCatalog<LaborCalendarCommunity>>(
        `/api/openjornada/labor-calendar/communities?year=${this.calendarYear}`,
        { method: 'GET' },
      );
      this.communities.set(response.items);
    } catch (error) {
      this.calendarError.set(
        this.responseMessage(error, 'No se pudieron cargar las comunidades autónomas.'),
      );
    } finally {
      this.loadingLocationCatalog.set('');
    }
  }

  private async loadProvinces(_preserveSelection: boolean): Promise<void> {
    const community = this.organization()?.autonomousCommunitySlug;
    if (!community) return;
    this.loadingLocationCatalog.set('provinces');
    this.calendarError.set('');
    try {
      const response = await this.pb.send<LaborCalendarCatalog<LaborCalendarProvince>>(
        `/api/openjornada/labor-calendar/provinces?year=${this.calendarYear}&community=${encodeURIComponent(community)}`,
        { method: 'GET' },
      );
      this.provinces.set(response.items);
    } catch (error) {
      this.calendarError.set(this.responseMessage(error, 'No se pudieron cargar las provincias.'));
    } finally {
      this.loadingLocationCatalog.set('');
    }
  }

  private async loadMunicipalities(_preserveSelection: boolean): Promise<void> {
    const organization = this.organization();
    if (!organization?.autonomousCommunitySlug || !organization.provinceSlug) return;
    this.loadingLocationCatalog.set('municipalities');
    this.calendarError.set('');
    try {
      const response = await this.pb.send<LaborCalendarCatalog<LaborCalendarMunicipality>>(
        `/api/openjornada/labor-calendar/municipalities?year=${this.calendarYear}&community=${encodeURIComponent(organization.autonomousCommunitySlug)}&province=${encodeURIComponent(organization.provinceSlug)}`,
        { method: 'GET' },
      );
      this.municipalities.set(response.items);
    } catch (error) {
      this.calendarError.set(this.responseMessage(error, 'No se pudieron cargar los municipios.'));
    } finally {
      this.loadingLocationCatalog.set('');
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
      record.addressLine1 ??= '';
      record.addressLine2 ??= '';
      record.postalCode ??= '';
      record.countryCode = 'ES';
      record.autonomousCommunityCode ??= '';
      record.autonomousCommunitySlug ??= '';
      record.autonomousCommunityName ??= '';
      record.provinceCode ??= '';
      record.provinceSlug ??= '';
      record.provinceName ??= '';
      record.municipalityIne ??= '';
      record.municipalitySlug ??= '';
      record.municipalityName ??= '';
      record.locationUpdatedAt ??= '';
      this.organization.set(record);
      const [breakTypes, legalHolds, members] = await Promise.all([
        this.pb.collection('break_types').getFullList({ sort: 'name' }),
        this.pb.collection('legal_holds').getFullList({
          sort: '-active,-created',
          expand: 'employee',
        }),
        this.pb.collection('users').getFullList({
          sort: 'name',
          fields: 'id,name,employeeCode',
        }),
      ]);
      this.breakTypes.set(breakTypes as BreakTypeRecord[]);
      this.legalHolds.set(legalHolds as LegalHoldRecord[]);
      this.members.set(members as UserRecord[]);
      await this.loadCommunities(true);
      if (record.autonomousCommunitySlug) await this.loadProvinces(true);
      if (record.provinceSlug) await this.loadMunicipalities(true);
      await this.loadRetentionPreview();
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
