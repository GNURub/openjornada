import type { RecordModel } from 'pocketbase';

export type TerminalStateKind = 'idle' | 'working' | 'on_break';
export type TerminalCommand = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';
export type TerminalActionStatus = 'accepted' | 'duplicate' | 'incident' | 'rejected';
export type TerminalErrorCode =
  | 'authentication_required'
  | 'terminal_revoked'
  | 'admin_session_required'
  | 'admin_session_expired'
  | 'pin_rate_limited'
  | 'rfid_capacity_reached'
  | 'unknown_tag'
  | 'inactive_employee'
  | 'state_conflict'
  | 'clock_untrusted'
  | 'protocol_incompatible'
  | 'invalid_signature';

export interface TerminalRecord extends RecordModel {
  organization: string;
  name: string;
  prefix: string;
  protocolVersion: number;
  clientVersion: string;
  cacheRevision: number;
  lastSeenAt: string;
  lastPendingCount: number;
  revokedAt: string;
  createdBy: string;
  token?: string;
}

export interface TerminalAction {
  command: TerminalCommand;
  label: string;
  mode: 'now' | 'choose_time' | 'close_from_break';
  highlighted: boolean;
}

export interface TerminalWorkState {
  kind: TerminalStateKind;
  since: string | null;
  workedSeconds: number;
  breakSeconds: number;
  longShift: boolean;
  staleBreak: boolean;
  actions: TerminalAction[];
}

export interface TerminalBootstrapResponse {
  protocol: { current: 1; min: 1; max: 1 };
  serverTime: string;
  timezone: string;
  terminal: TerminalRecord;
  cacheRevision: number;
  maxOfflineSeconds: 86400;
  maxQueuedActions: 10000;
}

export interface TerminalResolveResponse {
  scanContext: string;
  expiresAt: string;
  employee: { id: string; displayName: string };
  state: TerminalWorkState;
}

export interface TerminalActionRequest {
  clientRequestId: string;
  scanContext: string;
  command: TerminalCommand;
  deviceCapturedAt: string;
  appliedAt?: string;
  clockSyncedAt: string;
  deviceSequence: number;
}

export interface TerminalQueuedAction extends Omit<TerminalActionRequest, 'scanContext'> {
  uid: string;
  rebootId: string;
  previousLocalHash: string;
  signature: string;
}

export interface TerminalActionResult {
  clientRequestId: string;
  status: TerminalActionStatus;
  workEventId?: string;
  incidentId?: string;
  state: TerminalWorkState;
  errorCode?: TerminalErrorCode;
}

export interface TerminalEmployee {
  id: string;
  name: string;
  displayName: string;
  hasRfidTag: boolean;
}

export interface TerminalIncidentRecord extends RecordModel {
  organization: string;
  terminal: string;
  employee: string;
  employeeName: string;
  terminalName: string;
  clientRequestId: string;
  command: TerminalCommand;
  deviceCapturedAt: string;
  appliedAt: string;
  reasonCode: string;
  status: 'pending' | 'resolved';
  resolvedBy: string;
  resolvedAt: string;
  resolutionNote: string;
}
