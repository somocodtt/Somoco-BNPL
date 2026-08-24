import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";

test("serves the actual customer sign-in route", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in securely" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code" })).toBeVisible();
});
