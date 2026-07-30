import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { EmployeeDocumentRecord, UserRecord } from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

@Component({
  selector: 'app-documents',
  imports: [FormsModule],
  templateUrl: './documents.component.html',
})
export class DocumentsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly documents = signal<EmployeeDocumentRecord[]>([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly formOpen = signal(false);
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly pendingAcknowledgements = computed(
    () =>
      this.documents().filter(
        (document) =>
          document.employee === this.auth.user()?.id &&
          document.acknowledgementRequired &&
          !document.acknowledgedAt,
      ).length,
  );

  protected employee = '';
  protected title = '';
  protected category: EmployeeDocumentRecord['category'] = 'other';
  protected visibility: EmployeeDocumentRecord['visibility'] = 'employee';
  protected acknowledgementRequired = false;
  protected file: File | null = null;

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.loading.set(true);
    try {
      const [documents, members] = await Promise.all([
        this.pb.collection('employee_documents').getFullList({
          sort: '-created',
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
      this.documents.set(documents as EmployeeDocumentRecord[]);
      this.members.set(members as UserRecord[]);
      this.employee ||= this.canManage()
        ? ((members[0] as UserRecord | undefined)?.id ?? user.id)
        : user.id;
    } catch {
      this.error.set('No se han podido cargar los documentos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected onFile(event: Event): void {
    this.file = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  protected async upload(): Promise<void> {
    const user = this.auth.user();
    if (!user || !this.file || !this.employee) return;
    this.saving.set(true);
    this.error.set('');
    try {
      const data = new FormData();
      data.set('organization', user.organization);
      data.set('employee', this.employee);
      data.set('title', this.title);
      data.set('category', this.category);
      data.set('visibility', this.visibility);
      data.set('acknowledgementRequired', String(this.acknowledgementRequired));
      data.set('uploadedBy', user.id);
      data.set('file', this.file);
      await this.pb.collection('employee_documents').create(data);
      this.formOpen.set(false);
      this.title = '';
      this.file = null;
      this.acknowledgementRequired = false;
      this.success.set('Documento guardado de forma segura.');
      await this.load();
    } catch {
      this.error.set('No se pudo subir el documento.');
    } finally {
      this.saving.set(false);
    }
  }

  protected async open(document: EmployeeDocumentRecord): Promise<void> {
    try {
      const token = await this.pb.files.getToken();
      const url = this.pb.files.getURL(document, document.file, { token });
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      this.error.set('No se pudo abrir el documento.');
    }
  }

  protected async acknowledge(document: EmployeeDocumentRecord): Promise<void> {
    try {
      await this.pb.collection('employee_documents').update(document.id, {
        acknowledgedAt: new Date().toISOString(),
      });
      this.success.set('Lectura confirmada.');
      await this.load();
    } catch {
      this.error.set('No se pudo confirmar la lectura.');
    }
  }

  protected categoryLabel(category: EmployeeDocumentRecord['category']): string {
    return {
      contract: 'Contrato',
      payroll: 'Nómina',
      identity: 'Identidad',
      medical: 'Médico',
      training: 'Formación',
      other: 'Otro',
    }[category];
  }

  protected date(value: string): string {
    return new Intl.DateTimeFormat('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(value));
  }
}
