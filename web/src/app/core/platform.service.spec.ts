import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformService, type ProvisionOrganization } from './platform.service';

describe('PlatformService', () => {
  const send = vi.fn().mockResolvedValue({});
  let service: PlatformService;

  beforeEach(() => {
    send.mockClear();
    const injector = Injector.create({
      providers: [{ provide: PlatformAuthService, useValue: { client: { send } } }],
    });
    service = runInInjectionContext(injector, () => new PlatformService());
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses only the isolated provider API for reads and access changes', async () => {
    await service.summary();
    await service.organizations('Acme', 'suspended');
    await service.updateAccess('organization-1', 'suspended', 'Impago confirmado por soporte');
    await service.updateAccess(
      'organization-1',
      'automatic',
      'Retorno al ciclo automático solicitado',
    );
    await service.resendOwnerInvitation('organization-1');

    expect(send.mock.calls).toEqual([
      ['/api/openjornada/platform/v1/summary', { method: 'GET' }],
      [
        '/api/openjornada/platform/v1/organizations',
        { method: 'GET', query: { search: 'Acme', status: 'suspended' } },
      ],
      [
        '/api/openjornada/platform/v1/organizations/organization-1/access',
        {
          method: 'PATCH',
          body: { accessStatus: 'suspended', reason: 'Impago confirmado por soporte' },
        },
      ],
      [
        '/api/openjornada/platform/v1/organizations/organization-1/access',
        {
          method: 'PATCH',
          body: {
            accessStatus: 'automatic',
            reason: 'Retorno al ciclo automático solicitado',
          },
        },
      ],
      [
        '/api/openjornada/platform/v1/organizations/organization-1/owner-invitation',
        { method: 'POST' },
      ],
    ]);
  });

  it('adds a fresh idempotency key when provisioning an organization', async () => {
    const input: ProvisionOrganization = {
      name: 'Empresa de prueba',
      taxId: 'B12345678',
      timezone: 'Europe/Madrid',
      privacyContact: 'privacidad@example.com',
      ownerName: 'Responsable',
      ownerEmail: 'responsable@example.com',
      declaredHeadcount: 8,
    };
    const randomUUID = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('12345678-1234-4234-8234-123456789abc');

    await service.createOrganization(input);

    expect(send).toHaveBeenCalledWith('/api/openjornada/platform/v1/organizations', {
      method: 'POST',
      headers: { 'Idempotency-Key': '12345678-1234-4234-8234-123456789abc' },
      body: input,
    });
    randomUUID.mockRestore();
  });
});
