import { inject, Injectable } from '@angular/core';
import { PocketBaseService } from './pocketbase.service';
import {
  TerminalActionRequest,
  TerminalActionResult,
  TerminalBootstrapResponse,
  TerminalEmployee,
  TerminalIncidentRecord,
  TerminalQueuedAction,
  TerminalRecord,
  TerminalResolveResponse,
} from './terminal.models';

@Injectable({ providedIn: 'root' })
export class TerminalService {
  private readonly pb = inject(PocketBaseService).client;

  listTerminals(): Promise<{
    items: TerminalRecord[];
    adminPinConfigured: boolean;
  }> {
    return this.pb.send('/api/openjornada/terminals', { method: 'GET' });
  }

  createTerminal(name: string): Promise<TerminalRecord> {
    return this.pb.send('/api/openjornada/terminals', { method: 'POST', body: { name } });
  }

  renameTerminal(id: string, name: string): Promise<TerminalRecord> {
    return this.pb.send(`/api/openjornada/terminals/${id}`, {
      method: 'PATCH',
      body: { name },
    });
  }

  rotateTerminalKey(id: string): Promise<TerminalRecord> {
    return this.pb.send(`/api/openjornada/terminals/${id}/rotate-key`, { method: 'POST' });
  }

  revokeTerminal(id: string): Promise<TerminalRecord> {
    return this.pb.send(`/api/openjornada/terminals/${id}/revoke`, { method: 'POST' });
  }

  updateAdminPin(pin: string): Promise<{ configured: boolean }> {
    return this.pb.send('/api/openjornada/terminals/admin-pin', {
      method: 'PUT',
      body: { pin },
    });
  }

  listEmployees(): Promise<{ items: TerminalEmployee[] }> {
    return this.pb.send('/api/openjornada/rfid-employees', { method: 'GET' });
  }

  assignEmployee(employeeId: string, uid: string, replace: boolean): Promise<void> {
    return this.pb.send(`/api/openjornada/employees/${employeeId}/rfid`, {
      method: 'PUT',
      body: { uid, replace },
    });
  }

  revokeEmployee(employeeId: string): Promise<void> {
    return this.pb.send(`/api/openjornada/employees/${employeeId}/rfid`, { method: 'DELETE' });
  }

  listIncidents(): Promise<{ items: TerminalIncidentRecord[] }> {
    return this.pb.send('/api/openjornada/terminal-incidents', { method: 'GET' });
  }

  resolveIncident(id: string, note: string): Promise<void> {
    return this.pb.send(`/api/openjornada/terminal-incidents/${id}/resolve`, {
      method: 'POST',
      body: { note },
    });
  }

  bootstrap(
    token: string,
    body: { protocolVersion: 1; clientVersion: string; pendingCount: number },
  ): Promise<TerminalBootstrapResponse> {
    return this.deviceSend('/bootstrap', token, 'POST', body);
  }

  openAdminSession(token: string, pin: string): Promise<{ token: string; idleExpiresAt: string }> {
    return this.deviceSend('/admin-sessions', token, 'POST', { pin });
  }

  closeAdminSession(token: string, adminSession: string): Promise<void> {
    return this.deviceSend('/admin-sessions/current', token, 'DELETE', undefined, adminSession);
  }

  deviceEmployees(token: string, adminSession: string): Promise<{ items: TerminalEmployee[] }> {
    return this.deviceSend('/employees', token, 'GET', undefined, adminSession);
  }

  deviceAssign(
    token: string,
    adminSession: string,
    employeeId: string,
    uid: string,
    replace: boolean,
  ): Promise<void> {
    return this.deviceSend(
      `/employees/${employeeId}/rfid`,
      token,
      'PUT',
      { uid, replace },
      adminSession,
    );
  }

  resolveTag(token: string, uid: string): Promise<TerminalResolveResponse> {
    return this.deviceSend('/resolve', token, 'POST', { uid });
  }

  deviceCache(
    token: string,
    revision: number,
  ): Promise<{
    revision: number;
    unchanged: boolean;
    items: Array<{
      employeeId: string;
      displayName: string;
      uid: string;
      state: import('./terminal.models').TerminalWorkState;
    }>;
  }> {
    return this.deviceSend(`/cache?revision=${revision}`, token, 'GET');
  }

  performAction(token: string, request: TerminalActionRequest): Promise<TerminalActionResult> {
    return this.deviceSend('/actions', token, 'POST', request);
  }

  sync(
    token: string,
    actions: TerminalQueuedAction[],
    pendingCount: number,
  ): Promise<{ items: TerminalActionResult[]; serverTime: string }> {
    return this.deviceSend('/sync', token, 'POST', { actions, pendingCount });
  }

  private deviceSend<T>(
    path: string,
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
    adminSession?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (adminSession) headers['X-Terminal-Admin-Session'] = adminSession;
    return this.pb.send<T>(`/api/openjornada/terminal/v1${path}`, {
      method,
      body,
      headers,
      requestKey: null,
    });
  }
}
