import { Routes } from '@angular/router';
import {
  adminGuard,
  authGuard,
  guestGuard,
  reportViewerGuard,
  teamManagerGuard,
} from './core/auth.guard';

export const routes: Routes = [
  {
    path: 'restablecer/:token',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/account/reset-password.component').then(
        (component) => component.ResetPasswordComponent,
      ),
  },
  {
    path: 'verificar/:token',
    loadComponent: () =>
      import('./features/account/verify-email.component').then(
        (component) => component.VerifyEmailComponent,
      ),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/login/login.component').then(
        (component) => component.LoginComponent,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./shared/shell.component').then(
        (component) => component.ShellComponent,
      ),
    children: [
      {
        path: '',
        loadComponent: () =>
          import('./features/dashboard/dashboard.component').then(
            (component) => component.DashboardComponent,
          ),
      },
      {
        path: 'registros',
        loadComponent: () =>
          import('./features/records/records.component').then(
            (component) => component.RecordsComponent,
          ),
      },
      {
        path: 'ausencias',
        loadComponent: () =>
          import('./features/leave/leave.component').then(
            (component) => component.LeaveComponent,
          ),
      },
      {
        path: 'horarios',
        loadComponent: () =>
          import('./features/schedules/schedules.component').then(
            (component) => component.SchedulesComponent,
          ),
      },
      {
        path: 'avisos',
        loadComponent: () =>
          import('./features/communications/communications.component').then(
            (component) => component.CommunicationsComponent,
          ),
      },
      {
        path: 'gastos',
        loadComponent: () =>
          import('./features/expenses/expenses.component').then(
            (component) => component.ExpensesComponent,
          ),
      },
      {
        path: 'documentos',
        loadComponent: () =>
          import('./features/documents/documents.component').then(
            (component) => component.DocumentsComponent,
          ),
      },
      {
        path: 'tareas',
        loadComponent: () =>
          import('./features/tasks/tasks.component').then(
            (component) => component.TasksComponent,
          ),
      },
      {
        path: 'objetivos',
        loadComponent: () =>
          import('./features/goals/goals.component').then(
            (component) => component.GoalsComponent,
          ),
      },
      {
        path: 'informes',
        canActivate: [reportViewerGuard],
        loadComponent: () =>
          import('./features/reports/reports.component').then(
            (component) => component.ReportsComponent,
          ),
      },
      {
        path: 'ajustes',
        canActivate: [adminGuard],
        loadComponent: () =>
          import('./features/settings/settings.component').then(
            (component) => component.SettingsComponent,
          ),
      },
      {
        path: 'equipo',
        canActivate: [teamManagerGuard],
        loadComponent: () =>
          import('./features/team/team.component').then(
            (component) => component.TeamComponent,
          ),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
