import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  ExpenseCategoryRecord,
  ExpenseRecord,
  ExpenseStatus,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-expenses',
  imports: [FormsModule],
  templateUrl: './expenses.component.html',
})
export class ExpensesComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly expenses = signal<ExpenseRecord[]>([]);
  protected readonly categories = signal<ExpenseCategoryRecord[]>([]);
  protected readonly formOpen = signal(false);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly filter = signal<'all' | ExpenseStatus>('all');
  protected readonly canApprove = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly isAdmin = computed(
    () => this.auth.user()?.role === 'admin',
  );
  protected readonly filtered = computed(() =>
    this.filter() === 'all'
      ? this.expenses()
      : this.expenses().filter((expense) => expense.status === this.filter()),
  );
  protected readonly pendingTotal = computed(() =>
    this.expenses()
      .filter((expense) => expense.status === 'pending')
      .reduce((sum, expense) => sum + expense.amount, 0),
  );
  protected readonly outOfPolicyCount = computed(
    () => this.expenses().filter((expense) => expense.outOfPolicy).length,
  );

  protected merchant = '';
  protected category = '';
  protected amount: number | null = null;
  protected expenseDate = this.today();
  protected description = '';
  protected receipt: File | null = null;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [expenses, categories] = await Promise.all([
        this.pb.collection('expenses').getFullList({
          sort: '-expenseDate,-created',
          expand: 'employee,category',
        }),
        this.pb.collection('expense_categories').getFullList({
          sort: 'name',
          filter: 'active = true',
        }),
      ]);
      this.expenses.set(expenses as ExpenseRecord[]);
      this.categories.set(categories as ExpenseCategoryRecord[]);
      this.category ||= (categories[0] as ExpenseCategoryRecord | undefined)?.id ?? '';
    } catch {
      this.error.set('No se han podido cargar los gastos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected onReceipt(event: Event): void {
    this.receipt = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  protected async create(status: 'draft' | 'pending'): Promise<void> {
    const user = this.auth.user();
    if (!user || !this.amount || !this.category) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const data = new FormData();
      data.set('organization', user.organization);
      data.set('employee', user.id);
      data.set('category', this.category);
      data.set('merchant', this.merchant);
      data.set('expenseDate', new Date(`${this.expenseDate}T12:00:00`).toISOString());
      data.set('amount', String(this.amount));
      data.set('currency', 'EUR');
      data.set('description', this.description);
      data.set('status', status);
      if (this.receipt) data.set('receipt', this.receipt);
      await this.pb.collection('expenses').create(data);
      this.formOpen.set(false);
      this.reset();
      this.success.set(
        status === 'pending'
          ? 'Gasto enviado para aprobación.'
          : 'Borrador guardado.',
      );
      await this.load();
    } catch {
      this.error.set('No se pudo guardar el gasto. Revisa los datos y el archivo.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async resolve(
    expense: ExpenseRecord,
    status: 'changes_requested' | 'approved' | 'rejected' | 'paid',
  ): Promise<void> {
    try {
      await this.pb.collection('expenses').update(expense.id, {
        status,
        reviewComment: {
          changes_requested: 'Falta información o un justificante correcto.',
          approved: 'Gasto validado.',
          rejected: 'El gasto no cumple la política.',
          paid: 'Reembolso completado.',
        }[status],
      });
      this.success.set(
        status === 'approved'
          ? 'Gasto aprobado.'
          : status === 'paid'
            ? 'Gasto marcado como pagado.'
            : 'Estado del gasto actualizado.',
      );
      await this.load();
    } catch {
      this.error.set('No se pudo actualizar el gasto.');
    }
  }

  protected async openReceipt(expense: ExpenseRecord): Promise<void> {
    if (!expense.receipt) return;
    try {
      const token = await this.pb.files.getToken();
      const url = this.pb.files.getURL(expense, expense.receipt, { token });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      this.error.set('No se pudo abrir el justificante.');
    }
  }

  protected statusLabel(status: ExpenseStatus): string {
    return {
      draft: 'Borrador',
      pending: 'Pendiente',
      changes_requested: 'Cambios solicitados',
      approved: 'Aprobado',
      rejected: 'Rechazado',
      paid: 'Pagado',
    }[status];
  }

  protected money(value: number): string {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: 'EUR',
    }).format(value);
  }

  protected date(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(value));
  }

  private reset(): void {
    this.merchant = '';
    this.amount = null;
    this.description = '';
    this.receipt = null;
    this.expenseDate = this.today();
  }

  private today(): string {
    const date = new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
  }
}
