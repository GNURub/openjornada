import { expect, test } from '@playwright/test';
import { acknowledgePrivacyNotice } from './helpers/privacy';

const mcpUrl = 'http://127.0.0.1:8090/mcp';
const apiBase = 'http://127.0.0.1:8090/api';

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill('admin@example.com');
  await page.getByLabel('Contraseña').fill('TestPassword123!');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await acknowledgePrivacyNotice(page);
}

async function mcpRequest(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  return request.post(mcpUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: {
      jsonrpc: '2.0',
      id: `${method}-${Date.now()}`,
      method,
      params,
    },
  });
}

async function apiSignIn(
  request: import('@playwright/test').APIRequestContext,
  email: string,
  password: string,
): Promise<{ token: string; record: { id: string; organization: string } }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request.post(`${apiBase}/collections/users/auth-with-password`, {
      data: { identity: email, password },
    });
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

test('an admin can issue, use and revoke an MCP token', async ({ page, request }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución valida el protocolo y el ciclo completo del token.',
  );

  await signIn(page);
  await page.goto('/integraciones');
  await expect(page.getByRole('heading', { name: 'Acceso MCP' })).toBeVisible();
  await page.getByLabel('Nombre descriptivo').fill(`Playwright ${Date.now()}`);
  await page.getByRole('button', { name: 'Crear token' }).click();
  const tokenInput = page.getByLabel('Token MCP recién creado');
  await expect(tokenInput).toBeVisible();
  const token = await tokenInput.inputValue();
  expect(token).toMatch(/^ojmcp_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{40,}$/);

  const unauthorized = await request.post(mcpUrl, {
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
  expect(unauthorized.status()).toBe(401);

  const initialized = await mcpRequest(request, token, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'OpenJornada E2E', version: '1.0.0' },
  });
  expect(initialized.ok(), await initialized.text()).toBeTruthy();

  const listed = await mcpRequest(request, token, 'tools/list');
  expect(listed.ok(), await listed.text()).toBeTruthy();
  const listBody = (await listed.json()) as {
    result: { tools: Array<{ name: string }> };
  };
  expect(listBody.result.tools.map((tool) => tool.name)).toContain('obtener_contexto');
  expect(listBody.result.tools.map((tool) => tool.name)).toContain('resolver_solicitud_ausencia');

  const context = await mcpRequest(request, token, 'tools/call', {
    name: 'obtener_contexto',
    arguments: {},
  });
  expect(context.ok(), await context.text()).toBeTruthy();
  const contextBody = (await context.json()) as {
    result: { isError?: boolean; structuredContent: { actor: { role: string } } };
  };
  expect(contextBody.result.isError).not.toBe(true);
  expect(contextBody.result.structuredContent.actor.role).toBe('admin');

  const row = page.locator('li').filter({ hasText: 'Playwright' }).first();
  await row.getByRole('button', { name: 'Revocar' }).click();
  await expect(row.getByText('Revocado')).toBeVisible();

  const revoked = await mcpRequest(request, token, 'tools/list');
  expect(revoked.status()).toBe(401);
});

test('a manager only sees and revokes their own tokens while admin controls the organization', async ({
  request,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chromium',
    'Una ejecución valida los límites por rol y organización.',
  );
  const suffix = Date.now().toString(36);
  const admin = await apiSignIn(request, 'admin@example.com', 'TestPassword123!');
  const password = 'ManagerMcpPassword123!';
  const managerCreated = await request.post(`${apiBase}/collections/users/records`, {
    headers: { Authorization: admin.token },
    data: {
      organization: admin.record.organization,
      name: `Responsable MCP ${suffix}`,
      email: `mcp-manager-${suffix}@example.com`,
      password,
      passwordConfirm: password,
      employeeCode: `MCP-${suffix}`,
      jobTitle: 'Responsable',
      weeklyHours: 40,
      role: 'manager',
      active: true,
    },
  });
  expect(managerCreated.ok(), await managerCreated.text()).toBeTruthy();
  const manager = (await managerCreated.json()) as { id: string; email: string };
  const managerSession = await apiSignIn(request, manager.email, password);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const managerTokenResponse = await request.post(`${apiBase}/openjornada/mcp-tokens`, {
    headers: { Authorization: managerSession.token },
    data: { name: `Token responsable ${suffix}`, expiresAt },
  });
  expect(managerTokenResponse.ok(), await managerTokenResponse.text()).toBeTruthy();
  const managerToken = (await managerTokenResponse.json()) as {
    id: string;
    createdBy: string;
    token: string;
  };
  expect(managerToken.createdBy).toBe(manager.id);

  const managerContextResponse = await mcpRequest(request, managerToken.token, 'tools/call', {
    name: 'obtener_contexto',
    arguments: {},
  });
  const managerContext = (await managerContextResponse.json()) as {
    result: { structuredContent: { actor: { role: string } } };
  };
  expect(managerContext.result.structuredContent.actor.role).toBe('manager');

  const adminTokenResponse = await request.post(`${apiBase}/openjornada/mcp-tokens`, {
    headers: { Authorization: admin.token },
    data: { name: `Token admin ${suffix}`, expiresAt },
  });
  expect(adminTokenResponse.ok(), await adminTokenResponse.text()).toBeTruthy();
  const adminToken = (await adminTokenResponse.json()) as { id: string };

  const managerListResponse = await request.get(`${apiBase}/openjornada/mcp-tokens`, {
    headers: { Authorization: managerSession.token },
  });
  expect(managerListResponse.ok(), await managerListResponse.text()).toBeTruthy();
  const managerList = (await managerListResponse.json()) as {
    items: Array<{ id: string; createdBy: string }>;
  };
  expect(managerList.items).toContainEqual(
    expect.objectContaining({ id: managerToken.id, createdBy: manager.id }),
  );
  expect(managerList.items.every((item) => item.createdBy === manager.id)).toBe(true);

  const forbiddenRevoke = await request.post(
    `${apiBase}/openjornada/mcp-tokens/${adminToken.id}/revoke`,
    { headers: { Authorization: managerSession.token } },
  );
  expect(forbiddenRevoke.status()).toBe(403);

  const adminListResponse = await request.get(`${apiBase}/openjornada/mcp-tokens`, {
    headers: { Authorization: admin.token },
  });
  expect(adminListResponse.ok(), await adminListResponse.text()).toBeTruthy();
  const adminList = (await adminListResponse.json()) as { items: Array<{ id: string }> };
  expect(adminList.items.map((item) => item.id)).toEqual(
    expect.arrayContaining([managerToken.id, adminToken.id]),
  );

  const adminRevoke = await request.post(
    `${apiBase}/openjornada/mcp-tokens/${managerToken.id}/revoke`,
    { headers: { Authorization: admin.token } },
  );
  expect(adminRevoke.ok(), await adminRevoke.text()).toBeTruthy();
});
