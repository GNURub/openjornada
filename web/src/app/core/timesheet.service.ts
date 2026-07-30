import { inject, Injectable } from '@angular/core';
import { ManualTimeInterval, ManualTimeRequestRecord, TimesheetResponse } from './models';
import { PocketBaseService } from './pocketbase.service';

@Injectable({ providedIn: 'root' })
export class TimesheetService {
  private readonly pb = inject(PocketBaseService).client;

  load(from: string, to: string, employee = ''): Promise<TimesheetResponse> {
    const params = new URLSearchParams({ from, to });
    if (employee) params.set('employee', employee);
    return this.pb.send<TimesheetResponse>(`/api/openjornada/timesheet?${params.toString()}`, {
      method: 'GET',
    });
  }

  create(
    workDate: string,
    intervals: ManualTimeInterval[],
    reason: string,
  ): Promise<ManualTimeRequestRecord> {
    return this.pb.send<ManualTimeRequestRecord>('/api/openjornada/manual-time-requests', {
      method: 'POST',
      body: { workDate, intervals, reason },
    });
  }

  correct(
    workDate: string,
    intervals: ManualTimeInterval[],
    reason: string,
  ): Promise<ManualTimeRequestRecord> {
    return this.pb.send<ManualTimeRequestRecord>('/api/openjornada/timesheet-corrections', {
      method: 'POST',
      body: { workDate, intervals, reason },
    });
  }

  resolve(
    requestId: string,
    status: 'approved' | 'rejected',
    resolutionNote: string,
  ): Promise<ManualTimeRequestRecord> {
    return this.pb.send<ManualTimeRequestRecord>(
      `/api/openjornada/manual-time-requests/${requestId}/resolve`,
      {
        method: 'POST',
        body: { status, resolutionNote },
      },
    );
  }

  cancel(requestId: string): Promise<ManualTimeRequestRecord> {
    return this.pb.send<ManualTimeRequestRecord>(
      `/api/openjornada/manual-time-requests/${requestId}/cancel`,
      { method: 'POST' },
    );
  }
}
