import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { acknowledgePrivacyNotice } from './helpers/privacy';

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

async function changeAccount(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
) {
  await page.evaluate(() => localStorage.clear());
  await signIn(page, email, password);
}

async function selectEmployee(page: import('@playwright/test').Page) {
  const select = page.getByRole('combobox', { name: 'Persona', exact: true });
  await select.selectOption({ label: 'Marina Estética' });
}

async function enableDocumentPipShim(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const controller = {
      window: null as Window | null,
      async requestWindow(options?: { width: number; height: number }) {
        const pipWindow = window.open(
          '',
          'openjornada-worktime-pip',
          `popup,width=${options?.width ?? 320},height=${options?.height ?? 180}`,
        );
        if (!pipWindow) throw new DOMException('Picture-in-Picture bloqueado');
        controller.window = pipWindow;
        return pipWindow;
      },
    };
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: controller,
    });
  });
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
      'http://127.0.0.1:8090/api/collections/users/auth-with-password',
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

async function apiCreateEmployee(
  request: import('@playwright/test').APIRequestContext,
  adminToken: string,
  organization: string,
  suffix: string,
  label: string,
): Promise<{ id: string; email: string; password: string; name: string }> {
  const email = `solape-${label}-${suffix}@example.com`;
  const password = 'EmployeePassword123!';
  const name = `Solape ${label}`;
  const response = await request.post('http://127.0.0.1:8090/api/collections/users/records', {
    headers: { Authorization: adminToken },
    data: {
      organization,
      name,
      email,
      password,
      passwordConfirm: password,
      employeeCode: `OV-${label.slice(0, 3)}-${suffix}`,
      jobTitle: 'Pruebas',
      weeklyHours: 40,
      role: 'employee',
      active: true,
    },
  });
  const body = await response.text();
  expect(response.ok(), body).toBeTruthy();
  return {
    id: (JSON.parse(body) as { id: string }).id,
    email,
    password,
    name,
  };
}

test('an employee can sign in and start the workday', async ({ page, request }, testInfo) => {
  const admin = await apiSignIn(request, 'admin@example.com', 'TestPassword123!');
  const employee = await apiCreateEmployee(
    request,
    admin.token,
    admin.record.organization,
    testInfo.project.name.replaceAll(/[^a-z]/g, ''),
    'start',
  );
  await signIn(page, employee.email, employee.password);

  await expect(page.getByRole('heading', { name: /Buenos|Buenas/ })).toBeVisible();
  await expect(page.getByText('Fuera de jornada')).toBeVisible();

  await page.getByTestId('primary-clock-action').click();

  await expect(page.getByRole('main').getByText('Jornada en curso')).toBeVisible();
  await expect(page.getByText('Entrada', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Registro verificado').first()).toBeVisible();
  const widget = page.getByTestId('active-worktime-widget');
  await expect(widget).toBeVisible();
  await expect(widget.getByText('Tiempo efectivo hoy')).toBeVisible();
  const widgetBeforeDrag = await widget.boundingBox();
  const dragHandle = await widget.getByTestId('worktime-widget-drag-handle').boundingBox();
  expect(widgetBeforeDrag).toBeTruthy();
  expect(dragHandle).toBeTruthy();
  await page.mouse.move(
    dragHandle!.x + dragHandle!.width / 2,
    dragHandle!.y + dragHandle!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragHandle!.x + dragHandle!.width / 2,
    dragHandle!.y + dragHandle!.height / 2 - 80,
    { steps: 5 },
  );
  await page.mouse.up();
  const widgetAfterDrag = await widget.boundingBox();
  expect(widgetAfterDrag).toBeTruthy();
  expect(widgetAfterDrag!.y).toBeLessThan(widgetBeforeDrag!.y - 40);

  await page.getByRole('link', { name: 'Control horario', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Mi control horario' })).toBeVisible();
  await expect(widget).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mi control horario' })).toBeVisible();
  await expect(widget).toBeVisible();

  await widget.getByRole('button', { name: 'Pausar' }).click();
  await expect(widget.getByText('Jornada en pausa')).toBeVisible();
  await page.waitForTimeout(2_500);
  await widget.getByRole('button', { name: 'Reanudar jornada' }).click();
  const review = page.getByTestId('worktime-review-modal');
  await expect(review.getByRole('heading', { name: 'Revisar fin de pausa' })).toBeVisible();
  await expect(review.getByText('Duración de la pausa')).toBeVisible();
  const reviewedEnd = review.getByLabel('Fecha y hora final');
  const minimumEnd = await reviewedEnd.getAttribute('min');
  expect(minimumEnd).toBeTruthy();
  const adjustedEnd = new Date(minimumEnd!);
  adjustedEnd.setSeconds(adjustedEnd.getSeconds() + 2);
  const localAdjustedEnd = new Date(
    adjustedEnd.getTime() - adjustedEnd.getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 19);
  await reviewedEnd.fill(localAdjustedEnd);
  await expect(review.getByText('00:00:01')).toBeVisible();
  await review.getByRole('button', { name: 'Confirmar' }).click();
  await expect(widget.getByText('Jornada en curso')).toBeVisible();
  await widget.getByRole('button', { name: 'Finalizar' }).click();
  await expect(review.getByRole('heading', { name: 'Revisar fin de jornada' })).toBeVisible();
  await expect(review.getByText('Tiempo efectivo revisado')).toBeVisible();
  await expect(review.getByRole('button', { name: '−5 min' })).toBeVisible();
  await review.getByRole('button', { name: 'Confirmar' }).click();
  await expect(widget).toBeHidden();

  await page.getByRole('tab', { name: 'Trazabilidad' }).click();
  await expect(page.getByText(/\d+ eventos en el periodo/)).toBeVisible();
});

test('clock-in automatically opens and restores the Document Picture-in-Picture widget', async ({
  page,
  request,
}, testInfo) => {
  await enableDocumentPipShim(page);
  const admin = await apiSignIn(request, 'admin@example.com', 'TestPassword123!');
  const employee = await apiCreateEmployee(
    request,
    admin.token,
    admin.record.organization,
    testInfo.project.name.replaceAll(/[^a-z]/g, ''),
    'pip',
  );
  await signIn(page, employee.email, employee.password);

  const automaticPip = page.getByTestId('automatic-worktime-pip');
  await expect(automaticPip).toBeChecked();
  await automaticPip.uncheck();
  await page.reload();
  await expect(page.getByTestId('automatic-worktime-pip')).not.toBeChecked();
  await page.getByTestId('automatic-worktime-pip').check();

  const pipPagePromise = page.context().waitForEvent('page');
  await page.getByTestId('primary-clock-action').click();
  const pipPage = await pipPagePromise;

  await expect(pipPage.getByTestId('active-worktime-widget')).toBeVisible();
  await expect(
    pipPage.getByRole('button', {
      name: 'Cerrar ventana flotante de jornada',
    }),
  ).toBeVisible();
  await pipPage.close();
  await expect(page.getByTestId('active-worktime-widget')).toBeVisible();
});

test('the login screen remains usable on a mobile viewport', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Entra en tu espacio' })).toBeVisible();
  await expect(page.getByLabel('Correo electrónico')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeInViewport();
});

test('an administrator can add an employee with a role', async ({ page }, testInfo) => {
  const suffix = testInfo.project.name.replaceAll(/[^a-z]/g, '');
  await signIn(page, 'admin@example.com', 'TestPassword123!');

  await page.getByRole('link', { name: 'Equipo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Añadir persona' }).click();
  await page.getByLabel('Nombre completo').fill(`Claudia ${suffix}`);
  await page.getByLabel('Correo').fill(`claudia-${suffix}@example.com`);
  await page.getByLabel('Código de empleada').fill(`E2E-${suffix}`);
  await page.getByLabel('Contraseña temporal').fill('EmployeePassword123!');
  await page.getByRole('button', { name: 'Crear acceso' }).click();

  await expect(page.getByText('Persona añadida.')).toBeVisible();
  await expect(page.getByText(`Claudia ${suffix}`)).toBeVisible();
});

test('a leave request can be submitted, approved and notified', async ({
  page,
  request: apiRequest,
}, testInfo) => {
  const projectOffset =
    {
      'desktop-chromium': 20,
      'tablet-chromium': 30,
      'mobile-chromium': 40,
    }[testInfo.project.name] ?? 50;
  const start = new Date();
  start.setDate(start.getDate() + projectOffset);
  while (start.getDay() === 0 || start.getDay() === 6) {
    start.setDate(start.getDate() + 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  while (end.getDay() === 0 || end.getDay() === 6) {
    end.setDate(end.getDate() + 1);
  }
  const toDateInput = (date: Date) => date.toISOString().slice(0, 10);
  const reason = `Vacaciones E2E ${testInfo.project.name}`;

  await signIn(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/ausencias');
  await page.getByRole('button', { name: 'Nueva solicitud' }).click();
  await page.getByLabel('Desde').fill(toDateInput(start));
  await page.getByLabel('Hasta').fill(toDateInput(end));
  await page.getByLabel('Comentario').fill(reason);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();

  await expect(page.getByText('Solicitud enviada.')).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: reason }).getByText('Pendiente'),
  ).toBeVisible();

  const admin = await apiSignIn(apiRequest, 'admin@example.com', 'TestPassword123!');
  const suffix = testInfo.project.name.replaceAll(/[^a-z]/g, '');
  const approvedEmployee = await apiCreateEmployee(
    apiRequest,
    admin.token,
    admin.record.organization,
    suffix,
    'aprobado',
  );
  const pendingEmployee = await apiCreateEmployee(
    apiRequest,
    admin.token,
    admin.record.organization,
    suffix,
    'pendiente',
  );
  const leaveTypesResponse = await apiRequest.get(
    'http://127.0.0.1:8090/api/collections/leave_types/records',
    {
      headers: { Authorization: admin.token },
      params: {
        filter: "code = 'vacation' || code = 'personal'",
        fields: 'id,code',
      },
    },
  );
  expect(leaveTypesResponse.ok()).toBeTruthy();
  const leaveTypes = (await leaveTypesResponse.json()) as {
    items: { id: string; code: string }[];
  };
  const vacationType = leaveTypes.items.find((leaveType) => leaveType.code === 'vacation');
  const personalType = leaveTypes.items.find((leaveType) => leaveType.code === 'personal');
  expect(vacationType).toBeTruthy();
  expect(personalType).toBeTruthy();

  const approvedConflictResponse = await apiRequest.post(
    'http://127.0.0.1:8090/api/collections/leave_requests/records',
    {
      headers: { Authorization: admin.token },
      data: {
        organization: admin.record.organization,
        employee: approvedEmployee.id,
        type: 'personal',
        leaveType: personalType!.id,
        startDate: `${toDateInput(start)} 00:00:00.000Z`,
        endDate: `${toDateInput(start)} 23:59:59.999Z`,
        dayPart: 'full',
        reason: `Coincidencia aprobada ${suffix}`,
        status: 'approved',
      },
    },
  );
  expect(approvedConflictResponse.ok(), await approvedConflictResponse.text()).toBeTruthy();

  const pendingEmployeeAuth = await apiSignIn(
    apiRequest,
    pendingEmployee.email,
    pendingEmployee.password,
  );
  const pendingConflictResponse = await apiRequest.post(
    'http://127.0.0.1:8090/api/collections/leave_requests/records',
    {
      headers: { Authorization: pendingEmployeeAuth.token },
      data: {
        organization: pendingEmployeeAuth.record.organization,
        employee: pendingEmployeeAuth.record.id,
        type: 'vacation',
        leaveType: vacationType!.id,
        startDate: `${toDateInput(start)} 00:00:00.000Z`,
        endDate: `${toDateInput(start)} 23:59:59.999Z`,
        dayPart: 'full',
        reason: `Coincidencia pendiente ${suffix}`,
        status: 'pending',
      },
    },
  );
  expect(pendingConflictResponse.ok(), await pendingConflictResponse.text()).toBeTruthy();

  await changeAccount(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/ausencias');
  const request = page.locator('article').filter({ hasText: reason });
  await expect(request.getByText('Marina Estética')).toBeVisible();
  const approvedWarning = request.getByLabel('Ausencias aprobadas coincidentes');
  await expect(approvedWarning.getByText('1 ausencia aprobada coincidente')).toBeVisible();
  await expect(approvedWarning.getByText(approvedEmployee.name)).toBeVisible();
  await expect(approvedWarning.getByText('Asuntos propios')).toBeVisible();
  const pendingWarning = request.getByLabel('Solicitudes pendientes coincidentes');
  await expect(pendingWarning.getByText('1 solicitud pendiente coincidente')).toBeVisible();
  await expect(pendingWarning.getByText(pendingEmployee.name)).toBeVisible();
  await expect(pendingWarning.getByText('Vacaciones')).toBeVisible();
  await request.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Ausencia aprobada.')).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: reason }).getByText('Aprobada', { exact: true }),
  ).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/avisos');
  await expect(page.getByText('Solicitud de ausencia aprobada').first()).toBeVisible();
});

test('an administrator can assign an employee schedule', async ({ page, request }, testInfo) => {
  const scheduleName = `Horario E2E ${testInfo.project.name}`;

  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/horarios');
  await page.getByRole('button', { name: 'Asignar horario' }).click();
  await page.getByRole('button', { name: 'Seleccionar personas' }).click();
  const peopleSearch = page.getByLabel('Buscar personas');
  await peopleSearch.fill('Marina');
  await page.getByRole('checkbox', { name: /Marina Estética/ }).check();
  await peopleSearch.fill('Administración');
  await page.getByRole('checkbox', { name: /Administración/ }).check();
  await expect(page.getByRole('button', { name: 'Seleccionar personas' })).toContainText(
    '2 personas seleccionadas',
  );
  await page.getByRole('button', { name: 'Listo' }).click();
  await page.getByLabel('Nombre').fill(scheduleName);
  await page.getByRole('button', { name: 'Asignar a 2', exact: true }).click();

  await expect(page.getByText('Horario asignado a 2 personas.')).toBeVisible();
  await expect(page.getByRole('heading', { name: scheduleName })).toHaveCount(2);

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/horarios');
  await expect(page.getByRole('heading', { name: scheduleName })).toBeVisible();

  const employeeAuth = await apiSignIn(request, 'empleada@example.com', 'DemoPassword123!');
  const forbiddenBulkAssignment = await request.post(
    'http://127.0.0.1:8090/api/openjornada/work-schedules/bulk',
    {
      headers: { Authorization: employeeAuth.token },
      data: {
        employeeIds: [employeeAuth.record.id],
        name: 'Intento sin permisos',
        validFrom: '2026-01-01',
        validUntil: '',
        weekdays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        breakMinutes: 30,
      },
    },
  );
  expect(forbiddenBulkAssignment.status()).toBe(403);
});

test('the trace view directs corrections to the daily timesheet', async ({ page }) => {
  await signIn(page, 'empleada@example.com', 'DemoPassword123!');
  await expect(page.getByText('Fuera de jornada')).toBeVisible();
  await page.getByTestId('primary-clock-action').click();
  await expect(page.getByRole('main').getByText('Jornada en curso')).toBeVisible();
  await page.getByTestId('primary-clock-action').click();
  await page
    .getByTestId('worktime-review-modal')
    .getByRole('button', { name: 'Confirmar' })
    .click();
  await expect(page.getByText('Fuera de jornada')).toBeVisible();
  await page.goto('/registros');
  await page.getByRole('tab', { name: 'Trazabilidad' }).click();
  await page.getByRole('button', { name: 'Corregir en hoja' }).first().click();
  await expect(page.getByRole('tab', { name: 'Hoja de fichajes' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByText('Jornada efectiva')).toBeVisible();
});

test('the API blocks employee-only privilege escalation attempts', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar las reglas de servidor.',
  );

  const session = await apiSignIn(request, 'empleada@example.com', 'DemoPassword123!');
  const headers = { Authorization: session.token };

  const organizationUpdate = await request.patch(
    `http://127.0.0.1:8090/api/collections/organizations/records/${session.record.organization}`,
    {
      headers,
      data: { name: 'Cambio no autorizado' },
    },
  );
  expect([403, 404]).toContain(organizationUpdate.status());

  const scheduleCreate = await request.post(
    'http://127.0.0.1:8090/api/collections/work_schedules/records',
    {
      headers,
      data: {
        organization: session.record.organization,
        employee: session.record.id,
        name: 'Horario no autorizado',
        validFrom: new Date().toISOString(),
        validUntil: '',
        weekdays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        breakMinutes: 30,
        active: true,
        createdBy: session.record.id,
      },
    },
  );
  expect([400, 403, 404]).toContain(scheduleCreate.status());

  const taskCreate = await request.post(
    'http://127.0.0.1:8090/api/collections/employee_tasks/records',
    {
      headers,
      data: {
        organization: session.record.organization,
        assignee: session.record.id,
        title: 'Tarea autoasignada sin permiso',
        category: 'onboarding',
        status: 'pending',
        createdBy: session.record.id,
      },
    },
  );
  expect([400, 403, 404]).toContain(taskCreate.status());

  const goalCreate = await request.post('http://127.0.0.1:8090/api/collections/goals/records', {
    headers,
    data: {
      organization: session.record.organization,
      employee: session.record.id,
      title: 'Objetivo autoasignado sin permiso',
      cycle: 'E2E',
      status: 'active',
      createdBy: session.record.id,
    },
  });
  expect([400, 403, 404]).toContain(goalCreate.status());

  const leaveTypeCreate = await request.post(
    'http://127.0.0.1:8090/api/collections/leave_types/records',
    {
      headers,
      data: {
        organization: session.record.organization,
        code: 'unauthorized',
        name: 'Permiso no autorizado',
        color: '#000000',
        active: true,
      },
    },
  );
  expect([400, 403, 404]).toContain(leaveTypeCreate.status());
});

test('a required leave document is enforced by the server', async ({ request }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar la política documental.',
  );

  const admin = await apiSignIn(request, 'admin@example.com', 'TestPassword123!');
  const leaveTypeResponse = await request.post(
    'http://127.0.0.1:8090/api/collections/leave_types/records',
    {
      headers: { Authorization: admin.token },
      data: {
        organization: admin.record.organization,
        code: 'documented_e2e',
        name: 'Permiso documentado E2E',
        color: '#7c3aed',
        deductsBalance: false,
        requiresApproval: true,
        requiresDocument: true,
        active: true,
      },
    },
  );
  expect(leaveTypeResponse.ok()).toBeTruthy();
  const leaveType = (await leaveTypeResponse.json()) as { id: string };

  const employee = await apiSignIn(request, 'empleada@example.com', 'DemoPassword123!');
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 120);
  while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
    start.setUTCDate(start.getUTCDate() + 1);
  }
  const startDate = start.toISOString().slice(0, 10);
  const requestData = {
    organization: employee.record.organization,
    employee: employee.record.id,
    type: 'documented_e2e',
    leaveType: leaveType.id,
    startDate: `${startDate} 00:00:00.000Z`,
    endDate: `${startDate} 23:59:59.999Z`,
    dayPart: 'full',
    reason: 'Validación documental E2E',
    status: 'pending',
  };
  const missingDocument = await request.post(
    'http://127.0.0.1:8090/api/collections/leave_requests/records',
    {
      headers: { Authorization: employee.token },
      data: requestData,
    },
  );
  expect(missingDocument.status()).toBe(400);

  const documentedRequest = await request.post(
    'http://127.0.0.1:8090/api/collections/leave_requests/records',
    {
      headers: { Authorization: employee.token },
      multipart: {
        ...requestData,
        attachment: {
          name: 'justificante.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF'),
        },
      },
    },
  );
  const documentedBody = await documentedRequest.text();
  expect(documentedRequest.ok(), documentedBody).toBeTruthy();
  const documented = JSON.parse(documentedBody) as {
    id: string;
    attachment: string;
  };
  const cancelAttempt = await request.patch(
    `http://127.0.0.1:8090/api/collections/leave_requests/records/${documented.id}`,
    {
      headers: { Authorization: employee.token },
      data: {
        status: 'cancelled',
        requestedDays: 99,
        attachment: '',
      },
    },
  );
  expect(cancelAttempt.ok()).toBeTruthy();
  const cancelled = (await cancelAttempt.json()) as {
    requestedDays: number;
    attachment: string;
    status: string;
  };
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.requestedDays).toBe(1);
  expect(cancelled.attachment).toBe(documented.attachment);
});

test('the HR suite connects onboarding, goals, documents and expenses', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(8_000);
  const suffix = testInfo.project.name;
  const taskTitle = `Onboarding E2E ${suffix}`;
  const goalTitle = `Objetivo E2E ${suffix}`;
  const documentTitle = `Política interna E2E ${suffix}`;
  const merchant = `Proveedor E2E ${suffix}`;
  const pdf = {
    name: `evidence-${suffix}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF'),
  };

  await signIn(page, 'admin@example.com', 'TestPassword123!');

  await page.goto('/tareas');
  await page.getByRole('button', { name: 'Asignar tarea' }).click();
  await selectEmployee(page);
  await page.getByLabel('Título').fill(taskTitle);
  await page.getByLabel('Descripción').fill('Completar los primeros pasos.');
  await page.getByRole('button', { name: 'Asignar', exact: true }).click();
  await expect(page.getByText('Tarea asignada.')).toBeVisible();

  await page.goto('/objetivos');
  await page.getByRole('button', { name: 'Nuevo objetivo' }).click();
  await selectEmployee(page);
  await page.getByLabel('Título').fill(goalTitle);
  await page.getByLabel('Descripción').fill('Mejorar la experiencia de clientes.');
  await page.getByRole('button', { name: 'Asignar objetivo' }).click();
  await expect(page.getByText('Objetivo asignado.')).toBeVisible();

  await page.goto('/documentos');
  await page.getByRole('button', { name: 'Subir documento' }).click();
  await selectEmployee(page);
  await page.getByLabel('Título').fill(documentTitle);
  await page.getByLabel('Requiere confirmar lectura').check();
  await page.locator('input[type="file"]').setInputFiles(pdf);
  await page.getByRole('button', { name: 'Guardar documento' }).click();
  await expect(page.getByText('Documento guardado')).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/avisos');
  const taskNotification = page.locator('li').filter({
    hasText: 'Nueva tarea asignada',
  });
  await expect(taskNotification.getByText(taskTitle)).toBeVisible();

  const documentNotification = page.locator('li').filter({
    hasText: 'Nuevo documento disponible',
  });
  await expect(documentNotification.getByText(documentTitle)).toBeVisible();

  await page.goto('/gastos');
  await page.getByRole('button', { name: 'Nuevo gasto' }).click();
  await page.getByLabel('Comercio').fill(merchant);
  await page.getByLabel('Importe').fill('42.50');
  await page.getByLabel('Descripción').fill('Material para el centro.');
  await page.locator('input[type="file"]').setInputFiles(pdf);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(page.getByText('Gasto enviado para aprobación.')).toBeVisible();

  await page.goto('/tareas');
  const task = page.locator('article').filter({ hasText: taskTitle });
  await task.getByRole('button', { name: 'Completar' }).click();
  await expect(page.getByText('Tarea completada.')).toBeVisible();

  await page.goto('/objetivos');
  const goal = page.locator('article').filter({ hasText: goalTitle });
  await goal.getByRole('button', { name: '+10%' }).click();
  await expect(page.getByText('Progreso actualizado.')).toBeVisible();
  await page
    .locator('article')
    .filter({ hasText: goalTitle })
    .getByRole('button', { name: 'Completar' })
    .click();
  await expect(page.getByText('100%').first()).toBeVisible();

  await page.goto('/documentos');
  const document = page.locator('article').filter({ hasText: documentTitle });
  await document.getByRole('button', { name: 'Confirmar lectura' }).click();
  await expect(page.getByText('Lectura confirmada.')).toBeVisible();

  await changeAccount(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/gastos');
  const expense = page.locator('tr:visible, article:visible').filter({
    hasText: merchant,
  });
  await expense.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Gasto aprobado.')).toBeVisible();
});
