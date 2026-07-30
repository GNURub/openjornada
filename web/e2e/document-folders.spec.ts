import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = 'http://127.0.0.1:8090/api';

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();
    try {
      await expect(page).toHaveURL(/\/$/, { timeout: 2_500 });
      await acknowledgePrivacyNotice(page);
      return;
    } catch {
      if (attempt === 2) {
        throw new Error(`No se pudo iniciar sesión como ${email}`);
      }
      await page.waitForTimeout(3_200);
    }
  }
}

async function changeAccount(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.evaluate(() => localStorage.clear());
  await signIn(page, email, password);
}

async function apiSignIn(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<{
  token: string;
  record: { id: string; organization: string };
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(
      `${apiBase}/collections/users/auth-with-password`,
      { data: { identity: email, password } },
    );
    if (response.ok()) {
      return (await response.json()) as {
        token: string;
        record: { id: string; organization: string };
      };
    }
    if (attempt === 2) {
      throw new Error(
        `No se pudo autenticar ${email}: ${response.status()} ${await response.text()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

async function createUser(
  request: import('@playwright/test').APIRequestContext,
  admin: { token: string; record: { organization: string } },
  suffix: string,
  role: 'admin' | 'manager' | 'employee' | 'representative',
) {
  const email = `folders-${role}-${suffix}@example.com`;
  const password = 'FolderUserPassword123!';
  const response = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: `Carpetas ${role} ${suffix}`,
      email,
      password,
      passwordConfirm: password,
      employeeCode: `F-${role.slice(0, 3)}-${suffix}`,
      jobTitle: 'Pruebas de carpetas',
      weeklyHours: 40,
      role,
      active: true,
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  return {
    ...(JSON.parse(body) as { id: string }),
    email,
    password,
  };
}

async function createFolder(
  request: import('@playwright/test').APIRequestContext,
  admin: { token: string; record: { organization: string; id: string } },
  name: string,
  visibility: 'company' | 'selected' | 'management',
  allowedUsers: string[] = [],
) {
  const response = await request.post(
    `${apiBase}/collections/document_folders/records`,
    {
      headers: { Authorization: admin.token },
      data: {
        organization: admin.record.organization,
        name,
        visibility,
        allowedUsers,
        createdBy: admin.record.id,
      },
    },
  );
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  return JSON.parse(body) as { id: string };
}

async function visibleFolderIds(
  request: import('@playwright/test').APIRequestContext,
  token: string,
): Promise<string[]> {
  const response = await request.get(
    `${apiBase}/collections/document_folders/records`,
    {
      headers: { Authorization: token },
      params: { perPage: 200, fields: 'id' },
    },
  );
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { items: { id: string }[] };
  return body.items.map((folder) => folder.id);
}

test('shared folders can be created, read and acknowledged', async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name.replaceAll(/[^a-z]/g, '');
  const folderName = `Manuales compartidos ${suffix}`;
  const documentTitle = `Manual de bienvenida ${suffix}`;
  const pdf = {
    name: `manual-${suffix}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  };

  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/documentos');
  await page.getByRole('button', { name: 'Nueva carpeta' }).click();
  await page.getByLabel('Nombre').fill(folderName);
  await page.getByLabel('Visibilidad').selectOption('selected');
  await page.getByLabel('Marina Estética').check();
  await page.getByRole('button', { name: 'Guardar carpeta' }).click();
  await expect(page.getByText('Carpeta creada.')).toBeVisible();

  await page.getByRole('button', { name: 'Subir documento' }).click();
  await page.getByLabel('Destino').selectOption({ label: folderName });
  await page.getByLabel('Categoría').selectOption('training');
  await page.getByLabel('Requiere confirmar lectura').check();
  await page.locator('input[type="file"]').setInputFiles(pdf);
  const titleInput = page.getByLabel('Título');
  await titleInput.focus();
  await titleInput.blur();
  await expect(page.getByText('El título es obligatorio.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Guardar documento' }),
  ).toBeDisabled();
  await titleInput.fill(documentTitle);
  await page.getByRole('button', { name: 'Guardar documento' }).click();
  await expect(page.getByText('Documento guardado')).toBeVisible();

  const adminDocument = page
    .locator('article')
    .filter({ hasText: documentTitle });
  await expect(adminDocument.getByText(/0\/\d+ lecturas/)).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/avisos');
  await expect(
    page.locator('li').filter({ hasText: documentTitle }),
  ).toBeVisible();
  await page.goto('/documentos');
  await page.getByRole('button', { name: new RegExp(folderName) }).click();
  const employeeDocument = page
    .locator('article')
    .filter({ hasText: documentTitle });
  await expect(employeeDocument).toBeVisible();
  await employeeDocument
    .getByRole('button', { name: 'Confirmar lectura' })
    .click();
  await expect(page.getByText('Lectura confirmada.')).toBeVisible();

  await changeAccount(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/documentos');
  await page.getByRole('button', { name: new RegExp(folderName) }).click();
  const reviewedDocument = page
    .locator('article')
    .filter({ hasText: documentTitle });
  await expect(reviewedDocument.getByText(/1\/\d+ lecturas/)).toBeVisible();
  await page.getByRole('button', { name: 'Eliminar' }).click();
  await expect(
    page.getByText('Mueve o elimina los documentos antes de borrar la carpeta.'),
  ).toBeVisible();
});

test('folder permissions are enforced by PocketBase', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar las reglas de acceso.',
  );
  const suffix = `${Date.now()}`;
  const admin = await apiSignIn(
    request,
    'admin@example.com',
    'TestPassword123!',
  );
  const demo = await apiSignIn(
    request,
    'empleada@example.com',
    'DemoPassword123!',
  );
  const managerUser = await createUser(request, admin, suffix, 'manager');
  const outsiderUser = await createUser(request, admin, suffix, 'employee');
  const representativeUser = await createUser(
    request,
    admin,
    suffix,
    'representative',
  );
  const manager = await apiSignIn(
    request,
    managerUser.email,
    managerUser.password,
  );
  const outsider = await apiSignIn(
    request,
    outsiderUser.email,
    outsiderUser.password,
  );
  const representative = await apiSignIn(
    request,
    representativeUser.email,
    representativeUser.password,
  );

  const selected = await createFolder(
    request,
    admin,
    `Seleccionada ${suffix}`,
    'selected',
    [demo.record.id],
  );
  const management = await createFolder(
    request,
    admin,
    `Interna ${suffix}`,
    'management',
  );
  const company = await createFolder(
    request,
    admin,
    `Empresa ${suffix}`,
    'company',
  );
  const empty = await createFolder(
    request,
    admin,
    `Vacía ${suffix}`,
    'management',
  );

  const blankTitleResponse = await request.post(
    `${apiBase}/collections/employee_documents/records`,
    {
      headers: { Authorization: admin.token },
      multipart: {
        organization: admin.record.organization,
        folder: selected.id,
        title: '   ',
        category: 'training',
        visibility: 'folder',
        acknowledgementRequired: 'false',
        uploadedBy: admin.record.id,
        file: {
          name: `blank-title-${suffix}.pdf`,
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF'),
        },
      },
    },
  );
  expect(blankTitleResponse.status()).toBe(400);

  expect(await visibleFolderIds(request, demo.token)).toEqual(
    expect.arrayContaining([selected.id, company.id]),
  );
  expect(await visibleFolderIds(request, demo.token)).not.toContain(
    management.id,
  );
  expect(await visibleFolderIds(request, outsider.token)).toContain(company.id);
  expect(await visibleFolderIds(request, outsider.token)).not.toContain(
    selected.id,
  );
  expect(await visibleFolderIds(request, representative.token)).toContain(
    company.id,
  );
  expect(await visibleFolderIds(request, representative.token)).not.toContain(
    management.id,
  );
  expect(await visibleFolderIds(request, manager.token)).toEqual(
    expect.arrayContaining([selected.id, management.id, company.id]),
  );

  const documentResponse = await request.post(
    `${apiBase}/collections/employee_documents/records`,
    {
      headers: { Authorization: admin.token },
      multipart: {
        organization: admin.record.organization,
        folder: selected.id,
        title: `Documento seleccionado ${suffix}`,
        category: 'training',
        visibility: 'folder',
        acknowledgementRequired: 'true',
        uploadedBy: admin.record.id,
        file: {
          name: `selected-${suffix}.pdf`,
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF'),
        },
      },
    },
  );
  const documentBody = await documentResponse.text();
  expect(documentResponse.ok(), documentBody).toBeTruthy();
  const document = JSON.parse(documentBody) as { id: string };

  const allowedView = await request.get(
    `${apiBase}/collections/employee_documents/records/${document.id}`,
    { headers: { Authorization: demo.token } },
  );
  expect(allowedView.ok()).toBeTruthy();
  const deniedView = await request.get(
    `${apiBase}/collections/employee_documents/records/${document.id}`,
    { headers: { Authorization: outsider.token } },
  );
  expect([403, 404]).toContain(deniedView.status());

  const deniedAcknowledgement = await request.post(
    `${apiBase}/collections/document_acknowledgements/records`,
    {
      headers: { Authorization: outsider.token },
      data: {
        organization: outsider.record.organization,
        document: document.id,
        user: outsider.record.id,
        acknowledgedAt: new Date().toISOString(),
      },
    },
  );
  expect([400, 403, 404]).toContain(deniedAcknowledgement.status());
  const allowedAcknowledgement = await request.post(
    `${apiBase}/collections/document_acknowledgements/records`,
    {
      headers: { Authorization: demo.token },
      data: {
        organization: demo.record.organization,
        document: document.id,
        user: demo.record.id,
        acknowledgedAt: new Date().toISOString(),
      },
    },
  );
  expect(allowedAcknowledgement.ok()).toBeTruthy();

  const nonEmptyDelete = await request.delete(
    `${apiBase}/collections/document_folders/records/${selected.id}`,
    { headers: { Authorization: admin.token } },
  );
  expect(nonEmptyDelete.status()).toBe(400);
  const emptyDelete = await request.delete(
    `${apiBase}/collections/document_folders/records/${empty.id}`,
    { headers: { Authorization: manager.token } },
  );
  expect(emptyDelete.status()).toBe(204);

  const invalidOrganization = await request.post(
    `${apiBase}/collections/document_folders/records`,
    {
      headers: { Authorization: admin.token },
      data: {
        organization: 'invalidorganization',
        name: `Otra empresa ${suffix}`,
        visibility: 'company',
        createdBy: admin.record.id,
      },
    },
  );
  expect([400, 403]).toContain(invalidOrganization.status());
});
