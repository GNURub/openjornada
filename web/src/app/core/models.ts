import type { RecordModel } from 'pocketbase';

export type UserRole = 'admin' | 'manager' | 'employee' | 'representative';
export type WorkEventKind =
  | 'clock_in'
  | 'break_start'
  | 'break_end'
  | 'clock_out'
  | 'correction';
export type WorkStatus = 'off' | 'working' | 'paused';

export interface UserRecord extends RecordModel {
  email: string;
  name: string;
  organization: string;
  role: UserRole;
  active: boolean;
  employeeCode: string;
  weeklyHours: number;
  jobTitle: string;
}

export interface WorkEventRecord extends RecordModel {
  created: string;
  updated: string;
  employee: string;
  organization: string;
  kind: WorkEventKind;
  occurredAt: string;
  timezone: string;
  source: 'desktop' | 'mobile' | 'tablet' | 'admin';
  note: string;
  createdBy: string;
  corrects: string;
  correctedKind: Exclude<WorkEventKind, 'correction'> | '';
  previousHash: string;
  integrityHash: string;
  clientRequestId: string;
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
  | 'draft'
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'paid';

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
  title: string;
  category: 'contract' | 'payroll' | 'identity' | 'medical' | 'training' | 'other';
  visibility: 'employee' | 'company' | 'management';
  file: string;
  acknowledgementRequired: boolean;
  acknowledgedAt: string;
  uploadedBy: string;
  expand?: { employee?: UserRecord };
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
