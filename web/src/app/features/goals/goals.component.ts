import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { GoalRecord, UserRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-goals',
  imports: [FormsModule],
  templateUrl: './goals.component.html',
})
export class GoalsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly goals = signal<GoalRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly formOpen = signal(false);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly averageProgress = computed(() => {
    if (!this.goals().length) return 0;
    return Math.round(
      this.goals().reduce((sum, goal) => sum + goal.progress, 0) /
        this.goals().length,
    );
  });

  protected employee = '';
  protected title = '';
  protected description = '';
  protected cycle = `${new Date().getFullYear()} · Anual`;
  protected dueDate = '';
  protected isPublic = false;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      const [goals, members] = await Promise.all([
        this.pb.collection('goals').getFullList({
          sort: 'status,dueDate',
          expand: 'employee',
        }),
        this.canManage()
          ? this.pb.collection('users').getFullList({
              sort: 'name',
              filter: 'active = true',
              fields: 'id,name,employeeCode',
            })
          : Promise.resolve([]),
      ]);
      this.goals.set(goals as GoalRecord[]);
      this.members.set(members as UserRecord[]);
      this.employee ||= (members[0] as UserRecord | undefined)?.id ?? user.id;
    } catch {
      this.error.set('No se han podido cargar los objetivos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async create(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      await this.pb.collection('goals').create({
        organization: user.organization,
        employee: this.employee,
        title: this.title,
        description: this.description,
        cycle: this.cycle,
        dueDate: this.dueDate
          ? new Date(`${this.dueDate}T23:59:59`).toISOString()
          : '',
        progress: 0,
        status: 'active',
        public: this.isPublic,
        createdBy: user.id,
      });
      this.formOpen.set(false);
      this.title = '';
      this.description = '';
      this.dueDate = '';
      this.success.set('Objetivo asignado.');
      await this.load();
    } catch {
      this.error.set('No se pudo crear el objetivo.');
    }
  }

  protected async updateProgress(goal: GoalRecord, progress: number): Promise<void> {
    try {
      await this.pb.collection('goals').update(goal.id, {
        progress,
        status: progress === 100 ? 'completed' : 'active',
      });
      this.success.set('Progreso actualizado.');
      await this.load();
    } catch {
      this.error.set('No se pudo actualizar el progreso.');
    }
  }

  protected increaseProgress(goal: GoalRecord): void {
    void this.updateProgress(goal, Math.min(100, goal.progress + 10));
  }

  protected date(value: string): string {
    return value
      ? new Intl.DateTimeFormat('es-ES', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        }).format(new Date(value))
      : 'Sin fecha límite';
  }
}
