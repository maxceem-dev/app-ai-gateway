import { useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useMatch, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Bug,
  Cable,
  ChevronsUpDown,
  CreditCard,
  Eye,
  KeyRound,
  Headset,
  LayoutGrid,
  LifeBuoy,
  LogOut,
  MessageSquareHeart,
  Plug,
  Settings,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { SupportMessageKind } from "@contracts/schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AllowanceBar } from "@/components/allowance-bar";
import { Brand } from "@/components/brand";
import { GettingStarted } from "@/components/getting-started";
import { OrganizationMenuItems } from "@/components/org-switcher";
import { SUPPORT_KINDS, SUPPORT_MESSAGE_ID, SupportDialog, useSupportAvailable } from "@/components/support-dialog";
import { AppStatusBadge } from "@/components/status-badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { APP_SECTIONS } from "@/lib/app-sections";
import { entitledPlan, QUOTA_WARNING_RATIO, quotaMeter } from "@/lib/billing";
import { useConsoleSession } from "@/lib/console-session";
import { READ_ONLY_REASON } from "@/lib/permissions";
import { useApp, useSignOut } from "@/lib/queries";
import { useUnsavedDraft } from "@/lib/unsaved-draft";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  /** Lists the destination holds besides its own, revealed once inside it. */
  sections?: { to: string; label: string; icon: typeof LayoutGrid }[];
}

/**
 * The console has exactly two places to be. Everything else is account or
 * organization administration, which lives in the user menu at the foot of the
 * sidebar rather than competing with them here.
 *
 * Gateways hang under Providers rather than beside it: most deployments never
 * add one, and it is the providers list they support. The destination keeps its
 * own list, so only the gateways need a row of their own.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/apps", label: "Apps", icon: LayoutGrid },
  {
    // A plug, for the list as connections made: adding a provider is handing
    // the gateway one vendor's key. The fan-out below it says the other half —
    // one connection several providers share.
    to: "/providers",
    label: "Providers",
    icon: Plug,
    // Two connectors on one cable: a gateway is a connection with a provider
    // at each end of it, made once and borrowed by every provider behind it.
    // The single plug above says the other half — one vendor, one key.
    sections: [{ to: "/providers/gateways", label: "Gateways", icon: Cable }],
  },
];

/**
 * The plan the organization is on, and how much of its allowance is left.
 *
 * The console's only persistent statement of either: the billing page is the
 * one other place to read them, and the banner that warns about the allowance
 * appears only once four fifths of it is gone, so without this an operator can
 * spend an allowance they have never seen a number for. The figure is the same
 * one the billing page draws, from the same reading the shell already holds, so
 * this costs no request of its own.
 *
 * Never rendered without the billing capability: a self-hosted deployment has
 * no plan, and a rail row about one would be a permanent question with no
 * answer. Also silent when billing is enabled but the reading says nothing yet
 * — mid-flight, or unreachable — rather than guessing at a plan name.
 */
function PlanSummary({ onNavigate }: { onNavigate?: () => void }) {
  const { capabilities, billing, quota, canManage, organization } = useConsoleSession();
  const location = useLocation();

  if (!capabilities.billing) return null;

  const plan = entitledPlan(billing);
  const meter = quotaMeter(quota, organization);
  if (!plan && !meter) return null;

  const current = location.pathname === "/billing";
  /*
   * Two situations put a plan up for changing, and nothing else does.
   *
   * The first is the plan every organization starts on, where an upgrade is the
   * whole point of naming it. `isDefault` rather than a plan key: the free tier
   * is whichever plan the billing service falls back to, and a deployment is
   * free to name it something other than `free`. A reading with no plan at all
   * is the paywall, which is the same situation with nothing to show for it.
   *
   * The second is a paid plan whose allowance is nearly gone, where more of it
   * is about to be the operator's actual problem. The same line the meter and
   * the banner use, so the console never warns that an allowance is running out
   * while quietly withholding the one thing that would fix it. Below it the
   * block is a statement and not an offer: a customer who pays and has plenty of
   * room left is told what they have and how much is spent, and is sold nothing.
   */
  const nearlySpent = meter !== null && meter.ratio !== null && meter.ratio >= QUOTA_WARNING_RATIO;
  const changeable = plan === null || plan.isDefault || nearlySpent;

  return (
    <div
      className={cn(
        "rounded-lg px-3 py-2.5 transition-colors",
        current ? "bg-sidebar-accent text-sidebar-accent-foreground" : "bg-sidebar-accent/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">
          {plan ? `${plan.planName} plan` : "No plan"}
        </span>
        {/*
          Named for what it does for this operator: a member cannot buy
          anything, so offering them an upgrade would be an action they are
          refused on arrival.
        */}
        {changeable ? (
          <Link
            to="/billing"
            onClick={onNavigate}
            aria-current={current ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-sm text-xs font-medium underline underline-offset-4 transition-colors",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              current ? "text-sidebar-accent-foreground" : "text-primary-ink hover:text-foreground",
            )}
          >
            {canManage ? "Upgrade" : "View plan"}
          </Link>
        ) : null}
      </div>

      {meter ? (
        <div className="mt-1.5 space-y-1">
          <p className="tabular text-[11px] text-muted-foreground">{meter.label}</p>
          <AllowanceBar meter={meter} className="h-1" />
        </div>
      ) : null}
    </div>
  );
}

/** Read-only members see why the console looks restricted, once, above their account. */
function ReadOnlyBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="w-full justify-start gap-1.5 py-1">
          <Eye className="size-3" />
          Read-only
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">{READ_ONLY_REASON}</TooltipContent>
    </Tooltip>
  );
}

/** Two letters from the operator's name, or their email as a fallback. */
function initialsFor(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

const SUPPORT_ICONS: Record<SupportMessageKind, typeof LayoutGrid> = {
  bug: Bug,
  support: Headset,
  feedback: MessageSquareHeart,
};

/**
 * The Support submenu, for an organization on a paid plan. Its one label says
 * why it is there — support comes with the plan — rather than a badge on the
 * row, which would read as something to buy.
 */
function SupportMenu({ onChoose }: { onChoose: (kind: SupportMessageKind) => void }) {
  const { billing } = useConsoleSession();
  const plan = entitledPlan(billing);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LifeBuoy className="size-4" />
        Human Support
      </DropdownMenuSubTrigger>
      {/* Portalled: the menu it opens from animates with a transform, which
          would otherwise become the containing block it is positioned in. */}
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="min-w-52">
          {plan ? (
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Included with your {plan.planName} plan
            </DropdownMenuLabel>
          ) : null}
          {(Object.keys(SUPPORT_KINDS) as SupportMessageKind[]).map((kind) => {
            const Icon = SUPPORT_ICONS[kind];
            return (
              <DropdownMenuItem key={kind} onSelect={() => onChoose(kind)}>
                <Icon className="size-4" />
                {SUPPORT_KINDS[kind].menuLabel}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/**
 * The account block. Names the operator and nothing else; opening it reveals
 * the account-scoped and organization-scoped screens, the organizations they
 * can act as, support where their plan includes it, and sign-out.
 */
function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const { session, capabilities } = useConsoleSession();
  const signOut = useSignOut();
  const supportAvailable = useSupportAvailable();
  const [support, setSupport] = useState<SupportMessageKind | null>(null);
  // Set when a support item is chosen, read once the menu has closed: a ref,
  // because the menu finishes closing after the render that opened the dialog.
  const openingSupport = useRef(false);
  const chooseSupport = (kind: SupportMessageKind) => {
    openingSupport.current = true;
    setSupport(kind);
  };

  const logout = async () => {
    await signOut.mutateAsync().catch(() => undefined);
    await navigate("/login", { replace: true });
  };

  const email = session.user?.email ?? "Operator";
  const name = session.user?.name?.trim() || email;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
            "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
        >
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground"
          >
            {initialsFor(session.user?.name, email)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          // The menu hands focus back to its trigger once it has closed, after
          // the support dialog it opened took focus. Send it to the message
          // instead: the last move wins, whatever the animations' timing.
          onCloseAutoFocus={(event) => {
            if (!openingSupport.current) return;
            openingSupport.current = false;
            event.preventDefault();
            document.getElementById(SUPPORT_MESSAGE_ID)?.focus();
          }}
        >
          <DropdownMenuItem asChild>
            <Link to="/settings" onClick={onNavigate}>
              <Settings className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/access" onClick={onNavigate}>
              <KeyRound className="size-4" />
              Access
            </Link>
          </DropdownMenuItem>
          {capabilities.billing ? (
            <DropdownMenuItem asChild>
              <Link to="/billing" onClick={onNavigate}>
                <CreditCard className="size-4" />
                Billing
              </Link>
            </DropdownMenuItem>
          ) : null}
          <OrganizationMenuItems />
          {supportAvailable ? (
            <>
              <DropdownMenuSeparator />
              <SupportMenu onChoose={chooseSupport} />
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={signOut.isPending} onSelect={() => void logout()}>
            <LogOut className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Outside the menu, which unmounts its content as it closes. */}
      {supportAvailable ? (
        <SupportDialog kind={support} onOpenChange={(open) => !open && setSupport(null)} />
      ) : null}
    </>
  );
}

/** A row of the rail, whether it names a destination or a section of one. */
function RailLink({
  to,
  label,
  icon: Icon,
  current,
  onNavigate,
  className,
}: {
  to: string;
  label: string;
  icon?: typeof LayoutGrid;
  current: boolean;
  onNavigate?: () => void;
  className?: string;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-10 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-colors",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        current
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
        className,
      )}
    >
      {Icon ? <Icon className="size-4 shrink-0" /> : null}
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** The console's own destinations, shown whenever no record has the rail. */
function RootNav({ onNavigate }: { onNavigate?: () => void }) {
  const location = useLocation();

  return (
    <nav className="flex flex-col gap-1 p-3">
      {NAV_ITEMS.map((item) => {
        const active = location.pathname.startsWith(item.to);
        const sections = active ? item.sections : undefined;
        // The destination holds its own list, so it is the current page
        // whenever none of the sections under it is.
        const current = active && !sections?.some((entry) => entry.to === location.pathname);
        return (
          <div key={item.to} className="flex flex-col gap-1">
            <RailLink
              to={item.to}
              label={item.label}
              icon={item.icon}
              current={current}
              onNavigate={onNavigate}
            />

            {sections ? (
              // Nothing draws the nesting: a section's mark starts where its
              // destination's label does, which says it belongs to it without
              // a rule down the side of the rail. The pills stay one column
              // wide. (px-3 + a size-4 mark + gap-2.5 is the 9.5 below.)
              <div className="flex flex-col gap-1">
                {sections.map((section) => (
                  <RailLink
                    key={section.to}
                    to={section.to}
                    label={section.label}
                    icon={section.icon}
                    current={location.pathname === section.to}
                    onNavigate={onNavigate}
                    className="h-9 pr-3 pl-9.5"
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The rail one record takes over while it is open: the way back out, the
 * record it belongs to, then that record's sections.
 *
 * The way out is the first row under the brand and never moves, so a second
 * kind of record — a provider, a gateway — can be given the same treatment
 * without the operator having to look for it somewhere new. `title` names the
 * record, and is the page's heading: the content beside the rail does not
 * repeat it, so it is set large enough to be read as one. `badge` sits under
 * the name for a state worth seeing from every section, such as disabled;
 * `mark` sits across from the way out, above the name, for a state of the
 * visit rather than of the record, such as unsaved changes.
 */
function DrillInRail({
  back,
  mark,
  title,
  badge,
  items,
  onNavigate,
}: {
  back: { to: string; label: string };
  mark?: ReactNode;
  title: string;
  badge?: ReactNode;
  items: { to: string; label: string; icon?: typeof LayoutGrid }[];
  onNavigate?: () => void;
}) {
  const location = useLocation();

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2 border-b border-sidebar-border px-3 pb-3">
        <div className="flex items-center justify-between gap-2 pr-2">
          <Link
            to={back.to}
            onClick={onNavigate}
            className={cn(
              "flex h-8 w-fit items-center gap-1.5 rounded-lg px-2 text-sm text-muted-foreground transition-colors",
              "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            )}
          >
            <ArrowLeft className="size-3.5 shrink-0" />
            {back.label}
          </Link>
          {mark}
        </div>

        <div className="min-w-0 space-y-1.5 px-2 pt-1 pb-1">
          <h1 className="line-clamp-2 text-lg leading-snug font-semibold tracking-tight break-words">
            {title}
          </h1>
          {badge}
        </div>
      </div>

      <nav
        aria-label={`${title} sections`}
        className="flex flex-col gap-1 p-3"
      >
        {items.map((item) => (
          <RailLink
            key={item.to}
            to={item.to}
            label={item.label}
            icon={item.icon}
            // A section may have pages of its own under it; the row stays lit
            // on every one of them.
            current={location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </div>
  );
}

/**
 * The rail for one app. The name is read from the same query the detail page
 * uses, so opening an app costs no extra request; until it resolves the id
 * stands in, which is what the URL already says. The id is otherwise not shown
 * here: it lives on the Settings section, and inside the client base URL.
 */
function AppRail({ appId, onNavigate }: { appId: string; onNavigate?: () => void }) {
  const app = useApp(appId);
  const unsaved = useUnsavedDraft();

  return (
    <DrillInRail
      back={{ to: "/apps", label: "Apps" }}
      mark={
        unsaved ? (
          <Badge className="border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
            Unsaved
          </Badge>
        ) : undefined
      }
      title={app.data?.app.name ?? appId}
      badge={app.data ? <AppStatusBadge status={app.data.app.status} /> : undefined}
      items={APP_SECTIONS.map((section) => ({
        to: `/apps/${appId}/${section.slug}`,
        label: section.label,
        icon: section.icon,
      }))}
      onNavigate={onNavigate}
    />
  );
}

/**
 * Sidebar body, shared by the fixed desktop rail and the mobile drawer.
 * `onNavigate` lets the drawer close itself once a destination is chosen.
 *
 * Opening a single app hands the rail to that app rather than nesting its
 * sections under Apps: they are sections of one record, and a list of every
 * app with one of them expanded would say less about where the operator is.
 */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { readOnly } = useConsoleSession();
  const appMatch = useMatch("/apps/:appId/*");

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <Brand className="px-1" onClick={onNavigate} />
        <ThemeToggle />
      </div>

      {/* The one region that scrolls, so the account block stays put. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {appMatch?.params.appId ? (
          <AppRail appId={appMatch.params.appId} onNavigate={onNavigate} />
        ) : (
          <RootNav onNavigate={onNavigate} />
        )}

        {/* Right under whichever rail is up, where it is seen first: the step
            left after an app is created is finished from inside that app. */}
        <GettingStarted />
      </div>

      <div className="flex flex-col gap-1 border-t border-sidebar-border p-3">
        <PlanSummary onNavigate={onNavigate} />
        {readOnly ? (
          <div className="px-1 pb-1.5">
            <ReadOnlyBadge />
          </div>
        ) : null}
        <UserMenu onNavigate={onNavigate} />
      </div>
    </div>
  );
}
