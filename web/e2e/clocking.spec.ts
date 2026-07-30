import { expect, test } from '@playwright/test';
import { Buffer } from 'node:buffer';

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

async function selectEmployee(
  page: import('@playwright/test').Page,
) {
  const select = page.getByRole('combobox', { name: 'Persona', exact: true });
  await select.selectOption({ label: 'Marina Estética' });
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

test('an employee can sign in and start the workday', async ({ page }) => {
  await signIn(page, 'empleada@example.com', 'DemoPassword123!');

  await expect(page.getByRole('heading', { name: /Buenos|Buenas/ })).toBeVisible();
  await expect(page.getByText('Fuera de jornada')).toBeVisible();

  await page.getByTestId('primary-clock-action').click();

  await expect(page.getByText('Jornada en curso')).toBeVisible();
  await expect(page.getByText('Entrada', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Registro verificado').first()).toBeVisible();

  await page.getByTestId('primary-clock-action').click();
  await expect(page.getByText('Fuera de jornada')).toBeVisible();

  await page.getByRole('link', { name: 'Registros', exact: true }).first().click();
  await expect(
    page.getByRole('heading', { name: 'Registros de jornada' }),
  ).toBeVisible();
  await expect(page.getByText(/\d+ eventos en el periodo/)).toBeVisible();
});

test('the login screen remains usable on a mobile viewport', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Entra en tu espacio' })).toBeVisible();
  await expect(page.getByLabel('Correo electrónico')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeInViewport();
});

test('an administrator can add an employee with a role', async ({
  page,
}, testInfo) => {
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
}, testInfo) => {
  const projectOffset = {
    'desktop-chromium': 20,
    'tablet-chromium': 30,
    'mobile-chromium': 40,
  }[testInfo.project.name] ?? 50;
  const start = new Date();
  start.setDate(start.getDate() + projectOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
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

  await changeAccount(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/ausencias');
  const request = page.locator('article').filter({ hasText: reason });
  await expect(request.getByText('Marina Estética')).toBeVisible();
  await request.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Ausencia aprobada.')).toBeVisible();
  await expect(
    page
      .locator('article')
      .filter({ hasText: reason })
      .getByText('Aprobada', { exact: true }),
  ).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/avisos');
  await expect(
    page.getByText('Solicitud de ausencia aprobada').first(),
  ).toBeVisible();
});

test('an administrator can assign an employee schedule', async ({
  page,
}, testInfo) => {
  const scheduleName = `Horario E2E ${testInfo.project.name}`;

  await signIn(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/horarios');
  await page.getByRole('button', { name: 'Asignar horario' }).click();
  const person = page.getByLabel('Persona');
  const employeeValue = await person
    .locator('option')
    .filter({ hasText: 'Marina Estética' })
    .getAttribute('value');
  expect(employeeValue).toBeTruthy();
  await person.selectOption(employeeValue!);
  await page.getByLabel('Nombre').fill(scheduleName);
  await page.getByRole('button', { name: 'Asignar', exact: true }).click();

  await expect(page.getByText('Horario asignado correctamente.')).toBeVisible();
  await expect(page.getByRole('heading', { name: scheduleName })).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/horarios');
  await expect(page.getByRole('heading', { name: scheduleName })).toBeVisible();
});

test('a work event correction preserves the approval trail', async ({
  page,
}, testInfo) => {
  const reason = `Corrección trazable E2E ${testInfo.project.name}`;

  await signIn(page, 'empleada@example.com', 'DemoPassword123!');
  await expect(page.getByText('Fuera de jornada')).toBeVisible();
  await page.getByTestId('primary-clock-action').click();
  await expect(page.getByText('Jornada en curso')).toBeVisible();
  await page.getByTestId('primary-clock-action').click();
  await expect(page.getByText('Fuera de jornada')).toBeVisible();
  await page.goto('/registros');
  await page
    .getByRole('button', { name: 'Solicitar corrección' })
    .first()
    .click();
  await page.getByLabel('Motivo').fill(reason);
  await page.getByRole('button', { name: 'Solicitar', exact: true }).click();
  await expect(page.getByText('La solicitud se ha enviado')).toBeVisible();
  await expect(
    page.locator('li').filter({ hasText: reason }).getByText('Pendiente'),
  ).toBeVisible();

  await changeAccount(page, 'admin@example.com', 'TestPassword123!');
  await page.goto('/registros');
  const request = page.locator('li').filter({ hasText: reason });
  await expect(request.getByText('Marina Estética')).toBeVisible();
  await request.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByText('Corrección aplicada con trazabilidad.')).toBeVisible();

  await changeAccount(page, 'empleada@example.com', 'DemoPassword123!');
  await page.goto('/registros');
  await expect(
    page
      .locator('li')
      .filter({ hasText: reason })
      .getByText('Aprobada', { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('td:visible, p:visible')
      .filter({ hasText: /Corrección\s*→/ })
      .first(),
  ).toBeVisible();
});

test('the API blocks employee-only privilege escalation attempts', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar las reglas de servidor.',
  );

  const session = await apiSignIn(
    request,
    'empleada@example.com',
    'DemoPassword123!',
  );
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

  const goalCreate = await request.post(
    'http://127.0.0.1:8090/api/collections/goals/records',
    {
      headers,
      data: {
        organization: session.record.organization,
        employee: session.record.id,
        title: 'Objetivo autoasignado sin permiso',
        cycle: 'E2E',
        status: 'active',
        createdBy: session.record.id,
      },
    },
  );
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

test('a required leave document is enforced by the server', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución basta para validar la política documental.',
  );

  const admin = await apiSignIn(
    request,
    'admin@example.com',
    'TestPassword123!',
  );
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

  const employee = await apiSignIn(
    request,
    'empleada@example.com',
    'DemoPassword123!',
  );
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
