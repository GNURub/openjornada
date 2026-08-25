import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { PlatformAuthService } from './platform-auth.service';

export const platformAuthGuard: CanActivateFn = () => {
  const auth = inject(PlatformAuthService);
  return auth.authenticated() || inject(Router).createUrlTree(['/proveedor/login']);
};

export const platformGuestGuard: CanActivateFn = () => {
  const auth = inject(PlatformAuthService);
  return !auth.authenticated() || inject(Router).createUrlTree(['/proveedor']);
};
