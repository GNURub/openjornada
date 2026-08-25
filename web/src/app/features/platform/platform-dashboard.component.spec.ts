import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAuthService } from '../../core/platform-auth.service';
import {
  type AccessMode,
  type PlatformOrganization,
  PlatformService,
  type PlatformSummary,
} from '../../core/platform.service';
import { PlatformDashboardComponent } from './platform-dashboard.component';

const initialSummary: PlatformSummary = {
  organizations: 1,
  activeUsers: 7,
  byStatus: { trialing: 0, active: 1, grace: 0, read_only: 0, suspended: 0 },
};

function organization(overrides: Partial<PlatformOrganization> = {}): PlatformOrganization {
  return {
    id: 'organization-1',
    name: 'Empresa de prueba',
    taxId: 'B12345678',
    timezone: 'Europe/Madrid',
    accessStatus: 'active',
    accessOverride: '',
    billingStatus: 'manual_active',
    planCode: 'managed-manual',
    planName: 'Gestionado',
    declaredHeadcount: 8,
    activeUsers: 7,
    totalUsers: 8,
    created: '',
    trialEndsAt: '',
    graceEndsAt: '',
    readOnlyUntil: '',
    ...overrides,
  };
}

interface TestableDashboard {
  changeAccess(organization: PlatformOrganization, accessStatus: AccessMode): Promise<void>;
  create(): Promise<void>;
  organizations(): PlatformOrganization[];
  success(): string;
}

describe('PlatformDashboardComponent', () => {
  const canWrite = signal(true);
  const operator = signal<{ name: string; role: 'admin' | 'support' }>({
    name: 'Operaciones',
    role: 'admin',
  });
  const auth = {
    canWrite,
    operator,
    logout: vi.fn(),
  };
  const platform = {
    summary: vi.fn(),
    organizations: vi.fn(),
    createOrganization: vi.fn(),
    updateAccess: vi.fn(),
    resendOwnerInvitation: vi.fn(),
    errorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
  };
  let fixture: ComponentFixture<PlatformDashboardComponent>;

  beforeEach(async () => {
    canWrite.set(true);
    operator.set({ name: 'Operaciones', role: 'admin' });
    platform.summary.mockReset().mockResolvedValue(initialSummary);
    platform.organizations.mockReset().mockResolvedValue([organization()]);
    platform.createOrganization.mockReset();
    platform.updateAccess.mockReset();
    platform.resendOwnerInvitation.mockReset();
    platform.errorMessage.mockClear();
    auth.logout.mockClear();
    await TestBed.configureTestingModule({
      imports: [PlatformDashboardComponent],
      providers: [
        { provide: PlatformAuthService, useValue: auth },
        { provide: PlatformService, useValue: platform },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(PlatformDashboardComponent);
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  it('loads operational aggregates and exposes write actions to administrators', async () => {
    fixture.detectChanges();
    await vi.waitFor(() => expect(platform.organizations).toHaveBeenCalled());
    await Promise.resolve();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain('Empresas y acceso');
    expect(host.textContent).toContain('Empresa de prueba');
    expect(host.textContent).toContain('Personas activas');
    expect(host.textContent).toContain('Nueva empresa');
    expect(host.querySelector('[aria-label="Cambiar estado de acceso"]')).not.toBeNull();
    expect(platform.summary).toHaveBeenCalledOnce();
    expect(platform.organizations).toHaveBeenCalledWith('', '');
  });

  it('keeps support in read-only mode even if component methods are invoked directly', async () => {
    canWrite.set(false);
    operator.set({ name: 'Soporte', role: 'support' as const });
    fixture.detectChanges();
    await vi.waitFor(() => expect(platform.organizations).toHaveBeenCalled());
    await Promise.resolve();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const component = fixture.componentInstance as unknown as TestableDashboard;

    await component.create();
    await component.changeAccess(organization(), 'suspended');

    expect(host.textContent).not.toContain('Nueva empresa');
    expect(host.textContent).toContain('Sólo lectura');
    expect(platform.createOrganization).not.toHaveBeenCalled();
    expect(platform.updateAccess).not.toHaveBeenCalled();
  });

  it('updates one row and refreshes the summary after an audited access change', async () => {
    const current = organization();
    const suspended = organization({ accessStatus: 'suspended', accessOverride: 'suspended' });
    platform.organizations.mockResolvedValue([current]);
    platform.updateAccess.mockResolvedValue(suspended);
    platform.summary.mockResolvedValueOnce(initialSummary).mockResolvedValueOnce({
      ...initialSummary,
      byStatus: { ...initialSummary.byStatus, active: 0, suspended: 1 },
    });
    vi.spyOn(window, 'prompt').mockReturnValue('Impago confirmado y revisado');
    fixture.detectChanges();
    await vi.waitFor(() => expect(platform.organizations).toHaveBeenCalled());
    await Promise.resolve();
    const component = fixture.componentInstance as unknown as TestableDashboard;

    await component.changeAccess(current, 'suspended');

    expect(platform.updateAccess).toHaveBeenCalledWith(
      'organization-1',
      'suspended',
      'Impago confirmado y revisado',
    );
    expect(component.organizations()[0]).toEqual(suspended);
    expect(component.success()).toBe('Acceso de Empresa de prueba actualizado.');
    expect(platform.summary).toHaveBeenCalledTimes(2);
  });
});
