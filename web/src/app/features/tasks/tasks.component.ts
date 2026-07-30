import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { EmployeeTaskRecord, UserRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-tasks',
  imports: [FormsModule],
  templateUrl: './tasks.component.html',
})
export class TasksComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly tasks = signal<EmployeeTaskRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly formOpen = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly completion = computed(() => {
    if (!this.tasks().length) return 0;
    return Math.round(
      (this.tasks().filter((task) => task.status === 'completed').length /
        this.tasks().length) *
        100,
    );
  });
  protected readonly openCount = computed(
    () => this.tasks().filter((task) => task.status !== 'completed').length,
  );

  protected assignee = '';
  protected title = '';
  protected description = '';
  protected category: EmployeeTaskRecord['category'] = 'onboarding';
  protected dueDate = '';
  protected required = true;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const [tasks, members] = await Promise.all([
        this.pb.collection('employee_tasks').getFullList({
          sort: 'status,dueDate',
          expand: 'assignee',
        }),
        this.canManage()
          ? this.pb.collection('users').getFullList({
              sort: 'name',
              filter: 'active = true',
              fields: 'id,name,employeeCode',
            })
          : Promise.resolve([]),
      ]);
      this.tasks.set(tasks as EmployeeTaskRecord[]);
      this.members.set(members as UserRecord[]);
      this.assignee ||= (members[0] as UserRecord | undefined)?.id ?? user.id;
    } catch {
      this.error.set('No se han podido cargar las tareas.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async create(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.pb.collection('employee_tasks').create({
        organization: user.organization,
        assignee: this.assignee,
        title: this.title,
        description: this.description,
        category: this.category,
        dueDate: this.dueDate
          ? new Date(`${this.dueDate}T23:59:59`).toISOString()
          : '',
        required: this.required,
        status: 'pending',
        createdBy: user.id,
      });
      this.formOpen.set(false);
      this.title = '';
      this.description = '';
      this.dueDate = '';
      this.success.set('Tarea asignada.');
      await this.load();
    } catch {
      this.error.set('No se pudo asignar la tarea.');
    }
  }

  protected async setStatus(
    task: EmployeeTaskRecord,
    status: 'in_progress' | 'completed',
  ): Promise<void> {
    try {
      await this.pb.collection('employee_tasks').update(task.id, { status });
      this.success.set(status === 'completed' ? 'Tarea completada.' : 'Tarea iniciada.');
      await this.load();
    } catch {
      this.error.set('No se pudo actualizar la tarea.');
    }
  }

  protected categoryLabel(category: EmployeeTaskRecord['category']): string {
    return {
      onboarding: 'Incorporación',
      training: 'Formación',
      administrative: 'Administrativa',
      other: 'Otra',
    }[category];
  }

  protected isOverdue(task: EmployeeTaskRecord): boolean {
    return Boolean(
      task.dueDate &&
        task.status !== 'completed' &&
        new Date(task.dueDate).getTime() < Date.now(),
    );
  }

  protected date(value: string): string {
    return value
      ? new Intl.DateTimeFormat('es-ES', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date(value))
      : 'Sin fecha';
  }
}
