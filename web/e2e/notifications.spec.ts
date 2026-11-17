import { expect, test } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const apiBase = 'http://127.0.0.1:8090/api';
const employeeEmail = 'empleada@example.com';
const employeePassword = 'DemoPassword123!';
const adminEmail = 'admin@example.com';
const adminPassword = 'TestPassword123!';

interface Authentication {
  token: string;
  record: { id: string; organization: string };
}

async function apiSignIn(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<Authentication> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
    if (response.ok()) return (await response.json()) as Authentication;
    if (attempt === 2) {
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    await new Promise((resolve) => setTimeout(resolve, 3_200));
  }
  throw new Error(`No se pudo autenticar ${email}`);
}

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
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
      if (attempt === 2) throw new Error(`No se pudo iniciar sesión como ${email}`);
      await page.waitForTimeout(3_200);
    }
  }
}

async function markEverythingRead(
  request: import('@playwright/test').APIRequestContext,
  session: Authentication,
): Promise<void> {
  const list = await request.get(`${apiBase}/collections/notifications/records`, {
    headers: { Authorization: session.token },
    params: { perPage: '200', filter: `recipient = "${session.record.id}" && read = false` },
  });
  expect(list.ok(), await list.text()).toBeTruthy();
  for (const item of ((await list.json()) as { items: Array<{ id: string }> }).items) {
    const updated = await request.patch(
      `${apiBase}/collections/notifications/records/${item.id}`,
      { headers: { Authorization: session.token }, data: { read: true } },
    );
    expect(updated.ok(), await updated.text()).toBeTruthy();
  }
}

test('unread notifications show a badge, the count in the title and a banner', async ({
  page,
  request,
}) => {
  const admin = await apiSignIn(request, adminEmail, adminPassword);
  const employee = await apiSignIn(request, employeeEmail, employeePassword);
  await markEverythingRead(request, employee);

  const title = `Revisar la vitrina ${Date.now().toString(36)}`;
  const task = await request.post(`${apiBase}/collections/employee_tasks/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      assignee: employee.record.id,
      title,
      category: 'onboarding',
      status: 'pending',
      createdBy: admin.record.id,
    },
  });
  expect(task.ok(), await task.text()).toBeTruthy();

  await signIn(page, employeeEmail, employeePassword);

  const toast = page.getByTestId('notification-toast');
  await expect(toast).toBeVisible();
  await expect(toast.getByText('Nueva tarea asignada')).toBeVisible();
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(page.getByRole('link', { name: /Avisos\s*1 sin leer/ }).first()).toBeAttached();

  await toast.getByRole('button', { name: 'Marcar como leído' }).click();
  await expect(toast).toBeHidden();
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
  await expect(page.getByText('sin leer', { exact: false }).first()).not.toBeAttached();

  await page.goto('/avisos');
  await expect(page.getByText('0 sin leer')).toBeVisible();
});

test('the banner opens the linked page and stays hidden on the notifications page', async ({
  page,
  request,
}) => {
  const admin = await apiSignIn(request, adminEmail, adminPassword);
  const employee = await apiSignIn(request, employeeEmail, employeePassword);
  await markEverythingRead(request, employee);

  const title = `Preparar el inventario ${Date.now().toString(36)}`;
  const task = await request.post(`${apiBase}/collections/employee_tasks/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      assignee: employee.record.id,
      title,
      category: 'onboarding',
      status: 'pending',
      createdBy: admin.record.id,
    },
  });
  expect(task.ok(), await task.text()).toBeTruthy();

  await signIn(page, employeeEmail, employeePassword);
  await page.goto('/avisos');
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByTestId('notification-toast')).toHaveCount(0);

  await page.goto('/');
  const toast = page.getByTestId('notification-toast');
  await expect(toast.getByText('Nueva tarea asignada')).toBeVisible();
  await toast.getByRole('button', { name: 'Ver aviso' }).click();
  await expect(page).toHaveURL(/\/tareas$/);
  await expect(page.getByTestId('notification-toast')).toHaveCount(0);
  await expect(page).not.toHaveTitle(/^\(\d+\) /);
});
