import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrganizationMenuItems } from "./org-switcher";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { membership, renderAuthenticated } from "@/test/render";

afterEach(() => vi.unstubAllGlobals());

/** The section only ever renders inside the account menu, so tests open one. */
function inOpenMenu() {
  return (
    <DropdownMenu open>
      <DropdownMenuContent>
        <OrganizationMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("OrganizationMenuItems", () => {
  it("renders nothing for a single membership", () => {
    renderAuthenticated(inOpenMenu(), {
      session: { memberships: [membership("org-1", "Acme")] },
    });

    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.queryByText(/organizations/i)).toBeNull();
  });

  it("lists every membership when there are several", async () => {
    renderAuthenticated(inOpenMenu(), {
      session: {
        memberships: [
          membership("org-1", "Acme", "owner"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });

    expect(await screen.findByRole("menuitem", { name: /globex/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /acme/i })).toBeTruthy();
  });

  it("drops every organization-scoped cache when switching", async () => {
    const nextSession = {
      session: {
        user: { id: "user-1", email: "ada@example.test" },
        organization: { id: "org-2", name: "Globex" },
        role: "member",
        memberships: [],
        credentialType: "session",
      },
    };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(nextSession), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = renderAuthenticated(inOpenMenu(), {
      session: {
        memberships: [
          membership("org-1", "Acme", "owner"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });
    // Data belonging to the organization being switched away from.
    client.setQueryData(["apps", "2026-08"], { apps: [{ id: "acme-only-app" }] });

    await userEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));

    await waitFor(() => {
      // Keeping it would show the previous tenant's apps under the new org.
      expect(client.getQueryData(["apps", "2026-08"])).toBeUndefined();
      expect(client.getQueryData(["session"])).toMatchObject({
        organization: { id: "org-2" },
      });
    });
  });

  it("refetches what is on screen under the new organization", async () => {
    const nextSession = {
      session: {
        user: { id: "user-1", email: "ada@example.test" },
        organization: { id: "org-2", name: "Globex" },
        role: "member",
        memberships: [],
        credentialType: "session",
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify(nextSession), { status: 200 })));
    // Stands in for a page: what it shows depends on which organization the
    // cookie names when it fetches, which the switch changes.
    let acting = "Acme";
    function Page() {
      const { data } = useQuery({ queryKey: ["apps"], queryFn: async () => `${acting} apps` });
      return <p>{data ?? "loading"}</p>;
    }

    renderAuthenticated(
      <>
        {inOpenMenu()}
        <Page />
      </>,
      {
        session: {
          memberships: [
            membership("org-1", "Acme", "owner"),
            membership("org-2", "Globex", "member"),
          ],
        },
      },
    );
    expect(await screen.findByText("Acme apps")).toBeTruthy();

    acting = "Globex";
    await userEvent.click(await screen.findByRole("menuitem", { name: /globex/i }));

    // Clearing the cache instead left this showing "Acme apps" for good.
    expect(await screen.findByText("Globex apps")).toBeTruthy();
  });

  it("stays available to a read-only member", async () => {
    renderAuthenticated(inOpenMenu(), {
      session: {
        role: "member",
        memberships: [
          membership("org-1", "Acme", "member"),
          membership("org-2", "Globex", "member"),
        ],
      },
    });

    const item = await screen.findByRole("menuitem", { name: /globex/i });
    expect(item.getAttribute("data-disabled")).toBeNull();
  });
});
