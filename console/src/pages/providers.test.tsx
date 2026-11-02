import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Route, Routes } from "react-router-dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProvidersPage } from "./providers";
import { draftsToPricing, toDrafts } from "@/lib/pricing-draft";
import { renderAuthenticated } from "@/test/render";
import type { AppSummary, ProviderCredential, ProviderGateway } from "@/lib/types";
import { served } from "@/test/providers";

const SECRET = "sk-live-never-shown-again";

const DIRECT: ProviderCredential = {
  id: "provider-1",
  type: "openai",
  ...served("openai"),
  slug: "openai",
  name: "Prod OpenAI",
  secretHint: "gain",
  providerGatewayId: null,
  gatewayRoute: null,
  baseUrl: null,
  pricing: { "gpt-brand-new": { input: 1.25, output: 10 } },
  revision: 7,
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

const VIA_GATEWAY: ProviderCredential = {
  ...DIRECT,
  id: "provider-2",
  type: "anthropic",
  slug: "anthropic-cf",
  name: "Anthropic via CF",
  // A routed row owns no secret at all: the gateway token authenticates it.
  secretHint: null,
  providerGatewayId: "gw-1",
  ...served("anthropic", "cf_aig"),
  pricing: null,
};

const GATEWAY: ProviderGateway = {
  id: "gw-1",
  type: "cf_aig",
  name: "Prod CF gateway",
  config: { accountId: "acct-1", gatewayId: "cf-gw" },
  secretHint: "9xyz",
  providerCount: 1,
  referencedCount: 1,
  revision: 11,
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

/** Nothing references this one, so it may be deleted. */
const SPARE_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-2",
  name: "Spare gateway",
  providerCount: 0,
  referencedCount: 0,
};

/**
 * Serves no traffic, but disabled rows still hold its foreign key — the API
 * refuses to delete it just the same.
 */
const RETIRED_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-3",
  name: "Retired gateway",
  providerCount: 0,
  referencedCount: 2,
};

const VERCEL_GATEWAY: ProviderGateway = {
  id: "gw-vercel",
  type: "vercel",
  name: "Team Vercel gateway",
  // Vercel's origin is fixed in adapter code, so there is nothing to store.
  config: {},
  secretHint: "1abc",
  providerCount: 1,
  referencedCount: 1,
  revision: 5,
  status: "active",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  createdBy: "user-1",
};

const VIA_VERCEL: ProviderCredential = {
  ...DIRECT,
  id: "provider-3",
  type: "gemini",
  slug: "gemini-vercel",
  name: "Gemini via Vercel",
  secretHint: null,
  providerGatewayId: "gw-vercel",
  ...served("gemini", "vercel"),
  pricing: null,
};

/** Paused, not deleted: the key and the pricing are still on the row. */
const DISABLED: ProviderCredential = {
  ...DIRECT,
  id: "provider-4",
  slug: "openai-dev",
  name: "Dev OpenAI",
  status: "disabled",
};

/**
 * Only the fields the page reads. `referenced_providers` is the list of slugs
 * an app names outright, which is what makes "these apps use it" answerable.
 */
function appSummary(name: string, referenced: string[]): AppSummary {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    status: "active",
    authentication_type: "api_key",
    apple_bundle_id: null,
    created_at: "2026-02-01T00:00:00.000Z",
    providers: referenced,
    referenced_providers: referenced,
    allowed_model_count: 0,
    monthly_budget_usd: null,
    users: { total: 0, blocked: 0 },
    usage: {
      requests: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      errors: 0,
      },
  };
}

const CREATED_GATEWAY: ProviderGateway = {
  ...GATEWAY,
  id: "gw-new",
  name: "Fresh gateway",
  providerCount: 0,
  referencedCount: 0,
};

interface Call {
  url: string;
  method: string;
  body: any;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Mirrors the admin API the page talks to: providers and provider gateways are
 * two separate collections, and a gateway id is the only link between them.
 */
function stubProviders(
  options: {
    providers?: ProviderCredential[];
    gateways?: ProviderGateway[];
    apps?: AppSummary[];
    createProvider?: { status: number; body: unknown };
    testProvider?: { status: number; body: unknown };
    testGateway?: { status: number; body: unknown };
    createGateway?: { status: number; body: unknown };
    updateProvider?: { status: number; body: unknown };
  } = {},
) {
  const providers = options.providers ?? [DIRECT, VIA_GATEWAY];
  const gateways = options.gateways ?? [GATEWAY];
  const apps = options.apps ?? [];
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    // The page reads the apps list only to name the apps a disable or a delete
    // will affect; it never blocks on it.
    if (url.includes("/v1/admin/apps")) return json({ month: "2026-02", apps });
    if (url.includes("/v1/admin/provider-gateways")) {
      if (method === "GET") return json({ gateways });
      if (method === "DELETE") return json({ deleted: true, provider_gateway_id: SPARE_GATEWAY.id });
      if (method === "PATCH") return json({ gateway: { ...GATEWAY, name: "Renamed gateway" } });
      if (url.endsWith("/test")) {
        const stub = options.testGateway;
        return stub ? json(stub.body, stub.status) : json({ validated: true });
      }
      const stub = options.createGateway;
      if (stub && !url.endsWith("/rotate")) return json(stub.body, stub.status);
      // Create and rotate answer with the same envelope.
      return json({ gateway: CREATED_GATEWAY }, url.endsWith("/rotate") ? 200 : 201);
    }
    if (url.endsWith("/v1/admin/providers/test")) {
      const stub = options.testProvider;
      return stub ? json(stub.body, stub.status) : json({ validated: true });
    }
    if (method === "POST") {
      const stub = options.createProvider;
      return stub ? json(stub.body, stub.status) : json({ provider: DIRECT }, 201);
    }
    if (method === "PUT") {
      const stub = options.updateProvider;
      return stub ? json(stub.body, stub.status) : json({ provider: DIRECT });
    }
    if (method === "DELETE") return json({ deleted: true, provider_id: DIRECT.id });
    return json({ providers });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Radix renders its listbox in a portal, so options are found on the screen. */
async function choose(trigger: HTMLElement, option: RegExp | string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

/**
 * The newest dialog. Radix hides the layers below it from the accessibility
 * tree, but the gateway modal opens on top of the provider one, and both carry
 * a "Name" field — every query has to say which of them it means.
 */
async function topDialog(): Promise<HTMLElement> {
  const dialogs = await screen.findAllByRole("dialog");
  return dialogs[dialogs.length - 1]!;
}

/** Every row action lives behind the row's menu, so a test opens that first. */
async function openRowActions(label: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${label}` }));
  return await screen.findByRole("menu");
}

/** Opens a row's menu and runs one of its actions. */
async function runRowAction(label: string, action: RegExp) {
  const menu = await openRowActions(label);
  await userEvent.click(within(menu).getByRole("menuitem", { name: action }));
}

/** Providers are added the same way apps and management keys are: in a modal. */
async function openAddProvider(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: /^add provider$/i }));
  return topDialog();
}

/**
 * Providers and gateways are two sections of one destination, reachable only
 * through their routes, so tests mount those the way the console does.
 */
function renderProviders(
  route = "/providers",
  options: Parameters<typeof renderAuthenticated>[1] = {},
) {
  return renderAuthenticated(
    <Routes>
      <Route path="/providers" element={<ProvidersPage />} />
      <Route path="/providers/:section" element={<ProvidersPage />} />
    </Routes>,
    { ...options, route },
  );
}

/** The gateways section, which is a menu click away from the providers one. */
function renderGateways(options: Parameters<typeof renderAuthenticated>[1] = {}) {
  return renderProviders("/providers/gateways", options);
}

afterEach(() => vi.unstubAllGlobals());

describe("draftsToPricing", () => {
  it("drops an entirely blank row and keeps a deliberate zero", () => {
    expect(draftsToPricing([
      { model: "free-model", input: "0", output: "0" },
      { model: "", input: "", output: "" },
    ])).toEqual({ pricing: { "free-model": { input: 0, output: 0 } } });
  });

  it.each([
    ["an empty input price", { model: "m", input: "", output: "2" }],
    ["an empty output price", { model: "m", input: "1", output: "" }],
    ["whitespace instead of a price", { model: "m", input: " ", output: "2" }],
  ])("refuses to read %s as free", (_label, draft) => {
    // Number("") is 0, so an empty field must never become a $0 allowance.
    expect(draftsToPricing([draft])).toEqual({
      error: "Enter both prices for m — use 0 only if it is genuinely free",
    });
  });

  it("rejects a duplicated model instead of letting the last row win", () => {
    expect(draftsToPricing([
      { model: "m", input: "1", output: "2" },
      { model: " m ", input: "3", output: "4" },
    ])).toEqual({ error: "m is priced twice — remove the duplicate row" });
  });

  it("names the row that cannot be saved", () => {
    expect(draftsToPricing([{ model: "m", input: "-1", output: "2" }]))
      .toEqual({ error: "Prices for m must be numbers of 0 or more" });
    expect(draftsToPricing([{ model: "", input: "1", output: "2" }]))
      .toEqual({ error: "Every pricing row needs a model name" });
    expect(draftsToPricing([{ model: "m", input: "1", output: "2", cacheWrite: "abc" }]))
      .toEqual({ error: "Prices for m must be numbers of 0 or more" });
  });

  it("sends the cache prices that are filled in and leaves out the blank ones", () => {
    expect(draftsToPricing([
      { model: "a", input: "1", output: "2", cachedInput: "0.1", cacheWrite: "1.25" },
      { model: "b", input: "1", output: "2", cachedInput: " ", cacheWrite: "" },
    ])).toEqual({
      pricing: {
        a: { input: 1, output: 2, cached_input: 0.1, cache_write: 1.25 },
        b: { input: 1, output: 2 },
      },
    });
  });

  it("keeps rates the form has no field for when the prices are saved again", () => {
    const stored = {
      m: {
        input: 1,
        output: 2,
        cached_input: 0.1,
        cache_write_1h: 2,
        long_context_threshold: 200_000,
        long_input: 2,
      },
    };
    expect(draftsToPricing(toDrafts(stored))).toEqual({ pricing: stored });
  });
});

describe("ProvidersPage", () => {
  it("lists each instance by slug and how it authenticates", async () => {
    stubProviders({
      providers: [DIRECT, VIA_GATEWAY, VIA_VERCEL],
      gateways: [GATEWAY, VERCEL_GATEWAY],
    });
    renderProviders();

    const direct = (await screen.findByText("Prod OpenAI")).closest("tr")!;
    const routed = screen.getByText("Anthropic via CF").closest("tr")!;

    // The slug is the URL segment callers use, so it is shown verbatim.
    expect(within(direct).getByText("openai")).toBeTruthy();
    expect(within(routed).getByText("anthropic-cf")).toBeTruthy();
    // A key of its own is named by its tail, which is all of it there ever is.
    expect(within(direct).getByText(/API key:/)).toBeTruthy();
    expect(within(direct).getByText("…gain")).toBeTruthy();
    // A routed row names the gateway it borrows from, not the Cloudflare ids.
    expect(within(routed).getByText(/Gateway:/)).toBeTruthy();
    expect(within(routed).getByText("Prod CF gateway")).toBeTruthy();
    expect(within(routed).queryByText(/cf-gw/)).toBeNull();
    expect(within(routed).queryByText(/API key:/)).toBeNull();
    // Whatever kind of gateway it is, the row names it the same way.
    const vercel = screen.getByText("Gemini via Vercel").closest("tr")!;
    expect(within(vercel).getByText("Team Vercel gateway")).toBeTruthy();
  });

  it("gives each section its own page, headed by the list it shows", async () => {
    stubProviders();
    const { unmount } = renderProviders();

    // Gateways are a section of their own now, not a second table below this one.
    expect(await screen.findByRole("heading", { level: 1, name: "Providers" })).toBeTruthy();
    expect(await screen.findByText("Prod OpenAI")).toBeTruthy();
    expect(screen.queryByText("acct-1")).toBeNull();
    unmount();

    renderGateways();

    expect(await screen.findByRole("heading", { level: 1, name: "Gateways" })).toBeTruthy();
    expect(await screen.findByText("acct-1")).toBeTruthy();
    expect(screen.queryByText("Prod OpenAI")).toBeNull();
  });

  it("falls back to the providers section for an unknown one", async () => {
    stubProviders();
    const { router } = renderProviders("/providers/nonsense");

    expect(router.location.pathname).toBe("/providers");
    expect(await screen.findByText("Prod OpenAI")).toBeTruthy();
  });

  it("offers onboarding copy when nothing is configured", async () => {
    stubProviders({ providers: [], gateways: [] });
    const { unmount } = renderProviders();

    expect(await screen.findByText(/add a key per provider/i)).toBeTruthy();
    unmount();

    renderGateways();
    expect(await screen.findByText(/no gateways yet/i)).toBeTruthy();
  });

  it("submits a new key from the modal and leaves nothing behind", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    const secretField = within(dialog).getByLabelText("API key");
    await userEvent.type(secretField, SECRET);
    expect(secretField.getAttribute("type")).toBe("password");
    // autocomplete="off" is ignored on login-shaped forms, which is how the
    // operator's own saved password ended up in a provider key field.
    expect(secretField.getAttribute("autocomplete")).toBe("new-password");
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toEqual({ type: "openai", name: "Prod OpenAI", secret: SECRET });
    });
    // Creating finishes in the modal, so it closes on success.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);

    // The plaintext exists nowhere the operator or the cache can read it back.
    const reopened = await openAddProvider();
    expect((within(reopened).getByLabelText("API key") as HTMLInputElement).value).toBe("");
    expect((within(reopened).getByLabelText("Name") as HTMLInputElement).value).toBe("");
  });

  it("sends an optional base URL with a direct key, and probes at that origin", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Self-hosted");
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    const baseUrl = within(dialog).getByLabelText("Base URL (optional)");
    // The helper text has to say what this unlocks and what the guard allows,
    // because the server's refusal is the only other place it is explained.
    expect(within(dialog).getByText(/OpenAI-compatible endpoint you control/i)).toBeTruthy();
    expect(within(dialog).getByText(/HTTPS, port 443/i)).toBeTruthy();
    await userEvent.type(baseUrl, "https://my-vllm.example.com/v1/");

    // The dry run goes to the same origin the stored row would use.
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));
    await waitFor(() => {
      const test = calls.find((entry) => entry.url.endsWith("/v1/admin/providers/test"));
      expect(test?.body).toEqual({
        type: "openai",
        secret: SECRET,
        baseUrl: "https://my-vllm.example.com/v1/",
      });
    });

    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && !entry.url.endsWith("/test"),
      );
      expect(call?.body).toEqual({
        type: "openai",
        name: "Self-hosted",
        secret: SECRET,
        baseUrl: "https://my-vllm.example.com/v1/",
      });
    });
  });

  it("omits the base URL entirely when it is left empty", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.type(within(dialog).getByLabelText("Base URL (optional)"), "   ");
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      // No `baseUrl` key at all: an empty field is not an origin.
      expect(call?.body).toEqual({ type: "openai", name: "Prod OpenAI", secret: SECRET });
    });
  });

  it("hides the base URL in gateway mode, where the gateway owns the origin", async () => {
    const calls = stubProviders({ providers: [], gateways: [GATEWAY] });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "OpenAI via CF");
    await userEvent.type(
      within(dialog).getByLabelText("Base URL (optional)"),
      "https://my-vllm.example.com/v1/",
    );
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    expect(within(dialog).queryByLabelText("Base URL (optional)")).toBeNull();
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      // Typed before the switch, and not smuggled into the routed request.
      expect(call?.body).toEqual({
        type: "openai",
        name: "OpenAI via CF",
        providerGatewayId: "gw-1",
      });
    });
  });

  it("shows a custom origin beside the key it is sent with", async () => {
    stubProviders({
      providers: [
        DIRECT,
        {
          ...DIRECT,
          id: "provider-custom",
          slug: "vllm",
          name: "Self-hosted",
          baseUrl: "https://my-vllm.example.com/v1/",
        },
      ],
      gateways: [],
    });
    renderProviders();

    const custom = (await screen.findByText("Self-hosted")).closest("tr")!;
    expect(within(custom).getByText(/Base URL:/)).toBeTruthy();
    expect(within(custom).getByText("https://my-vllm.example.com/v1/")).toBeTruthy();
    // A stock row has only its key: there is no origin worth naming.
    const stock = screen.getByText("Prod OpenAI").closest("tr")!;
    expect(within(stock).getByText(/API key:/)).toBeTruthy();
    expect(within(stock).queryByText(/Base URL:/)).toBeNull();
    expect(within(stock).queryByText(/my-vllm/)).toBeNull();
  });

  it("opts every credential field out of browser and manager autofill", async () => {
    stubProviders({ providers: [], gateways: [] });
    const { unmount } = renderProviders();

    const provider = await openAddProvider();
    const secretFields = [within(provider).getByLabelText("API key")];
    const plainFields = [within(provider).getByLabelText("Name")];
    await userEvent.click(within(provider).getByRole("button", { name: /cancel/i }));
    unmount();

    renderGateways();
    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    secretFields.push(within(dialog).getByLabelText("Gateway token"));
    plainFields.push(
      within(dialog).getByLabelText("Cloudflare Account ID"),
      within(dialog).getByLabelText("Cloudflare Gateway ID"),
      within(dialog).getByLabelText("Name"),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    for (const field of secretFields) {
      expect(field.getAttribute("autocomplete")).toBe("new-password");
    }
    // The text inputs matter too: a field beside a password is what makes the
    // browser treat the whole form as a sign-in and offer a saved username.
    for (const field of plainFields) {
      expect(field.getAttribute("autocomplete")).toBe("off");
    }
    for (const field of [...secretFields, ...plainFields]) {
      expect(field.getAttribute("data-1p-ignore")).toBe("true");
      expect(field.getAttribute("data-lpignore")).toBe("true");
    }
  });

  it("asks a Vercel gateway for nothing but a name and a token", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderGateways();

    await userEvent.click(screen.getByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    // Cloudflare is still the first entry, so its own fields are what shows.
    expect(within(dialog).getByLabelText("Cloudflare Account ID")).toBeTruthy();

    await choose(within(dialog).getByLabelText("Gateway type"), /vercel/i);
    // Its origin is fixed in adapter code and its token names the team, so
    // there is nothing else to ask for.
    expect(within(dialog).queryByLabelText("Cloudflare Account ID")).toBeNull();
    expect(within(dialog).queryByLabelText("Cloudflare Gateway ID")).toBeNull();
    // Honest wording: preferred, never "using your key".
    expect(within(dialog).getByText(/may fall back to system credentials/i)).toBeTruthy();

    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Team Vercel gateway");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "vck_live_token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways"),
      );
      expect(call?.body).toEqual({
        type: "vercel",
        name: "Team Vercel gateway",
        token: "vck_live_token",
      });
    });
  });

  it("adds a provider through an existing gateway instead of a key", async () => {
    const calls = stubProviders({ providers: [], gateways: [GATEWAY] });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    // A routed instance carries no secret of its own.
    expect(within(dialog).queryByLabelText("API key")).toBeNull();
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.url).toContain("/v1/admin/providers");
      expect(call?.body).toEqual({
        type: "openai",
        name: "OpenAI via CF",
        providerGatewayId: "gw-1",
      });
    });
  });

  it("creates a gateway in a second modal without losing the provider", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderProviders();

    const provider = await openAddProvider();
    await userEvent.type(within(provider).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(provider).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(provider).getByLabelText("Gateway"), /new gateway/i);

    // The gateway modal opens on top of the provider one, which keeps its state.
    const dialog = await topDialog();
    expect(dialog).not.toBe(provider);
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Fresh gateway");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways"),
      );
      expect(call?.body).toEqual({
        type: "cf_aig",
        name: "Fresh gateway",
        accountId: "acct-1",
        gatewayId: "cf-gw",
        token: "cf-aig-run-token",
      });
    });
    // Only the gateway modal closes; the provider it was created for is still
    // half-written underneath, with the new gateway pre-selected.
    await waitFor(() => expect(screen.queryByLabelText("Gateway token")).toBeNull());
    expect(within(provider).getByLabelText("Name")).toHaveProperty("value", "OpenAI via CF");
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);

    await userEvent.click(within(provider).getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/providers"),
      );
      expect(call?.body).toMatchObject({ providerGatewayId: CREATED_GATEWAY.id });
    });
  });

  it("checks a credential on request without storing it", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderProviders();

    const dialog = await openAddProvider();
    const test = within(dialog).getByRole("button", { name: /test provider/i });
    // Nothing to check until a credential is entered.
    expect(test).toHaveProperty("disabled", true);

    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    expect(test).toHaveProperty("disabled", false);
    await userEvent.click(test);

    expect(await within(dialog).findByText(/the provider accepted this credential/i)).toBeTruthy();
    const probe = calls.find((entry) => entry.url.endsWith("/providers/test"));
    expect(probe?.method).toBe("POST");
    expect(probe?.body).toEqual({ type: "openai", secret: SECRET });
    // A test is not a create: the modal stays open and nothing was stored.
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("does not gate adding a provider on the test, and drops a stale verdict", async () => {
    const calls = stubProviders({
      providers: [],
      gateways: [],
      testProvider: {
        status: 400,
        body: {
          error: {
            code: "provider_key_invalid",
            message: "The credential was rejected by the provider (HTTP 401)",
          },
        },
      },
    });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    expect(await within(dialog).findByText(/rejected by the provider/i)).toBeTruthy();
    // A failed check is advice, not a lock: the operator may still add it.
    const add = within(dialog).getByRole("button", { name: /add provider/i });
    expect(add).toHaveProperty("disabled", false);

    // Editing the credential retires the verdict, which was about the old one.
    await userEvent.type(within(dialog).getByLabelText("API key"), "-corrected");
    expect(within(dialog).queryByText(/rejected by the provider/i)).toBeNull();

    await userEvent.click(add);
    await waitFor(() => {
      const call = calls.find(
        (entry) => entry.method === "POST" && entry.url.endsWith("/providers"),
      );
      expect(call?.body).toMatchObject({ secret: "sk-wrong-corrected" });
    });
  });

  it("names what stopped a gateway check instead of calling it inconclusive", async () => {
    stubProviders({
      providers: [],
      gateways: [GATEWAY],
      testProvider: {
        status: 200,
        body: { validated: false, reason: "unexpected_status", status: 400 },
      },
    });
    renderProviders();

    const dialog = await openAddProvider();
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    // The status is the operator's only clue about which end is misconfigured.
    const refused = await within(dialog).findByText(/gateway answered with HTTP 400/i);
    expect(refused.textContent).toMatch(/stored key for OpenAI/i);
    // Something rejected the request, so it reads as the error it is.
    expect(refused.className).toContain("text-destructive");
  });

  it("keeps an upstream outage neutral rather than blaming the credential", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testProvider: {
        status: 200,
        body: { validated: false, reason: "unexpected_status", status: 503 },
      },
    });
    renderProviders();

    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    // A provider having a moment proves nothing either way, so it is not an error.
    const line = await within(dialog).findByText(/HTTP 503/i);
    expect(line.textContent).toMatch(/nothing is proven either way/i);
    expect(line.className).not.toContain("text-destructive");
  });

  it("says when a provider has no check of its own", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testProvider: { status: 200, body: { validated: false, reason: "no_probe" } },
    });
    renderProviders();

    const dialog = await openAddProvider();
    await choose(within(dialog).getByLabelText("Provider"), /perplexity/i);
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /test provider/i }));

    expect(await within(dialog).findByText(/no test call for Perplexity/i)).toBeTruthy();
  });

  it("adds a gateway on its own, with no provider selection", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderGateways();

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    // The old batch flow picked provider types here; each row is added on its own now.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    const tokenField = within(dialog).getByLabelText("Gateway token");
    await userEvent.type(tokenField, "cf-aig-run-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    await waitFor(() => {
      expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways")))
        .toBe(true);
    });
    expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/providers")))
      .toBe(false);
    expect(document.body.textContent).not.toContain("cf-aig-run-token");
  });

  it("checks a gateway connection on demand, without storing it", async () => {
    const calls = stubProviders({ providers: [], gateways: [] });
    renderGateways();

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-probe-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /test gateway/i }));

    expect(await within(dialog).findByText(/the gateway accepted this token/i)).toBeTruthy();
    const test = calls.find((entry) => entry.url.endsWith("/provider-gateways/test"));
    expect(test?.body).toEqual({
      type: "cf_aig",
      accountId: "acct-1",
      gatewayId: "cf-gw",
      token: "cf-aig-probe-token",
    });
    // A dry run stores nothing: the form is still open on the same fields.
    expect(calls.some((entry) =>
      entry.method === "POST" && entry.url.endsWith("/provider-gateways"))).toBe(false);
    expect(document.body.textContent).not.toContain("cf-aig-probe-token");
  });

  it("says a refused token can still be saved, and drops the verdict when it changes", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      testGateway: { status: 200, body: { validated: false, reason: "rejected", status: 401 } },
    });
    renderGateways();

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-bad-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /test gateway/i }));

    // The refusal names both things it can mean, and never disables the submit.
    const line = await within(dialog).findByText(/refused this token \(HTTP 401\)/i);
    expect(line.textContent).toMatch(/authentication is turned on/i);
    expect(within(dialog).getByRole("button", { name: /^add gateway$/i }))
      .toHaveProperty("disabled", false);

    // A verdict belongs to the connection that was probed, not the next one.
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "-2");
    expect(within(dialog).queryByText(/refused this token/i)).toBeNull();
  });

  it("stores a gateway without checking it, and says only that it was added", async () => {
    const success = vi.spyOn(toast, "success");
    const calls = stubProviders({ providers: [], gateways: [] });
    renderGateways();

    await userEvent.click(await screen.findByRole("button", { name: /add gateway/i }));
    const dialog = await topDialog();
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Account ID"), "acct-1");
    await userEvent.type(within(dialog).getByLabelText("Cloudflare Gateway ID"), "cf-gw");
    await userEvent.type(within(dialog).getByLabelText("Gateway token"), "cf-aig-unproven");
    await userEvent.click(within(dialog).getByRole("button", { name: /^add gateway$/i }));

    await waitFor(() => {
      expect(calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/provider-gateways")))
        .toBe(true);
    });
    // The connection is checked when the operator asks for it and at no other
    // time, so saving one nobody tested says nothing about whether it works.
    expect(calls.some((entry) => entry.url.endsWith("/provider-gateways/test"))).toBe(false);
    await waitFor(() => {
      expect(success).toHaveBeenCalledWith(`Added ${CREATED_GATEWAY.name}`);
    });
  });

  it("links a routed provider to its gateway's row in the other section", async () => {
    stubProviders();
    renderProviders();

    const link = await screen.findByRole("link", { name: "Prod CF gateway" });
    expect(link.getAttribute("href")).toBe("/providers/gateways#gateway-gw-1");

    await userEvent.click(link);

    // The anchor exists there, so the link lands on the gateway's own row.
    await waitFor(() => expect(document.getElementById("gateway-gw-1")).toBeTruthy());
  });

  it("refreshes the gateway counts when a routed provider is added", async () => {
    const calls = stubProviders({ providers: [], gateways: [GATEWAY] });
    renderProviders();
    const gatewayReads = () =>
      calls.filter((entry) => entry.method === "GET" && entry.url.includes("provider-gateways"))
        .length;

    await waitFor(() => expect(gatewayReads()).toBe(1));
    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "OpenAI via CF");
    await choose(within(dialog).getByLabelText("Authentication"), /use gateway/i);
    await choose(within(dialog).getByLabelText("Gateway"), /prod cf gateway/i);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    // The new row moves the gateway's providerCount, which is what decides
    // whether its delete action stays available.
    await waitFor(() => expect(gatewayReads()).toBe(2));
  });

  it("refreshes the gateway counts when a provider is deleted", async () => {
    const calls = stubProviders();
    renderProviders();
    const gatewayReads = () =>
      calls.filter((entry) => entry.method === "GET" && entry.url.includes("provider-gateways"))
        .length;

    await waitFor(() => expect(gatewayReads()).toBe(1));
    await runRowAction("Prod OpenAI", /delete provider/i);
    await userEvent.click(screen.getByRole("button", { name: /^delete provider$/i }));

    await waitFor(() => expect(gatewayReads()).toBe(2));
  });

  it("leaves the default slug free when the only instance chose a custom one", async () => {
    // The type is configured, but nothing holds `openai`, so the next instance
    // may still take the default and needs no manual slug.
    stubProviders({ providers: [{ ...DIRECT, slug: "openai-legacy" }], gateways: [] });
    renderProviders();

    await screen.findByText("openai-legacy");
    const dialog = await openAddProvider();
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
  });

  it("asks for a slug only once the default one is taken", async () => {
    const calls = stubProviders({ providers: [DIRECT], gateways: [] });
    renderProviders();

    // OpenAI is taken, so the default slug is unavailable and must be replaced.
    const dialog = await openAddProvider();
    const slugField = within(dialog).getByLabelText("Slug");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Dev OpenAI");
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    expect(within(dialog).getByRole("button", { name: /add provider/i }))
      .toHaveProperty("disabled", true);

    await userEvent.type(slugField, "openai-dev");
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));
    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "POST");
      expect(call?.body).toMatchObject({ slug: "openai-dev", type: "openai" });
    });

    // A type with no instance keeps today's URLs, so the field disappears.
    const reopened = await openAddProvider();
    await choose(within(reopened).getByLabelText("Provider"), /gemini/i);
    expect(within(reopened).queryByLabelText("Slug")).toBeNull();
  });

  it("reveals and focuses the slug field when the API reports the slug taken", async () => {
    stubProviders({
      providers: [],
      gateways: [],
      createProvider: {
        status: 409,
        body: { error: { code: "slug_taken", message: "An active provider instance already uses slug openai" } },
      },
    });
    renderProviders();

    // The client's list said nothing was configured, so no slug was asked for.
    const dialog = await openAddProvider();
    await userEvent.type(within(dialog).getByLabelText("Name"), "Prod OpenAI");
    expect(within(dialog).queryByLabelText("Slug")).toBeNull();
    await userEvent.type(within(dialog).getByLabelText("API key"), SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: /add provider/i }));

    // A rejected credential keeps the modal open on the field that fixes it.
    const slugField = await within(dialog).findByLabelText("Slug");
    await waitFor(() => expect(document.activeElement).toBe(slugField));
  });

  it("asks a Vercel gateway's row for nothing it has no answer to", async () => {
    stubProviders({ gateways: [VERCEL_GATEWAY] });
    renderGateways();

    const row = (await screen.findByText("Team Vercel gateway")).closest("tr")!;
    expect(within(row).getByText("Vercel AI Gateway")).toBeTruthy();
    // Its origin is fixed in adapter code, so the key is the whole of its auth.
    expect(within(row).getByText(/API key:/)).toBeTruthy();
    expect(within(row).getByText("…1abc")).toBeTruthy();
    expect(within(row).queryByText(/Account ID:/)).toBeNull();
    expect(within(row).queryByText(/Gateway ID:/)).toBeNull();
  });

  it("names every parameter a gateway is reached and admitted by", async () => {
    stubProviders({ gateways: [GATEWAY, SPARE_GATEWAY, RETIRED_GATEWAY] });
    renderGateways();

    const spare = (await screen.findByText("Spare gateway")).closest("tr")!;
    expect(within(spare).getByText("Cloudflare AI Gateway")).toBeTruthy();
    // Each part is labelled, rather than run together into one opaque string.
    expect(within(spare).getByText(/Account ID:/)).toBeTruthy();
    expect(within(spare).getByText("acct-1")).toBeTruthy();
    expect(within(spare).getByText(/Gateway ID:/)).toBeTruthy();
    expect(within(spare).getByText("cf-gw")).toBeTruthy();
    expect(within(spare).getByText(/API key:/)).toBeTruthy();
    expect(within(spare).getByText("…9xyz")).toBeTruthy();
    // A gateway still in use cannot be deleted, and says why.
    const inUse = await openRowActions("Prod CF gateway");
    expect(
      within(inUse).getByRole("menuitem", { name: /delete gateway/i }).getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.keyboard("{Escape}");
    const unused = await openRowActions("Spare gateway");
    expect(
      within(unused).getByRole("menuitem", { name: /delete gateway/i }).getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("blocks deleting a gateway only disabled rows still reference", async () => {
    stubProviders({ gateways: [RETIRED_GATEWAY] });
    renderGateways();

    // Nothing routes through it, but the foreign key counts disabled rows too,
    // so "delete the active instances first" would be unactionable advice.
    const menu = await openRowActions("Retired gateway");
    const blocked = within(menu).getByRole("menuitem", { name: /delete gateway/i });
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/disabled provider instances still reference this gateway/i))
      .toBeTruthy();
  });

  it("rotates the gateway token once for every provider behind it", async () => {
    const calls = stubProviders();
    renderGateways();

    await screen.findByText("acct-1");
    await runRowAction("Prod CF gateway", /update token/i);
    await userEvent.type(await screen.findByLabelText("New gateway token"), "cf-aig-new-token");
    await userEvent.click(screen.getByRole("button", { name: /update token/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.url.includes("/rotate"));
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-1/rotate");
      expect(call?.body).toEqual({ token: "cf-aig-new-token", revision: GATEWAY.revision });
    });
    expect(document.body.textContent).not.toContain("cf-aig-new-token");
  });

  it("renames a gateway without touching its connection", async () => {
    const calls = stubProviders();
    renderGateways();

    await screen.findByText("acct-1");
    await runRowAction("Prod CF gateway", /rename/i);
    const dialog = await screen.findByRole("dialog");
    await userEvent.clear(within(dialog).getByLabelText("Name"));
    await userEvent.type(within(dialog).getByLabelText("Name"), "Renamed gateway");
    await userEvent.click(within(dialog).getByRole("button", { name: /save name/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PATCH");
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-1");
      expect(call?.body).toEqual({ name: "Renamed gateway", revision: GATEWAY.revision });
    });
  });

  it("deletes a gateway nothing routes through", async () => {
    const calls = stubProviders({ gateways: [SPARE_GATEWAY] });
    renderGateways();

    await runRowAction("Spare gateway", /delete gateway/i);
    await userEvent.click(await screen.findByRole("button", { name: /^delete gateway$/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "DELETE");
      expect(call?.url).toContain("/v1/admin/provider-gateways/gw-2");
    });
  });

  it("rotates a credential in place", async () => {
    const calls = stubProviders();
    renderProviders();

    await screen.findByText("Prod OpenAI");
    await runRowAction("Prod OpenAI", /update key/i);
    await userEvent.type(await screen.findByLabelText("New API key"), "sk-rotated");
    await userEvent.click(screen.getByRole("button", { name: /update key/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.url).toContain("/v1/admin/providers/provider-1");
      expect(call?.body).toEqual({ secret: "sk-rotated", revision: DIRECT.revision });
    });
    expect(document.body.textContent).not.toContain("sk-rotated");
  });

  it("moves a row to another origin with the key the API insists on", async () => {
    const calls = stubProviders({
      providers: [{ ...DIRECT, baseUrl: "https://first.example.com/v1/" }, VIA_GATEWAY],
    });
    renderProviders();

    await screen.findByText("Prod OpenAI");
    await runRowAction("Prod OpenAI", /update key/i);
    // The field starts on the stored origin, and says why the key is needed.
    const origin = await screen.findByLabelText("Base URL");
    expect(origin).toHaveProperty("value", "https://first.example.com/v1/");
    expect(document.body.textContent).toContain("never sent to a new origin");

    await userEvent.type(await screen.findByLabelText("New API key"), "sk-rotated");
    await userEvent.clear(origin);
    await userEvent.type(origin, "https://second.example.com/v1/");
    await userEvent.click(screen.getByRole("button", { name: /update key/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.body).toEqual({
        secret: "sk-rotated",
        baseUrl: "https://second.example.com/v1/",
        revision: DIRECT.revision,
      });
    });
  });

  it("sends a gateway-routed row to the gateway for rotation", async () => {
    stubProviders();
    renderProviders();

    const menu = await openRowActions("Anthropic via CF");
    const rotate = within(menu).getByRole("menuitem", { name: /update key/i });
    expect(rotate.getAttribute("aria-disabled")).toBe("true");
    expect(rotate.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("edits custom model pricing without touching the credential", async () => {
    const calls = stubProviders();
    renderProviders();

    await runRowAction("Prod OpenAI", /pricing/i);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByDisplayValue("gpt-brand-new")).toBeTruthy();

    await userEvent.click(within(dialog).getByRole("button", { name: /add model/i }));
    await userEvent.type(within(dialog).getByLabelText("Model 2"), "another-model");
    await userEvent.type(within(dialog).getByLabelText("Input price 2"), "2");
    await userEvent.type(within(dialog).getByLabelText("Output price 2"), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: /save pricing/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.body).toEqual({
        pricing: {
          "gpt-brand-new": { input: 1.25, output: 10 },
          "another-model": { input: 2, output: 4 },
        },
        revision: DIRECT.revision,
      });
      // Nothing about the credential travels with a pricing edit.
      expect(call?.body.secret).toBeUndefined();
    });
  });

  it("keeps a dirty provider draft bound to the revision it opened from", async () => {
    const rows = [DIRECT, VIA_GATEWAY];
    const calls = stubProviders({ providers: rows });
    const { client } = renderProviders();

    await runRowAction("Prod OpenAI", /pricing/i);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Input price 1"), "5");
    rows[0] = { ...DIRECT, revision: 99 };
    await client.invalidateQueries({ queryKey: ["providers"] });
    await waitFor(() => {
      expect(client.getQueryData<{ providers: ProviderCredential[] }>(["providers"])?.providers[0]?.revision)
        .toBe(99);
    });
    await userEvent.click(within(dialog).getByRole("button", { name: /save pricing/i }));

    await waitFor(() => {
      const call = calls.find((entry) => entry.method === "PUT");
      expect(call?.body.revision).toBe(DIRECT.revision);
    });
  });

  it("refuses to save a pricing row with a missing price", async () => {
    const calls = stubProviders();
    const errorToast = vi.spyOn(toast, "error");
    renderProviders();

    await runRowAction("Prod OpenAI", /pricing/i);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /add model/i }));
    await userEvent.type(within(dialog).getByLabelText("Model 2"), "half-priced");
    await userEvent.type(within(dialog).getByLabelText("Input price 2"), "2");
    await userEvent.click(within(dialog).getByRole("button", { name: /save pricing/i }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(
        "Enter both prices for half-priced — use 0 only if it is genuinely free",
      );
    });
    // Nothing was sent, and the dialog stays open on the row that needs fixing.
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("spells out that deleting breaks apps within a minute", async () => {
    const calls = stubProviders();
    renderProviders();

    await runRowAction("Prod OpenAI", /delete provider/i);
    expect(await screen.findByText(/start failing within a minute/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^delete provider$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/providers/")))
        .toBe(true);
    });
  });

  /**
   * Disabling is the reversible alternative to deleting, so the row says which
   * one it is and the menu offers the opposite of whatever it currently is.
   */
  it("badges a disabled instance and offers to enable it", async () => {
    const calls = stubProviders({ providers: [DIRECT, DISABLED] });
    const successToast = vi.spyOn(toast, "success");
    renderProviders();

    await screen.findByText("Dev OpenAI");
    expect(screen.getByText("disabled")).toBeTruthy();

    // An active row is offered the disable; the paused one is offered enable.
    const active = await openRowActions("Prod OpenAI");
    expect(within(active).getByRole("menuitem", { name: /disable provider/i })).toBeTruthy();
    expect(within(active).queryByRole("menuitem", { name: /enable provider/i })).toBeNull();
    await userEvent.keyboard("{Escape}");

    // Enabling only ever restores traffic, so it needs no confirmation.
    await runRowAction("Dev OpenAI", /enable provider/i);
    await waitFor(() => {
      expect(calls.some((call) => call.method === "PUT" && call.body?.status === "active"))
        .toBe(true);
    });
    expect(successToast).toHaveBeenCalledWith("Enabled Dev OpenAI");
  });

  it("says when a disable bites, then sends the status", async () => {
    const calls = stubProviders();
    renderProviders();

    await runRowAction("Prod OpenAI", /disable provider/i);
    // How soon traffic stops is the one thing the operator cannot look up.
    expect(await screen.findByText(/start failing within a minute/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^disable provider$/i }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "PUT" && call.body?.status === "disabled"))
        .toBe(true);
    });
  });

  /**
   * Informational, never blocking: the operator is told which apps name the
   * slug outright and both actions go through regardless. All-mode apps are
   * absent by construction — they name nothing.
   */
  it("names the apps that reference the slug in the disable and delete dialogs", async () => {
    stubProviders({
      apps: [
        appSummary("Calorie Tracker", ["openai"]),
        appSummary("Recipe Finder", ["openai", "anthropic-cf"]),
        appSummary("Unrelated App", ["anthropic-cf"]),
      ],
    });
    renderProviders();

    await runRowAction("Prod OpenAI", /disable provider/i);
    expect(await screen.findByText(/calorie tracker, recipe finder/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

    await runRowAction("Prod OpenAI", /delete provider/i);
    expect(await screen.findByText(/calorie tracker, recipe finder/i)).toBeTruthy();
    // The confirm stays live: the warning describes the blast radius, it does
    // not veto the action.
    expect(screen.getByRole("button", { name: /^delete provider$/i }))
      .toHaveProperty("disabled", false);
  });

  it("says nothing extra when no app references the slug", async () => {
    stubProviders({ apps: [appSummary("Unrelated App", ["anthropic-cf"])] });
    renderProviders();

    await runRowAction("Prod OpenAI", /disable provider/i);
    await screen.findByText(/start failing within a minute/i);
    expect(screen.queryByText(/in its configuration/i)).toBeNull();
  });

  // Enabling has no failure of its own — the row kept its slug, so nothing can
  // be in the way — but the request can still fail, and the server's reason is
  // what the operator needs rather than a generic one.
  it("surfaces the server's reason when enabling fails", async () => {
    stubProviders({
      providers: [DISABLED],
      updateProvider: {
        status: 503,
        body: { error: { code: "provider_unavailable", message: "The secret vault is unavailable" } },
      },
    });
    const errorToast = vi.spyOn(toast, "error");
    renderProviders();

    await runRowAction("Dev OpenAI", /enable provider/i);
    await waitFor(() => {
      expect(errorToast)
        .toHaveBeenCalledWith(expect.stringMatching(/the secret vault is unavailable/iu));
    });
  });

  it("stops a read-only member changing anything", async () => {
    stubProviders();
    renderProviders("/providers", { session: { role: "member" } });

    await screen.findByText("Prod OpenAI");
    // The creation flows live behind these two buttons, so a read-only member
    // never reaches a field at all.
    expect(screen.getByRole("button", { name: /^add provider$/i }))
      .toHaveProperty("disabled", true);
    // The row menus still open, and each action says why it is unavailable.
    const menu = await openRowActions("Prod OpenAI");
    expect(
      within(menu).getByRole("menuitem", { name: /update key/i }).getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      within(menu).getByRole("menuitem", { name: /delete provider/i }).getAttribute("aria-disabled"),
    ).toBe("true");
    // Pricing is only a view until its own save button, which is guarded.
    expect(within(menu).getByRole("menuitem", { name: /pricing/i }).getAttribute("aria-disabled"))
      .toBeNull();
  });

  it("stops a read-only member adding a gateway", async () => {
    stubProviders();
    renderGateways({ session: { role: "member" } });

    expect(await screen.findByRole("button", { name: /add gateway/i }))
      .toHaveProperty("disabled", true);
  });
});
