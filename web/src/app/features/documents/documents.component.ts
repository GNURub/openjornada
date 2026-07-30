import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import {
  type DocumentAcknowledgementRecord,
  type DocumentFolderRecord,
  type DocumentFolderVisibility,
  type EmployeeDocumentRecord,
  type UserRecord,
} from '../../core/models';
import { PocketBaseService } from '../../core/pocketbase.service';

type FolderSelection = 'all' | 'root' | string;

@Component({
  selector: 'app-documents',
  imports: [FormsModule],
  templateUrl: './documents.component.html',
})
export class DocumentsComponent {
  private readonly pb = inject(PocketBaseService).client;
  protected readonly auth = inject(AuthService);
  protected readonly documents = signal<EmployeeDocumentRecord[]>([]);
  protected readonly folders = signal<DocumentFolderRecord[]>([]);
  protected readonly acknowledgements = signal<
    DocumentAcknowledgementRecord[]
  >([]);
  protected readonly members = signal<UserRecord[]>([]);
  protected readonly selectedFolder = signal<FolderSelection>('all');
  protected readonly formOpen = signal(false);
  protected readonly folderFormOpen = signal(false);
  protected readonly editingFolder = signal<DocumentFolderRecord | null>(null);
  protected readonly movingDocument = signal<EmployeeDocumentRecord | null>(
    null,
  );
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly canManage = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'admin' || role === 'manager';
  });
  protected readonly filteredDocuments = computed(() => {
    const selected = this.selectedFolder();
    if (selected === 'all') return this.documents();
    if (selected === 'root') {
      return this.documents().filter((document) => !document.folder);
    }
    return this.documents().filter((document) => document.folder === selected);
  });
  protected readonly selectedFolderRecord = computed(() => {
    const selected = this.selectedFolder();
    return this.folders().find((folder) => folder.id === selected);
  });
  protected readonly pendingAcknowledgements = computed(
    () =>
      this.documents().filter(
        (document) =>
          document.acknowledgementRequired &&
          this.canCurrentUserAcknowledge(document) &&
          !this.hasCurrentUserAcknowledged(document),
      ).length,
  );

  protected employee = '';
  protected title = '';
  protected category: EmployeeDocumentRecord['category'] = 'other';
  protected visibility: Exclude<
    EmployeeDocumentRecord['visibility'],
    'folder'
  > = 'employee';
  protected uploadFolder = '';
  protected acknowledgementRequired = false;
  protected file: File | null = null;

  protected folderName = '';
  protected folderVisibility: DocumentFolderVisibility = 'management';
  protected folderUsers: string[] = [];

  protected moveFolder = '';
  protected moveEmployee = '';
  protected moveVisibility: Exclude<
    EmployeeDocumentRecord['visibility'],
    'folder'
  > = 'employee';

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [documents, folders, acknowledgements, members] =
        await Promise.all([
          this.pb.collection('employee_documents').getFullList({
            sort: '-created',
            expand: 'employee,folder',
          }),
          this.pb.collection('document_folders').getFullList({
            sort: 'name',
            expand: 'allowedUsers',
          }),
          this.pb.collection('document_acknowledgements').getFullList({
            sort: 'created',
            expand: 'user',
          }),
          this.canManage()
            ? this.pb.collection('users').getFullList({
                sort: 'name',
                filter: 'active = true',
                fields: 'id,name,employeeCode,role,active',
              })
            : Promise.resolve([]),
        ]);
      this.documents.set(documents as EmployeeDocumentRecord[]);
      this.folders.set(folders as DocumentFolderRecord[]);
      this.acknowledgements.set(
        acknowledgements as DocumentAcknowledgementRecord[],
      );
      this.members.set(members as UserRecord[]);
      this.employee ||= this.canManage()
        ? ((members[0] as UserRecord | undefined)?.id ?? user.id)
        : user.id;
      this.moveEmployee ||= this.employee;
      const selected = this.selectedFolder();
      if (
        selected !== 'all' &&
        selected !== 'root' &&
        !(folders as DocumentFolderRecord[]).some(
          (folder) => folder.id === selected,
        )
      ) {
        this.selectedFolder.set('all');
      }
    } catch {
      this.error.set('No se han podido cargar los documentos.');
    } finally {
      this.loading.set(false);
    }
  }

  protected selectFolder(folder: FolderSelection): void {
    this.selectedFolder.set(folder);
    this.error.set('');
    this.success.set('');
  }

  protected openUpload(): void {
    const selected = this.selectedFolder();
    this.uploadFolder =
      selected !== 'all' && selected !== 'root' ? selected : '';
    this.formOpen.set(true);
    this.folderFormOpen.set(false);
    this.movingDocument.set(null);
    this.error.set('');
    this.success.set('');
  }

  protected onFile(event: Event): void {
    this.file = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  protected async upload(): Promise<void> {
    const user = this.auth.user();
    const normalizedTitle = this.title.trim();
    if (!normalizedTitle) {
      this.error.set('El título es obligatorio.');
      return;
    }
    if (
      !user ||
      !this.file ||
      (!this.uploadFolder && !this.employee)
    ) {
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      const data = new FormData();
      data.set('organization', user.organization);
      data.set('title', normalizedTitle);
      data.set('category', this.category);
      data.set(
        'acknowledgementRequired',
        String(this.acknowledgementRequired),
      );
      data.set('uploadedBy', user.id);
      data.set('file', this.file);
      if (this.uploadFolder) {
        data.set('folder', this.uploadFolder);
        data.set('visibility', 'folder');
      } else {
        data.set('folder', '');
        data.set('employee', this.employee);
        data.set('visibility', this.visibility);
      }
      await this.pb.collection('employee_documents').create(data);
      this.formOpen.set(false);
      this.title = '';
      this.file = null;
      this.acknowledgementRequired = false;
      this.success.set('Documento guardado de forma segura.');
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo subir el documento.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected openFolderForm(folder?: DocumentFolderRecord): void {
    this.editingFolder.set(folder ?? null);
    this.folderName = folder?.name ?? '';
    this.folderVisibility = folder?.visibility ?? 'management';
    this.folderUsers = [...(folder?.allowedUsers ?? [])];
    this.folderFormOpen.set(true);
    this.formOpen.set(false);
    this.movingDocument.set(null);
    this.error.set('');
    this.success.set('');
  }

  protected toggleFolderUser(userId: string, selected: boolean): void {
    this.folderUsers = selected
      ? [...new Set([...this.folderUsers, userId])]
      : this.folderUsers.filter((id) => id !== userId);
  }

  protected folderUserSelected(userId: string): boolean {
    return this.folderUsers.includes(userId);
  }

  protected async saveFolder(): Promise<void> {
    const user = this.auth.user();
    if (
      !user ||
      !this.folderName.trim() ||
      (this.folderVisibility === 'selected' &&
        this.folderUsers.length === 0)
    ) {
      return;
    }
    this.saving.set(true);
    this.error.set('');
    const data = {
      organization: user.organization,
      name: this.folderName.trim(),
      visibility: this.folderVisibility,
      allowedUsers:
        this.folderVisibility === 'selected' ? this.folderUsers : [],
      createdBy: user.id,
    };
    try {
      const editing = this.editingFolder();
      if (editing) {
        await this.pb.collection('document_folders').update(editing.id, data);
        this.success.set('Carpeta actualizada.');
      } else {
        await this.pb.collection('document_folders').create(data);
        this.success.set('Carpeta creada.');
      }
      this.folderFormOpen.set(false);
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo guardar la carpeta.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteFolder(folder: DocumentFolderRecord): Promise<void> {
    if (this.folderDocumentCount(folder.id) > 0) {
      this.error.set(
        'Mueve o elimina los documentos antes de borrar la carpeta.',
      );
      return;
    }
    this.error.set('');
    try {
      await this.pb.collection('document_folders').delete(folder.id);
      if (this.selectedFolder() === folder.id) {
        this.selectedFolder.set('all');
      }
      this.success.set('Carpeta eliminada.');
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo eliminar la carpeta.'));
    }
  }

  protected openMove(document: EmployeeDocumentRecord): void {
    this.movingDocument.set(document);
    this.moveFolder = document.folder;
    this.moveEmployee = document.employee || this.employee;
    this.moveVisibility =
      document.visibility === 'folder' ? 'employee' : document.visibility;
    this.formOpen.set(false);
    this.folderFormOpen.set(false);
    this.error.set('');
    this.success.set('');
  }

  protected async moveDocument(): Promise<void> {
    const document = this.movingDocument();
    if (!document || (!this.moveFolder && !this.moveEmployee)) return;
    this.saving.set(true);
    this.error.set('');
    try {
      await this.pb.collection('employee_documents').update(document.id, {
        folder: this.moveFolder,
        employee: this.moveFolder ? document.employee : this.moveEmployee,
        visibility: this.moveFolder ? 'folder' : this.moveVisibility,
      });
      this.movingDocument.set(null);
      this.success.set('Documento movido.');
      await this.load();
    } catch (error) {
      this.error.set(this.apiMessage(error, 'No se pudo mover el documento.'));
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

  protected async acknowledge(
    document: EmployeeDocumentRecord,
  ): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    try {
      if (document.folder) {
        await this.pb.collection('document_acknowledgements').create({
          organization: user.organization,
          document: document.id,
          user: user.id,
          acknowledgedAt: new Date().toISOString(),
        });
      } else {
        await this.pb.collection('employee_documents').update(document.id, {
          acknowledgedAt: new Date().toISOString(),
        });
      }
      this.success.set('Lectura confirmada.');
      await this.load();
    } catch (error) {
      this.error.set(
        this.apiMessage(error, 'No se pudo confirmar la lectura.'),
      );
    }
  }

  protected hasCurrentUserAcknowledged(
    document: EmployeeDocumentRecord,
  ): boolean {
    const userId = this.auth.user()?.id;
    if (!userId) return false;
    if (!document.folder) return Boolean(document.acknowledgedAt);
    return this.acknowledgements().some(
      (acknowledgement) =>
        acknowledgement.document === document.id &&
        acknowledgement.user === userId,
    );
  }

  protected canCurrentUserAcknowledge(
    document: EmployeeDocumentRecord,
  ): boolean {
    const user = this.auth.user();
    if (!user) return false;
    return document.folder ? true : document.employee === user.id;
  }

  protected readProgress(document: EmployeeDocumentRecord): string {
    const folder = this.folderFor(document);
    if (!folder) return document.acknowledgedAt ? '1/1 lecturas' : '0/1 lecturas';
    const audience = this.folderAudience(folder);
    const confirmed = new Set(
      this.acknowledgements()
        .filter(
          (acknowledgement) =>
            acknowledgement.document === document.id &&
            audience.has(acknowledgement.user),
        )
        .map((acknowledgement) => acknowledgement.user),
    ).size;
    return `${confirmed}/${audience.size} lecturas`;
  }

  protected folderDocumentCount(folderId: string): number {
    return this.documents().filter((document) => document.folder === folderId)
      .length;
  }

  protected rootDocumentCount(): number {
    return this.documents().filter((document) => !document.folder).length;
  }

  protected folderById(folderId: string): DocumentFolderRecord | undefined {
    return this.folders().find((folder) => folder.id === folderId);
  }

  protected folderFor(
    document: EmployeeDocumentRecord,
  ): DocumentFolderRecord | undefined {
    return (
      document.expand?.folder ??
      this.folderById(document.folder)
    );
  }

  protected folderVisibilityLabel(
    visibility: DocumentFolderVisibility,
  ): string {
    return {
      company: 'Toda la empresa',
      selected: 'Usuarios seleccionados',
      management: 'Solo responsables',
    }[visibility];
  }

  protected visibilityLabel(
    visibility: EmployeeDocumentRecord['visibility'],
  ): string {
    return {
      employee: 'Persona y responsables',
      company: 'Toda la empresa',
      management: 'Solo responsables',
      folder: 'Heredada de la carpeta',
    }[visibility];
  }

  protected categoryLabel(
    category: EmployeeDocumentRecord['category'],
  ): string {
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

  private folderAudience(folder: DocumentFolderRecord): Set<string> {
    const audience = new Set<string>();
    for (const member of this.members()) {
      if (
        member.role === 'admin' ||
        member.role === 'manager' ||
        folder.visibility === 'company' ||
        (folder.visibility === 'selected' &&
          folder.allowedUsers.includes(member.id))
      ) {
        audience.add(member.id);
      }
    }
    return audience;
  }

  private apiMessage(error: unknown, fallback: string): string {
    if (
      typeof error === 'object' &&
      error !== null &&
      'response' in error &&
      typeof error.response === 'object' &&
      error.response !== null &&
      'message' in error.response &&
      typeof error.response.message === 'string'
    ) {
      return error.response.message;
    }
    return fallback;
  }
}
