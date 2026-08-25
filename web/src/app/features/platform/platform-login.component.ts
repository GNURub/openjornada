import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PlatformAuthService } from '../../core/platform-auth.service';

@Component({
  selector: 'app-platform-login',
  imports: [FormsModule],
  templateUrl: './platform-login.component.html',
})
export class PlatformLoginComponent {
  protected readonly auth = inject(PlatformAuthService);
  protected email = '';
  protected password = '';
  protected otp = '';

  protected async submit(): Promise<void> {
    if (this.auth.otpRequired()) {
      await this.auth.verifyOtp(this.otp);
      return;
    }
    await this.auth.login(this.email, this.password);
  }
}
