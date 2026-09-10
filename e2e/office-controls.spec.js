import { test, expect } from "@playwright/test";

test("office filters the scene, provides keyboard actions, and persists every environment", async ({page, request}) => {
  await request.post('/api/workspaces/demo/demo', {data:{running:false}});
  await page.goto('/');
  const scope = page.getByRole('region', {name:'Office controls'});
  await expect(scope).toBeVisible();
  await expect(scope.getByLabel('Live agent activity')).toBeVisible();
  await expect(scope.getByText('Simulated preview', {exact:true})).toBeVisible();
  await expect(scope.getByLabel('Live agent activity')).not.toContainText('[OBJECT OBJECT]');
  const allCount = await page.locator('.scene-label').count();
  await scope.getByRole('button',{name:/^Demo/}).click();
  await expect(page.locator('.scene-label')).not.toHaveCount(0);
  await expect(page.locator('.scene-label').filter({hasText:'Manual'})).toHaveCount(0);
  await scope.getByRole('button',{name:/^All assistants/}).click();
  await expect(page.locator('.scene-label')).toHaveCount(allCount);
  const nova = page.getByRole('button',{name:'Inspect Nova',exact:true});
  await nova.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu',{name:'Agent actions'})).toBeVisible();
  await page.getByRole('menuitem',{name:'Follow in 3D'}).click();
  await expect(page.locator('.office-follow')).toHaveText('Following Nova');
  await page.getByRole('button',{name:'Selected agent actions'}).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  for(const [id,label] of [['garden','Garden atelier'],['midnight','Midnight lab'],['sandstone','Desert studio'],['operations','Mission control'],['studio','Daylight studio']]) {
    await scope.getByRole('button',{name:label,exact:true}).click();
    await expect(page.locator(`.office-theme-${id}`)).toBeVisible();
    expect((await (await request.get('/api/workspaces/demo')).json()).theme).toBe(id);
  }
  await page.reload();
  await expect(scope.getByRole('button',{name:'Daylight studio',exact:true})).toHaveAttribute('aria-pressed','true');
});

test("agent identity editor persists provider, skills, and 3D appearance", async ({page, request}) => {
  await page.goto('/');
  await page.locator('aside').getByRole('button',{name:'Your agents',exact:true}).click();
  await page.getByRole('button',{name:'Add agent',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Add an agent'});
  await dialog.locator('[name=name]').fill('Vector');
  await dialog.locator('[name=role]').fill('Research engineer');
  await dialog.locator('[name=provider]').selectOption('claude-code');
  await dialog.locator('[name=model]').fill('provider-default');
  await dialog.locator('[name=runtime]').fill('local-cli');
  await dialog.locator('[name=skills]').fill('Research, citations, accessibility');
  await dialog.locator('[name=outfit]').selectOption('jacket');
  await dialog.locator('[name=accessory]').selectOption('headset');
  await dialog.locator('[name=pronouns]').fill('she/her');
  await dialog.getByRole('button',{name:'Add agent',exact:true}).click();
  await expect(page.getByText('Vector',{exact:true}).first()).toBeVisible();
  const agents = await (await request.get('/api/workspaces/demo/agents')).json();
  const saved = agents.find(agent => agent.name === 'Vector');
  expect(saved).toMatchObject({provider:'claude-code',model:'provider-default',runtime:'local-cli',skills:['Research','citations','accessibility']});
  expect(JSON.parse(saved.avatar)).toMatchObject({outfit:'jacket',accessory:'headset',pronouns:'she/her'});
  await page.locator('aside').getByRole('button',{name:'Workspace',exact:true}).click();
  await expect(page.getByRole('button',{name:'Inspect Vector',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Inspect Vector',exact:true}).locator('.scene-pronouns')).toHaveText('she/her');
  const roleScope = page.getByLabel('Filter office by role');
  await roleScope.getByRole('button',{name:/^Research engineer/}).click();
  await expect(page.locator('.scene-label')).toHaveCount(1);
  await expect(page.locator('.scene-label')).toContainText('Vector');
  await expect(page.getByLabel('Agent capability details')).toContainText('provider-default');
  await expect(page.getByLabel('Agent capability details')).toContainText('Research');
});

test("a portable visual preset previews before it changes this workspace", async ({page, request}) => {
  await request.post('/api/workspaces/demo/visual-preset/apply', {data:{preset:{
    kind:'agent-space-visual-preset', version:1, name:'Baseline office', theme:'studio',
    settings:{'ui.graphics':'medium','ui.office.lighting':'day'}
  }}});
  await page.goto('/');
  await page.getByRole('button',{name:'Workspace settings'}).click();
  const dialog = page.getByRole('dialog');
  const upload = dialog.getByLabel('Import visual preset');
  await upload.setInputFiles({
    name:'midnight-office.json', mimeType:'application/json', buffer:Buffer.from(JSON.stringify({
      kind:'agent-space-visual-preset', version:1, name:'Midnight deployment room', theme:'midnight',
      settings:{'ui.graphics':'high','ui.office.labelDensity':'active','ui.office.lighting':'focus'}
    }))
  });
  const preview = dialog.getByLabel('Visual preset preview');
  await expect(preview).toContainText('Midnight deployment room');
  await expect(preview).toContainText('Theme');
  await expect(preview).toContainText('studio → midnight');
  expect((await (await request.get('/api/workspaces/demo')).json()).theme).toBe('studio');
  await preview.getByRole('button',{name:'Apply preset'}).click();
  await expect(page.getByText('Visual preset applied to this workspace')).toBeVisible();
  const current = await (await request.get('/api/workspaces/demo')).json();
  expect(current.theme).toBe('midnight');
  expect(current.settings.visual).toMatchObject({'ui.graphics':'high','ui.office.labelDensity':'active','ui.office.lighting':'focus'});
});
