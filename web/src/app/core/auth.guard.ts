import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.authenticated() || inject(Router).createUrlTree(['/login']);
};

export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return !auth.authenticated() || inject(Router).createUrlTree(['/']);
};

export const teamManagerGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.canManageTeam() || inject(Router).createUrlTree(['/']);
};

export const reportViewerGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.canViewReports() || inject(Router).createUrlTree(['/']);
};

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return (
    auth.user()?.role === 'admin' || inject(Router).createUrlTree(['/'])
  );
};
