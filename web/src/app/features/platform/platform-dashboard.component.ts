import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AccessStatus,
  PlatformOrganization,
  PlatformService,
  PlatformSummary,
  ProvisionOrganization,
} from '../../core/platform.service';
import { PlatformAuthService } from '../../core/platform-auth.service';

@Component({
  selector: 'app-platform-dashboard',
  imports: [FormsModule],
  templateUrl: './platform-dashboard.component.html',
})
export class PlatformDashboardComponent implements OnInit {
  protected readonly auth = inject(PlatformAuthService);
  private readonly platform = inject(PlatformService);

  protected readonly summary = signal<PlatformSummary | null>(null);
  protected readonly organizations = signal<PlatformOrganization[]>([]);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly formOpen = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected search = '';
  protected status = '';
  protected newOrganization: ProvisionOrganization = this.emptyOrganization();

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const [summary, organizations] = await Promise.all([
        this.platform.summary(),
        this.platform.organizations(this.search, this.status),
      ]);
      this.summary.set(summary);
      this.organizations.set(organizations);
    } catch (error) {
      this.error.set(this.platform.errorMessage(error, 'No se pudo cargar el área de proveedor.'));
    } finally {
      this.loading.set(false);
    }
  }

  protected async create(): Promise<void> {
    if (!this.auth.canWrite()) return;
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    try {
      const result = await this.platform.createOrganization(this.newOrganization);
      this.success.set(
        result.invitationSent
          ? 'Empresa creada y responsable invitado.'
          : 'Empresa creada. El correo no pudo enviarse; puedes reenviarlo desde el listado.',
      );
      this.newOrganization = this.emptyOrganization();
      this.formOpen.set(false);
      await this.load();
    } catch (error) {
      this.error.set(this.platform.errorMessage(error, 'No se pudo crear la empresa.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async changeAccess(
    organization: PlatformOrganization,
    accessStatus: AccessStatus,
  ): Promise<void> {
    if (!this.auth.canWrite() || organization.accessStatus === accessStatus) return;
    const reason = window.prompt(
      `Motivo del cambio de ${organization.accessStatus} a ${accessStatus} (mínimo 10 caracteres):`,
    );
    if (!reason) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const updated = await this.platform.updateAccess(organization.id, accessStatus, reason);
      this.organizations.update((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      );
      this.success.set(`Acceso de ${organization.name} actualizado.`);
      this.summary.set(await this.platform.summary());
    } catch (error) {
      this.error.set(this.platform.errorMessage(error, 'No se pudo cambiar el acceso.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async resendInvitation(organization: PlatformOrganization): Promise<void> {
    if (!this.auth.canWrite()) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.platform.resendOwnerInvitation(organization.id);
      this.success.set(`Invitación reenviada para ${organization.name}.`);
    } catch (error) {
      this.error.set(this.platform.errorMessage(error, 'No se pudo reenviar la invitación.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected statusLabel(status: AccessStatus): string {
    return (
      {
        trialing: 'Prueba',
        active: 'Activo',
        grace: 'Cortesía',
        read_only: 'Sólo lectura',
        suspended: 'Suspendido',
      } satisfies Record<AccessStatus, string>
    )[status];
  }

  private emptyOrganization(): ProvisionOrganization {
    return {
      name: '',
      taxId: '',
      timezone: 'Europe/Madrid',
      privacyContact: '',
      ownerName: '',
      ownerEmail: '',
      declaredHeadcount: 1,
    };
  }
}
