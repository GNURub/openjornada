import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PocketBaseService } from './pocketbase.service';
import { TerminalService } from './terminal.service';

describe('terminal service public contract', () => {
  const send = vi.fn().mockResolvedValue({});
  let service: TerminalService;

  beforeEach(() => {
    send.mockClear();
    const injector = Injector.create({
      providers: [{ provide: PocketBaseService, useValue: { client: { send } } }],
    });
    service = runInInjectionContext(injector, () => new TerminalService());
  });

  it('uses the administrative terminal routes with exact methods and bodies', async () => {
    await service.createTerminal('Recepción');
    await service.renameTerminal('terminal-1', 'Entrada');
    await service.rotateTerminalKey('terminal-1');
    await service.revokeTerminal('terminal-1');
    await service.updateAdminPin('9669');

    expect(send.mock.calls).toEqual([
      ['/api/openjornada/terminals', { method: 'POST', body: { name: 'Recepción' } }],
      ['/api/openjornada/terminals/terminal-1', { method: 'PATCH', body: { name: 'Entrada' } }],
      ['/api/openjornada/terminals/terminal-1/rotate-key', { method: 'POST' }],
      ['/api/openjornada/terminals/terminal-1/revoke', { method: 'POST' }],
      ['/api/openjornada/terminals/admin-pin', { method: 'PUT', body: { pin: '9669' } }],
    ]);
  });

  it('uses scoped tag and incident routes', async () => {
    await service.assignEmployee('employee-1', '04:A1:B2:C3', true);
    await service.revokeEmployee('employee-1');
    await service.listIncidents();
    await service.resolveIncident('incident-1', 'Jornada corregida');

    expect(send.mock.calls).toEqual([
      [
        '/api/openjornada/employees/employee-1/rfid',
        { method: 'PUT', body: { uid: '04:A1:B2:C3', replace: true } },
      ],
      ['/api/openjornada/employees/employee-1/rfid', { method: 'DELETE' }],
      ['/api/openjornada/terminal-incidents', { method: 'GET' }],
      [
        '/api/openjornada/terminal-incidents/incident-1/resolve',
        { method: 'POST', body: { note: 'Jornada corregida' } },
      ],
    ]);
  });
});
