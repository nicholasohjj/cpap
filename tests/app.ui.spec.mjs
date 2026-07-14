import { expect, test } from "@playwright/test";

test("loads bundled sample and exposes core workflows", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /load sample/i }).click();

  await expect(page.getByText("Export overview")).toBeVisible({ timeout: 15000 });
  await expect(page.getByText("Import diagnostics")).toBeVisible();
  await expect(page.getByText("DATALOG nights")).toBeVisible();
  await expect(page.getByText("CRC records")).toBeVisible();
  await expect(page.locator(".event-counts").getByText("Central", { exact: true })).toBeVisible();

  await page.getByLabel("Leak unit").selectOption("lps");
  await expect(page.getByText("L/s").first()).toBeVisible();

  const csvDownload = page.waitForEvent("download");
  await page.locator(".panel", { hasText: "Events" }).getByRole("button", { name: "CSV" }).first().click();
  const download = await csvDownload;
  expect(download.suggestedFilename()).toContain("cpap-events");

  await expect(page.getByRole("button", { name: /load brp flow/i })).toBeVisible();
  await page.getByRole("button", { name: /load brp flow/i }).click();
  await expect(page.locator("canvas[aria-label='Flow waveform']")).toBeVisible({ timeout: 15000 });

  await page.getByRole("row", { name: /Central Apnea/ }).first().click();
  await expect(page.getByText("Event focus")).toBeVisible();
  await expect(page.getByRole("button", { name: "Clear" })).toBeVisible();
});
