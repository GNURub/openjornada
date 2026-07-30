import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { BrandingService } from '../core/branding.service';
import { WorktimeService } from '../core/worktime.service';
import { ActiveWorktimeWidgetComponent } from './active-worktime-widget.component';
import { WorktimeReviewModalComponent } from './worktime-review-modal.component';

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    ActiveWorktimeWidgetComponent,
    WorktimeReviewModalComponent,
  ],
  templateUrl: './shell.component.html',
})
export class ShellComponent {
  protected readonly auth = inject(AuthService);
  protected readonly branding = inject(BrandingService);
  protected readonly worktime = inject(WorktimeService);

  constructor() {
    void this.worktime.loadToday();
  }
}
