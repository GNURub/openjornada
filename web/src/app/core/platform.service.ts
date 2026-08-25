import { inject, Injectable } from '@angular/core';
import { ClientResponseError } from 'pocketbase';
import { PlatformAuthService } from './platform-auth.service';

export type AccessStatus = 'trialing' | 'active' | 'grace' | 'read_only' | 'suspended';

export interface PlatformSummary {
  organizations: number;
  activeUsers: number;
  byStatus: Record<AccessStatus, number>;
}

export interface PlatformOrganization {
  id: string;
  name: string;
  taxId: string;
  timezone: string;
  accessStatus: AccessStatus;
  billingStatus: string;
  planCode: string;
  planName: string;
  declaredHeadcount: number;
  activeUsers: number;
  totalUsers: number;
  created: string;
  trialEndsAt: string;
  graceEndsAt: string;
  readOnlyUntil: string;
}

export interface ProvisionOrganization {
  name: string;
  taxId: string;
  timezone: string;
  privacyContact: string;
  ownerName: string;
  ownerEmail: string;
  declaredHeadcount: number;
}

@Injectable({ providedIn: 'root' })
export class PlatformService {
  private readonly pb = inject(PlatformAuthService).client;
  private readonly base = '/api/openjornada/platform/v1';

  summary(): Promise<PlatformSummary> {
    return this.pb.send<PlatformSummary>(`${this.base}/summary`, { method: 'GET' });
  }

  organizations(search = '', status = ''): Promise<PlatformOrganization[]> {
    return this.pb.send<PlatformOrganization[]>(`${this.base}/organizations`, {
      method: 'GET',
      query: { search, status },
    });
  }

  createOrganization(input: ProvisionOrganization): Promise<{
    organizationId: string;
    invitationSent: boolean;
  }> {
    return this.pb.send(`${this.base}/organizations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: input,
    });
  }

  updateAccess(
    organizationId: string,
    accessStatus: AccessStatus,
    reason: string,
  ): Promise<PlatformOrganization> {
    return this.pb.send(`${this.base}/organizations/${organizationId}/access`, {
      method: 'PATCH',
      body: { accessStatus, reason },
    });
  }

  resendOwnerInvitation(organizationId: string): Promise<void> {
    return this.pb.send(`${this.base}/organizations/${organizationId}/owner-invitation`, {
      method: 'POST',
    });
  }

  errorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof ClientResponseError)) return fallback;
    const message = error.response?.['message'];
    return typeof message === 'string' && message ? message : fallback;
  }
}
