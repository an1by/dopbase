import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useSsoController } from "./Sso.controller";
import * as ssoApi from "~/services/sso.api";
import { ApiError } from "~/services/http.client";
import { mountController } from "~/tests/mount-controller";

const { query, routerReplace } = vi.hoisted(() => ({
  query: { value: {} as Record<string, string> },
  routerReplace: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: query.value }),
  useRouter: () => ({ replace: routerReplace }),
}));

vi.mock("~/services/sso.api");
vi.mock("~/services/auth.api");

const empty: ssoApi.SsoSettings = {
  provider: null,
  redirectUri: "https://dopbase.example.com/api/v1/auth/sso/callback",
  publicUrl: "https://dopbase.example.com",
  publicUrlSecure: true,
};

function configured(
  overrides: Partial<ssoApi.SsoProvider> = {},
): ssoApi.SsoSettings {
  return {
    ...empty,
    provider: {
      id: "sso_1",
      preset: "google",
      displayName: "Google",
      issuer: "https://accounts.google.com",
      clientId: "client",
      enabled: false,
      verifiedAt: null,
      linkedAccounts: 0,
      requireSso: false,
      hidePasswordForm: false,
      passwordlessAccounts: 0,
      updatedAt: "2026-10-24T10:00:00Z",
      ...overrides,
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function mounted(settings: ssoApi.SsoSettings) {
  vi.mocked(ssoApi.fetchSsoSettings).mockResolvedValueOnce(settings);
  const { controller } = mountController(useSsoController);
  await settle();
  return controller;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  query.value = {};
});

describe("useSsoController", () => {
  it("walks from not set up to needing a test sign-in to on", async () => {
    const c = await mounted(empty);
    expect(c.status.value).toBe("none");

    c.choosePreset("google");
    expect(c.displayName.value).toBe("Google");
    expect(c.issuerPlaceholder.value).toBe("https://accounts.google.com");
    await c.save();
    expect(c.fieldErrors.value).toEqual({
      issuer: "Enter the issuer URL.",
      clientId: "Enter the client ID.",
      clientSecret: "Enter the client secret.",
    });
    expect(ssoApi.saveSsoProvider).not.toHaveBeenCalled();

    c.issuer.value = " https://accounts.google.com ";
    c.clientId.value = "client";
    c.clientSecret.value = "secret";
    vi.mocked(ssoApi.saveSsoProvider).mockResolvedValueOnce(configured());
    await c.save();
    expect(ssoApi.saveSsoProvider).toHaveBeenCalledWith({
      preset: "google",
      displayName: "Google",
      issuer: "https://accounts.google.com",
      clientId: "client",
      clientSecret: "secret",
    });
    expect(c.status.value).toBe("unverified");
    expect(c.clientSecret.value).toBe("");
    expect(c.notice.value).toContain("test sign-in");

    vi.mocked(ssoApi.setSsoEnabled).mockResolvedValueOnce(
      configured({ enabled: true, verifiedAt: "2026-10-24T10:05:00Z" }),
    );
    await c.toggle();
    expect(ssoApi.setSsoEnabled).toHaveBeenCalledWith(true);
    expect(c.status.value).toBe("enabled");
  });

  it("keeps the stored secret when the field is left blank", async () => {
    const c = await mounted(configured({ verifiedAt: "2026-10-24T10:05:00Z" }));
    expect(c.status.value).toBe("ready");
    c.displayName.value = "Google Workspace";
    vi.mocked(ssoApi.saveSsoProvider).mockResolvedValueOnce(
      configured({ displayName: "Google Workspace", verifiedAt: "x" }),
    );
    await c.save();
    expect(ssoApi.saveSsoProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientSecret: expect.anything() }),
    );
  });

  it("maps server checks to their fields", async () => {
    const c = await mounted(configured());
    vi.mocked(ssoApi.saveSsoProvider).mockRejectedValueOnce(
      new ApiError(422, { SSO_DISCOVERY_FAILED: "No discovery document." }),
    );
    await c.save();
    expect(c.fieldErrors.value.issuer).toBe("No discovery document.");

    vi.mocked(ssoApi.saveSsoProvider).mockRejectedValueOnce(
      new ApiError(422, {
        SSO_CLIENT_INVALID: "The client secret is too long.",
      }),
    );
    await c.save();
    expect(c.fieldErrors.value.clientSecret).toBe(
      "The client secret is too long.",
    );
  });

  it("reports the test sign-in result from the callback", async () => {
    query.value = { linked: "1" };
    const c = await mounted(configured({ verifiedAt: "2026-10-24T10:05:00Z" }));
    expect(c.notice.value).toContain("Test sign-in worked");
    expect(routerReplace).toHaveBeenCalledWith({ query: {} });

    query.value = { sso_error: "cancelled" };
    const failed = await mounted(configured());
    expect(failed.actionError.value).toContain("cancelled");
  });

  it("removes the provider after confirmation", async () => {
    const c = await mounted(configured({ linkedAccounts: 3 }));
    c.promptRemove();
    expect(c.confirmingRemove.value).toBe(true);
    vi.mocked(ssoApi.deleteSsoProvider).mockResolvedValueOnce();
    vi.mocked(ssoApi.fetchSsoSettings).mockResolvedValueOnce(empty);
    await c.confirmRemove();
    expect(c.confirmingRemove.value).toBe(false);
    expect(c.status.value).toBe("none");
    expect(c.notice.value).toBe("Single sign-on was removed.");
  });

  it("asks before requiring single sign-on, then requires it", async () => {
    const c = await mounted(configured({ enabled: true, verifiedAt: "x" }));
    c.changeRequired(true);
    expect(c.confirmingRequire.value).toBe(true);
    expect(ssoApi.setSsoRequired).not.toHaveBeenCalled();
    vi.mocked(ssoApi.setSsoRequired).mockResolvedValueOnce(
      configured({ enabled: true, verifiedAt: "x", requireSso: true }),
    );
    await c.toggleRequired();
    expect(ssoApi.setSsoRequired).toHaveBeenCalledWith(true);
    expect(c.confirmingRequire.value).toBe(false);
    expect(c.provider.value?.requireSso).toBe(true);
    expect(c.notice.value).toContain("signed out");

    // Turning it off needs no confirmation.
    vi.mocked(ssoApi.setSsoRequired).mockResolvedValueOnce(
      configured({ enabled: true, verifiedAt: "x" }),
    );
    c.changeRequired(false);
    await settle();
    expect(ssoApi.setSsoRequired).toHaveBeenLastCalledWith(false);
  });

  it("hides and shows the password form on the sign-in page", async () => {
    const c = await mounted(configured({ enabled: true, verifiedAt: "x" }));
    vi.mocked(ssoApi.setSsoPasswordFormHidden).mockResolvedValueOnce(
      configured({ enabled: true, verifiedAt: "x", hidePasswordForm: true }),
    );
    await c.setPasswordFormHidden(true);
    expect(ssoApi.setSsoPasswordFormHidden).toHaveBeenCalledWith(true);
    expect(c.provider.value?.hidePasswordForm).toBe(true);
    expect(c.notice.value).toContain("only the single sign-on button");
  });

  it("locks setup while the public URL is not HTTPS", async () => {
    const c = await mounted({
      ...empty,
      publicUrl: "http://dopbase.internal",
      publicUrlSecure: false,
    });
    expect(c.blocked.value).toBe(true);
    const secure = await mounted(empty);
    expect(secure.blocked.value).toBe(false);
  });

  it("shows setup notes for each provider", async () => {
    const c = await mounted(empty);
    c.choosePreset("supabase");
    expect(c.presetHint.value).toContain("HS256");
    expect(c.issuerPlaceholder.value).toContain("/auth/v1");
    c.choosePreset("auth0");
    expect(c.displayName.value).toBe("Auth0");
    expect(c.issuerPlaceholder.value.endsWith("/")).toBe(true);
  });
});
