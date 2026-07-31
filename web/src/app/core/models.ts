import type { RecordModel } from 'pocketbase';

export type UserRole = 'admin' | 'manager' | 'employee' | 'representative';
export type WorkEventKind = 'clock_in' | 'break_start' | 'break_end' | 'clock_out' | 'correction';
export type WorkStatus = 'off' | 'working' | 'paused';

export interface UserRecord extends RecordModel {
  email: string;
  name: string;
  organization: string;
  role: UserRole;
  active: boolean;
  employeeCode: string;
  weeklyHours: number;
  employmentType: 'unknown' | 'full_time' | 'part_time';
  contractedWeeklyMinutes: number;
  complementaryHoursAgreement: boolean;
  jobTitle: string;
  privacyNoticeAcknowledgedVersion: string;
  privacyNoticeAcknowledgedAt: string;
  invitationStatus: '' | 'pending' | 'accepted';
  invitationSentAt: string;
  invitationExpiresAt: string;
  invitationAcceptedAt: string;
}

export interface McpTokenRecord {
  id: string;
  name: string;
  prefix: string;
  createdBy: string;
  actorName: string;
  actorRole: UserRole;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string;
  created: string;
  token?: string;
}

export interface OrganizationRecord extends RecordModel {
  name: string;
  taxId: string;
  timezone: string;
  retentionYears: number;
  privacyContact: string;
  privacyNoticeVersion: string;
  brandPrimaryColor: string;
  brandSecondaryColor: string;
  brandLogo: string;
  pwaName: string;
  pwaShortName: string;
  pwaIcon: string;
  manualTimeApprovalRequired: boolean;
  timeCorrectionApprovalRequired: boolean;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  countryCode: 'ES' | '';
  autonomousCommunityCode: string;
  autonomousCommunitySlug: string;
  autonomousCommunityName: string;
  provinceCode: string;
  provinceSlug: string;
  provinceName: string;
  municipalityIne: string;
  municipalitySlug: string;
  municipalityName: string;
  locationUpdatedAt: string;
}

export interface LaborCalendarCommunity {
  code: string;
  slug: string;
  name: string;
}

export interface LaborCalendarProvince {
  code: string;
  slug: string;
  name: string;
}

export interface LaborCalendarMunicipality {
  ine: string;
  slug: string;
  name: string;
}

export interface LaborCalendarCatalog<T> {
  items: T[];
  provider: { name: string; url: string };
}

export interface LaborCalendarPreviewHoliday {
  date: string;
  name: string;
  scope: 'nacional' | 'autonomico' | 'provincial' | 'local';
  source: string;
  sourceUrl: string;
  existing: boolean;
  existingName?: string;
}

export interface LaborCalendarPreview {
  year: number;
  location: {
    communityName: string;
    provinceName: string;
    municipalityName: string;
    municipalityIne: string;
  };
  generatedAt: string;
  confidence: string;
  warnings: string[];
  disclaimer: string;
  items: LaborCalendarPreviewHoliday[];
  provider: { name: string; url: string };
}

export interface PrivacyNotice {
  version: string;
  acknowledged: boolean;
  acknowledgedAt: string;
  responsible: string;
  taxId: string;
  privacyContact: string;
  retentionYears: number;
  purpose: string;
  legalBasis: string;
  recipients: string;
  rights: string;
}

export interface LegalHoldRecord extends RecordModel {
  organization: string;
  employee: string;
  reason: string;
  fromDate: string;
  toDate: string;
  active: boolean;
  createdBy: string;
  releasedBy: string;
  releasedAt: string;
  created: string;
  expand?: { employee?: UserRecord };
}

export interface RetentionPreview {
  retentionYears: number;
  cutoff: string;
  activeLegalHolds: number;
  recordsPastRetention: number;
  protectedByLegalHold: number;
  eligibleForFuturePurge: number;
  destructiveActionExecuted: boolean;
}

export interface MonthlyTimeStatement extends RecordModel {
  organization: string;
  employee: string;
  period: string;
  version: number;
  employmentType: 'full_time' | 'part_time';
  contractedMinutes: number;
  ordinaryMinutes: number;
  complementaryMinutes: number;
  overtimeMinutes: number;
  totalMinutes: number;
  dailyRecords: Array<{
    date: string;
    plannedMinutes: number;
    workedMinutes: number;
    ordinaryMinutes: number;
    complementaryMinutes: number;
    overtimeMinutes: number;
    events: Array<{
      id: string;
      kind: Exclude<WorkEventKind, 'correction'>;
      occurredAt: string;
      integrityHash: string;
    }>;
  }>;
  generatedBy: string;
  generatedAt: string;
  deliveredAt: string;
  previousStatement: string;
  previousHash: string;
  integrityHash: string;
  expand?: { employee?: UserRecord; generatedBy?: UserRecord };
}

export interface MonthlyStatementAcknowledgement extends RecordModel {
  organization: string;
  statement: string;
  user: string;
  acknowledgedAt: string;
}

export interface WorkEventRecord extends RecordModel {
  created: string;
  updated: string;
  employee: string;
  organization: string;
  kind: WorkEventKind;
  occurredAt: string;
  recordedAt: string;
  adjustmentSeconds: number;
  adjustmentReason: string;
  integrityVersion: 'v1' | 'v2' | '';
  timezone: string;
  source: 'desktop' | 'mobile' | 'tablet' | 'admin' | 'manual';
  note: string;
  createdBy: string;
  corrects: string;
  correctedKind: Exclude<WorkEventKind, 'correction'> | '';
  previousHash: string;
  integrityHash: string;
  clientRequestId: string;
  manualRequest: string;
  breakType: string;
  breakPaid: boolean;
  voidsTarget: boolean;
}

export interface BreakTypeRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  name: string;
  paid: boolean;
  active: boolean;
}

export interface ManualTimeInterval {
  kind: 'work' | 'break';
  start: string;
  end: string;
  startNextDay: boolean;
  breakType: string;
  breakTypeName?: string;
  breakPaid?: boolean;
  startAt?: string;
  endAt?: string;
}

export interface ManualTimeRequestRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  workDate: string;
  timezone: string;
  intervals: ManualTimeInterval[];
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  approvalRequired: boolean;
  requestType: 'addition' | 'replacement';
  timeStorageVersion: 'utc_wall_v0' | 'iana_v1';
  originalIntervals: ManualTimeInterval[];
  targetEvents: string[];
  baseFingerprint: string;
  resolvedBy: string;
  resolvedAt: string;
  resolutionNote: string;
  expand?: { employee?: UserRecord };
}

export interface TimesheetEvent {
  id: string;
  kind: Exclude<WorkEventKind, 'correction'>;
  occurredAt: string;
  source: WorkEventRecord['source'];
  note: string;
  manualRequest: string;
  breakType: string;
  breakPaid: boolean;
  integrityHash: string;
}

export interface TimesheetRequestSummary {
  id: string;
  requestType: 'addition' | 'replacement';
  status: ManualTimeRequestRecord['status'];
  reason: string;
  intervals: ManualTimeInterval[];
  originalIntervals: ManualTimeInterval[];
  approvalRequired: boolean;
  resolutionNote: string;
  created: string;
}

export interface TimesheetDay {
  date: string;
  workedMinutes: number;
  plannedMinutes: number;
  balanceMinutes: number;
  overtimeMinutes: number;
  holiday: string;
  absences: Array<{ name: string; dayPart: 'full' | 'morning' | 'afternoon' }>;
  events: TimesheetEvent[];
  editableIntervals: ManualTimeInterval[];
  requests: TimesheetRequestSummary[];
  anomaly: boolean;
  canAddManualTime: boolean;
  canCorrectTime: boolean;
}

export interface TimesheetResponse {
  employee: { id: string; name: string; employeeCode: string };
  timezone: string;
  from: string;
  to: string;
  approvalRequired: boolean;
  correctionApprovalRequired: boolean;
  totals: {
    workedMinutes: number;
    plannedMinutes: number;
    balanceMinutes: number;
    overtimeMinutes: number;
  };
  days: TimesheetDay[];
}

export interface CorrectionRequestRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  workEvent: string;
  requestedKind: Exclude<WorkEventKind, 'correction'>;
  requestedOccurredAt: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  resolvedBy: string;
  resolvedAt: string;
  resolutionNote: string;
  expand?: { employee?: UserRecord; workEvent?: WorkEventRecord };
}

export interface WorkScheduleRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  name: string;
  validFrom: string;
  validUntil: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  breakMinutes: number;
  active: boolean;
  createdBy: string;
  expand?: { employee?: UserRecord };
}

export type LeaveType = 'vacation' | 'medical' | 'personal' | 'other';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequestRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  dayPart: 'full' | 'morning' | 'afternoon';
  reason: string;
  status: LeaveStatus;
  reviewedBy: string;
  reviewedAt: string;
  response: string;
  leaveType: string;
  requestedDays: number;
  assignedBy: string;
  attachment: string;
  expand?: { employee?: UserRecord; leaveType?: LeaveTypeRecord };
}

export interface LeaveTypeRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  code: LeaveType;
  name: string;
  color: string;
  deductsBalance: boolean;
  requiresApproval: boolean;
  requiresDocument: boolean;
  active: boolean;
}

export interface LeaveBalanceRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  leaveType: string;
  year: number;
  allowance: number;
  carriedOver: number;
  adjustment: number;
  updatedBy: string;
  expand?: { employee?: UserRecord; leaveType?: LeaveTypeRecord };
}

export interface LeaveBlackoutRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  leaveType: string;
  name: string;
  startDate: string;
  endDate: string;
  reason: string;
  expand?: { leaveType?: LeaveTypeRecord };
}

export interface PublicHolidayRecord extends RecordModel {
  created: string;
  organization: string;
  name: string;
  date: string;
  scope: 'nacional' | 'autonomico' | 'provincial' | 'local' | 'manual' | '';
  source: string;
  sourceUrl: string;
  importProvider: 'calendariosnacionales' | '';
  importedAt: string;
}

export interface ExpenseCategoryRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  name: string;
  color: string;
  limitAmount: number;
  active: boolean;
}

export type ExpenseStatus =
  'draft' | 'pending' | 'changes_requested' | 'approved' | 'rejected' | 'paid';

export interface ExpenseRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  category: string;
  merchant: string;
  expenseDate: string;
  amount: number;
  currency: string;
  description: string;
  receipt: string;
  status: ExpenseStatus;
  outOfPolicy: boolean;
  reviewComment: string;
  reviewedBy: string;
  reviewedAt: string;
  paidAt: string;
  expand?: { employee?: UserRecord; category?: ExpenseCategoryRecord };
}

export interface EmployeeDocumentRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  folder: string;
  title: string;
  category: 'contract' | 'payroll' | 'identity' | 'medical' | 'training' | 'other';
  visibility: 'employee' | 'company' | 'management' | 'folder';
  file: string;
  acknowledgementRequired: boolean;
  acknowledgedAt: string;
  uploadedBy: string;
  expand?: { employee?: UserRecord; folder?: DocumentFolderRecord };
}

export type DocumentFolderVisibility = 'company' | 'selected' | 'management';

export interface DocumentFolderRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  name: string;
  visibility: DocumentFolderVisibility;
  allowedUsers: string[];
  createdBy: string;
  expand?: { allowedUsers?: UserRecord[] };
}

export interface DocumentAcknowledgementRecord extends RecordModel {
  created: string;
  organization: string;
  document: string;
  user: string;
  acknowledgedAt: string;
  expand?: { user?: UserRecord };
}

export interface EmployeeTaskRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  assignee: string;
  title: string;
  description: string;
  category: 'onboarding' | 'training' | 'administrative' | 'other';
  dueDate: string;
  required: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  completedAt: string;
  createdBy: string;
  expand?: { assignee?: UserRecord };
}

export interface GoalRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  employee: string;
  title: string;
  description: string;
  cycle: string;
  dueDate: string;
  progress: number;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  public: boolean;
  createdBy: string;
  expand?: { employee?: UserRecord };
}

export interface NotificationRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  recipient: string;
  title: string;
  message: string;
  kind: 'info' | 'success' | 'warning' | 'request';
  link: string;
  read: boolean;
  createdBy: string;
}

export interface AnnouncementRecord extends RecordModel {
  created: string;
  updated: string;
  organization: string;
  title: string;
  body: string;
  audience: 'all' | 'employees' | 'managers';
  sendEmail: boolean;
  createdBy: string;
  publishedAt: string;
}
