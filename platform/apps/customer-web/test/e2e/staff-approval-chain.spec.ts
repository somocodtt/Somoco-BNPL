import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const applicationId = "task-8-application";
const chain = [
  {
    role: "VERIFICATION_OFFICER",
    title: "Verification queue",
    status: "VERIFICATION_REVIEW",
    next: "BSM_INITIAL_REVIEW",
    stage: "VERIFICATION",
  },
  {
    role: "BSM",
    title: "BSM approval queue",
    status: "BSM_INITIAL_REVIEW",
    next: "AGM_REVIEW",
    stage: "BSM_INITIAL",
  },
  {
    role: "AGM",
    title: "AGM approval queue",
    status: "AGM_REVIEW",
    next: "CFO_REVIEW",
    stage: "AGM",
  },
  {
    role: "CFO",
    title: "CFO approval queue",
    status: "CFO_REVIEW",
    next: "BSM_FINAL_REVIEW",
    stage: "CFO",
  },
  {
    role: "BSM",
    title: "BSM approval queue",
    status: "BSM_FINAL_REVIEW",
    next: "MD_REVIEW",
    stage: "BSM_FINAL",
  },
  {
    role: "MD",
    title: "MD approval queue",
    status: "MD_REVIEW",
    next: "APPROVED",
    stage: "MD",
  },
] as const;

test("each approval role receives exactly one actionable queue item in order", async ({
  browser,
}) => {
  const state = {
    status: chain[0].status as string,
    version: 4,
    decisions: [] as string[],
  };
  const contexts: BrowserContext[] = [];

  try {
    for (const step of chain) {
      const context = await browser.newContext();
      contexts.push(context);
      await installStaffApi(context, state, step);
      const page = await context.newPage();

      await page.goto("/");
      await signIn(page, step.role);
      await expect(
        page.getByRole("heading", { name: step.title }),
      ).toBeVisible();
      await expect(
        page
          .getByRole("list", { name: "Actionable applications" })
          .getByRole("listitem"),
      ).toHaveCount(1);
      await page.getByRole("button", { name: "Open application" }).click();
      await expect(
        page.getByRole("heading", { name: "Application review" }),
      ).toBeVisible();
      await page.getByLabel("Decision note").fill(`${step.stage} verified`);
      await page.getByRole("button", { name: "Approve application" }).click();
      await expect(page.getByText("Decision saved")).toBeVisible();
      expect(state.status).toBe(step.next);
    }

    expect(state.decisions).toEqual(chain.map(({ stage }) => stage));
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function signIn(page: Page, role: string) {
  await page.getByLabel("Work email").fill(`${role.toLowerCase()}@somo.test`);
  await page.getByLabel("Password").fill("strong-password");
  await page.getByLabel("MFA assertion").fill("654321");
  await page.getByRole("button", { name: "Sign in securely" }).click();
}

async function installStaffApi(
  context: BrowserContext,
  state: { status: string; version: number; decisions: string[] },
  step: (typeof chain)[number],
) {
  await context.route("**/v1/staff/sessions", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        staffUserId: `${step.role}-user`,
        roles: [step.role],
        csrfToken: `csrf-${step.role}`,
      }),
    });
  });

  await context.route("**/v1/staff/applications/queue", async (route) => {
    const actionable = state.status === step.status;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        actionable
          ? [
              {
                id: applicationId,
                status: state.status,
                version: state.version,
                submittedAt: "2026-08-20T00:00:00.000Z",
                snapshot: { applicantName: "Ama Mensah" },
              },
            ]
          : [],
      ),
    });
  });

  await context.route(
    `**/v1/staff/applications/${applicationId}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: applicationId,
          status: state.status,
          version: state.version,
          submittedAt: "2026-08-20T00:00:00.000Z",
          snapshot: {
            applicantName: "Ama Mensah",
            nia: { status: "VERIFIED", reference: "NIA-8" },
            documents: { scanState: "CLEAN" },
            statements: [{ kind: "income", value: "verified" }],
          },
          decisions: state.decisions.map((stage) => ({
            stage,
            outcome: "APPROVED",
          })),
          underwriting: [],
        }),
      });
    },
  );

  await context.route(
    `**/v1/staff/applications/${applicationId}/approve`,
    async (route) => {
      state.decisions.push(step.stage);
      state.status = step.next;
      state.version += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: state.status, version: state.version }),
      });
    },
  );
}
