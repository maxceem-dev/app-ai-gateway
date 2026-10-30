import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BillingPlanSelection } from "@contracts/billing";
import type { OperationParams, OperationQuery, OperationRequest } from "@contracts/catalog";
import type { UsageBreakdownDimension } from "@contracts/responses";
import { call } from "./api";
import { plainlySignedOut } from "./auth";
import { toAppWrite } from "./config-conversion";
import {
  changePassword,
  signInWithPassword,
  signOut,
  signUpWithPassword,
  type SignInInput,
  type SignUpInput,
} from "./auth";
import { checkoutReturnPathFor } from "./auth-redirect";
import type {
  AppCreateBody,
  AppUpsertBody,
  CreatedApp,
  ProviderCreateBody,
  ProviderGatewayCreateBody,
  ProviderGatewayTestBody,
  ProviderTestBody,
  ProviderUpdateBody,
} from "./types";

export const keys = {
  capabilities: ["capabilities"] as const,
  session: ["session"] as const,
  organizations: ["organizations"] as const,
  managementKeys: ["management-keys"] as const,
  providers: ["providers"] as const,
  providerGateways: ["provider-gateways"] as const,
  billingStatus: ["billing", "status"] as const,
  billingPlans: ["billing", "plans"] as const,
  /** Every month's apps list, for an invalidation that is about all of them. */
  appsPrefix: ["apps"] as const,
  apps: (month: string) => ["apps", month] as const,
  app: (appId: string) => ["app", appId] as const,
  apiKeys: (appId: string) => ["api-keys", appId] as const,
  /** Every page of one app's users, for an invalidation that is about all of them. */
  usersPrefix: (appId: string) => ["users", appId] as const,
  users: (appId: string, params: unknown) => ["users", appId, params] as const,
  usage: (appId: string, month: string) => ["usage", appId, month] as const,
  timeseries: (appId: string, from: string, to: string) => ["timeseries", appId, from, to] as const,
  breakdown: (appId: string, by: string, from: string, to: string) =>
    ["breakdown", appId, by, from, to] as const,
  events: (appId: string, params: unknown) => ["events", appId, params] as const,
  authEventSummary: (appId: string, days: number) => ["auth-event-summary", appId, days] as const,
  authEvents: (appId: string, params: unknown) => ["auth-events", appId, params] as const,
  rejectionEvents: (appId: string, params: unknown) => ["rejection-events", appId, params] as const,
  prices: ["prices"] as const,
};

/**
 * Deployment capabilities gate whole features (billing, signup, Google), so
 * they are fetched before anything else and never refetched.
 */
export function useCapabilities() {
  return useQuery({
    queryKey: keys.capabilities,
    queryFn: () => call("getConsoleCapabilities"),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}

/**
 * The operator's identity, active organization and role.
 *
 * Better Auth is asked first, and a browser it says is signed out is answered
 * `null` without a management call, which could only have been refused. A
 * 401 from the management API is still the unauthenticated case rather than
 * an error worth retrying, so the caller treats a failed query as "signed out".
 */
export function useSession() {
  return useQuery({
    queryKey: keys.session,
    queryFn: async () => (await plainlySignedOut()) ? null : (await call("getAdminSession")).session,
    retry: false,
    staleTime: 60_000,
  });
}

/** Sends the signed-in person a link that verifies their address. */
export function useSendVerificationEmail() {
  return useMutation({
    mutationFn: (returnTo?: string) =>
      call("sendVerificationEmail", { body: returnTo ? { returnTo } : {} }),
  });
}

/**
 * Confirms the link a verification email carried. The session says whether
 * the address is verified, so it is read again afterwards.
 */
export function useConfirmEmailVerification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => call("confirmEmailVerification", { body: { token } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.session }),
  });
}

export function useSignIn() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SignInInput) => {
      return signInWithPassword(input);
    },
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignUp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SignUpInput) => {
      return signUpWithPassword(input);
    },
    onSuccess: () => client.invalidateQueries(),
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => signOut(),
    // Clearing rather than invalidating drops every organization-scoped cache
    // so the next operator never sees the previous one's data.
    onSettled: () => {
      client.clear();
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      changePassword({ ...input, revokeOtherSessions: true }),
  });
}

export function useOrganizations(enabled = true) {
  return useQuery({
    queryKey: keys.organizations,
    queryFn: () => call("listOrganizations"),
    enabled,
  });
}

export function useSelectOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (organizationId: string) =>
      call("selectOrganization", { body: { organizationId } }),
    onSuccess: async (result) => {
      client.setQueryData(keys.session, result.session);
      // Every cached list is scoped to the previous organization, so its data
      // is dropped. Reset rather than `clear()`: clearing removes the queries
      // the mounted pages observe, which then keep rendering the previous
      // organization's data and never fetch again. A reset empties them in
      // place and refetches the ones on screen, under the new organization.
      // The session was just replaced, and capabilities describe the
      // deployment rather than an organization; resetting either would only
      // blank the whole shell while it reloads.
      const kept: readonly unknown[] = [keys.session[0], keys.capabilities[0]];
      await client.resetQueries({ predicate: (query) => !kept.includes(query.queryKey[0]) });
    },
  });
}

export function useManagementKeys() {
  return useQuery({
    queryKey: keys.managementKeys,
    queryFn: () => call("listManagementKeys"),
  });
}

export function useCreateManagementKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: OperationRequest<"createManagementKey">) =>
      call("createManagementKey", { body }),
    // The result holds the only copy of a live credential. Without this the
    // cached mutation outlives `reset()` and keeps the plaintext in memory.
    gcTime: 0,
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.managementKeys }),
  });
}

export function useRevokeManagementKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => call("revokeManagementKey", { params: { id: keyId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.managementKeys }),
  });
}

/**
 * `enabled` is for a reader that only sometimes needs the list — the first-run
 * checklist in the rail, which is on every page but up on few — so that a
 * console past its first request does not fetch providers everywhere it goes.
 */
export function useProviders(enabled = true) {
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => call("listProviders"),
    enabled,
  });
}

/**
 * The same list as an array, disabled rows included. A disabled instance still
 * exists and the server still accepts configuration naming it, so the editor
 * shows it with its own badge rather than dropping it and silently rewriting
 * what the app is configured to do.
 *
 * No deduplication needed: a slug is held by exactly one row until that row is
 * deleted, disabled rows included, so every slug appears at most once.
 */
export function useProviderInstances() {
  return useQuery({
    queryKey: keys.providers,
    queryFn: () => call("listProviders"),
    select: (data) => data.providers,
  });
}

/**
 * Adding or removing a provider row also moves its gateway's `providerCount`,
 * which is what enables or blocks that gateway's delete action on the same
 * screen — so both lists are refreshed together.
 */
function invalidateProviderLists(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: keys.providers });
  void client.invalidateQueries({ queryKey: keys.providerGateways });
}

/**
 * Provider credentials are submitted once and never returned. `gcTime: 0` keeps
 * the plaintext out of the mutation cache the moment the call settles, the same
 * way management-key creation does.
 */
export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProviderCreateBody) => call("createProvider", { body }),
    gcTime: 0,
    onSuccess: () => {
      invalidateProviderLists(client);
    },
  });
}

/**
 * Checks a credential against the provider without storing it, so testing is
 * something the operator may do rather than a gate on adding the provider.
 * `gcTime: 0` keeps the submitted secret out of the mutation cache.
 */
export function useTestProvider() {
  return useMutation({
    mutationFn: (body: ProviderTestBody) => call("testProviderCredential", { body }),
    gcTime: 0,
  });
}

export function useTestProviderGateway() {
  return useMutation({
    mutationFn: (body: ProviderGatewayTestBody) => call("testProviderGateway", { body }),
    gcTime: 0,
  });
}

/**
 * `enabled` lets a screen that only needs the gateways once a modal is open —
 * the add-provider dialog, reachable from the apps page — avoid the request
 * until then.
 */
export function useProviderGateways(enabled = true) {
  return useQuery({
    queryKey: keys.providerGateways,
    queryFn: () => call("listProviderGateways"),
    enabled,
  });
}

/**
 * Gateway mutations refresh the provider list too: a provider row is labelled
 * with its gateway's name. `gcTime: 0` keeps the tokens create and rotate carry
 * out of the mutation cache, as provider creation does.
 */
function useGatewayMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<TData>,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    gcTime: 0,
    onSuccess: () => invalidateProviderLists(client),
  });
}

export function useCreateProviderGateway() {
  return useGatewayMutation((body: ProviderGatewayCreateBody) =>
    call("createProviderGateway", { body }),
  );
}

/** An edit of one gateway: its id and the operation's own body. */
type GatewayEdit<K extends "updateProviderGateway" | "rotateProviderGateway"> =
  OperationParams<K> & OperationRequest<K>;

export function useRenameProviderGateway() {
  return useGatewayMutation(({ id, ...body }: GatewayEdit<"updateProviderGateway">) =>
    call("updateProviderGateway", { params: { id }, body }),
  );
}

/** A single re-encryption, shared by every provider behind the gateway. */
export function useRotateProviderGateway() {
  return useGatewayMutation(({ id, ...body }: GatewayEdit<"rotateProviderGateway">) =>
    call("rotateProviderGateway", { params: { id }, body }),
  );
}

export function useDeleteProviderGateway() {
  return useGatewayMutation((id: string) => call("deleteProviderGateway", { params: { id } }));
}

/**
 * Rotation, rename, pricing edits and the disable/enable toggle share one
 * endpoint. None of them move a row between gateways, so no gateway count
 * changes here — but a status change does move which instances an all-mode app
 * reaches, which the apps list reports, so that is refreshed with it.
 */
export function useUpdateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ProviderUpdateBody }) =>
      call("updateProvider", { params: { id }, body }),
    gcTime: 0,
    onSuccess: (_result, variables) => {
      void client.invalidateQueries({ queryKey: keys.providers });
      if (variables.body.status !== undefined) {
        void client.invalidateQueries({ queryKey: keys.appsPrefix });
      }
    },
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call("deleteProvider", { params: { id } }),
    onSuccess: () => invalidateProviderLists(client),
  });
}

/**
 * Billing hooks stay disabled unless the deployment reports the capability.
 *
 * A subscription can lapse while the console is open — a card expires, a trial
 * ends — and the data plane starts answering 402. Polling and refetching on
 * focus keep the banner honest without waiting for a reload; the query client
 * additionally refreshes this on any 402.
 */
export function useBillingStatus(enabled: boolean) {
  return useQuery({
    queryKey: keys.billingStatus,
    queryFn: () => call("getBillingStatus"),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useBillingPlans(enabled: boolean) {
  return useQuery({
    queryKey: keys.billingPlans,
    queryFn: () => call("listBillingPlans"),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useStartCheckout() {
  return useMutation({
    mutationFn: (input: BillingPlanSelection) =>
      call("startCheckout", { body: {
        ...input,
        // The landing announces the purchase; an abandoned checkout comes back
        // to the plans instead, which is where it would be resumed. The plan
        // travels with it because the return leg is otherwise bodyless, and the
        // landing reports which plan was bought.
        successUrl: `${window.location.origin}${checkoutReturnPathFor(input.planKey)}`,
        cancelUrl: `${window.location.origin}/billing`,
      } }),
  });
}

/**
 * Moves a live subscription between paid plans.
 *
 * Only for a subscription that already exists: the billing service answers
 * `409 billing_subscription_not_found` otherwise, and a first purchase has to
 * go through checkout instead. See `planAction` in `lib/billing`.
 */
export function useChangePlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BillingPlanSelection) =>
      call("changePlan", { body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.billingStatus }),
  });
}

export function useSendSupportMessage() {
  return useMutation({
    mutationFn: (body: OperationRequest<"sendSupportMessage">) => call("sendSupportMessage", { body }),
  });
}

export function useCancelSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => call("cancelSubscription"),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.billingStatus }),
  });
}

export function useResumeSubscription() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BillingPlanSelection) =>
      call("resumeSubscription", { body: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.billingStatus }),
  });
}

/**
 * `refetchInterval` is for a caller watching for something to arrive — the
 * first-run checklist waiting on an organization's first proxied request, which
 * this endpoint reports and which nothing in the console can trigger. Left off,
 * the query behaves exactly as every other list does.
 */
export function useApps(month: string, refetchInterval?: number) {
  return useQuery({
    queryKey: keys.apps(month),
    queryFn: () => call("listApps", { query: { month } }),
    ...(refetchInterval === undefined ? {} : { refetchInterval }),
  });
}

export function useApp(appId: string) {
  return useQuery({
    queryKey: keys.app(appId),
    queryFn: () => call("getApp", { params: { app: appId } }),
  });
}

export function useSaveApp(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ body, revision }: { body: AppUpsertBody; revision: number }) =>
      call("updateApp", { params: { app: appId }, body: { ...toAppWrite(body), revision } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.app(appId) });
      void client.invalidateQueries({ queryKey: keys.appsPrefix });
    },
  });
}

export function useCreateApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: AppCreateBody): Promise<CreatedApp> =>
      call("createApp", { body: toAppWrite(body) }),
    onSuccess: (created) => {
      void client.invalidateQueries({ queryKey: keys.app(created.app.id) });
      void client.invalidateQueries({ queryKey: keys.appsPrefix });
    },
  });
}

export function useDeleteApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (appId: string) => call("deleteApp", { params: { app: appId }, query: { confirm: appId } }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.appsPrefix }),
  });
}

export function useApiKeys(appId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: keys.apiKeys(appId),
    queryFn: () => call("listAppKeys", { params: { app: appId } }),
  });
}

export function useCreateApiKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => call("createAppKey", { params: { app: appId }, body: { name } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apiKeys(appId) }),
  });
}

export function useRevokeApiKey(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) => call("revokeAppKey", { params: { app: appId, key: keyId } }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.apiKeys(appId) }),
  });
}

export type UserQuery = OperationQuery<"listAppUsers">;

export function useUsers(appId: string, params: UserQuery) {
  return useQuery({
    queryKey: keys.users(appId, params),
    queryFn: () => call("listAppUsers", { params: { app: appId }, query: params }),
    placeholderData: (previous) => previous,
  });
}

export function useUserAction(appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, blocked }: { userId: string; blocked: boolean }) =>
      call(blocked ? "blockAppUser" : "unblockAppUser", {
        params: { app: appId, user: userId },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.usersPrefix(appId) });
      void client.invalidateQueries({ queryKey: keys.appsPrefix });
    },
  });
}

export function useMonthlyUsage(appId: string, month: string) {
  return useQuery({
    queryKey: keys.usage(appId, month),
    queryFn: () => call("getAppUsage", { params: { app: appId }, query: { month } }),
  });
}

export function useTimeseries(appId: string, from: string, to: string) {
  return useQuery({
    queryKey: keys.timeseries(appId, from, to),
    queryFn: () => call("getAppUsageTimeseries", { params: { app: appId }, query: { from, to } }),
  });
}

export function useBreakdown(appId: string, by: UsageBreakdownDimension, from: string, to: string) {
  return useQuery({
    queryKey: keys.breakdown(appId, by, from, to),
    queryFn: () => call("getAppUsageBreakdown", { params: { app: appId }, query: { by, from, to } }),
  });
}

/** The event filters, exactly as the operation's query schema takes them. */
export type EventQuery = OperationQuery<"listAppEvents">;

export function useEvents(appId: string, params: EventQuery) {
  return useQuery({
    queryKey: keys.events(appId, params),
    queryFn: () => call("listAppEvents", { params: { app: appId }, query: { ...params } }),
    placeholderData: (previous) => previous,
  });
}

/**
 * Authentication outcomes for a trailing window. Kept short-lived on purpose:
 * an operator opens this view while something is going wrong, and a stale
 * pending-activations count is exactly the number they came to watch.
 */
export function useAuthEventSummary(appId: string, days: number) {
  return useQuery({
    queryKey: keys.authEventSummary(appId, days),
    queryFn: () => call("getAppAuthEventSummary", { params: { app: appId }, query: { days } }),
    staleTime: 30_000,
  });
}

export type AuthEventQuery = OperationQuery<"listAppAuthEvents">;

export function useAuthEvents(appId: string, params: AuthEventQuery) {
  return useQuery({
    queryKey: keys.authEvents(appId, params),
    queryFn: () => call("listAppAuthEvents", { params: { app: appId }, query: { ...params } }),
    placeholderData: (previous) => previous,
  });
}

export type RejectionEventQuery = OperationQuery<"listAppRejectionEvents">;

export function useRejectionEvents(appId: string, params: RejectionEventQuery) {
  return useQuery({
    queryKey: keys.rejectionEvents(appId, params),
    queryFn: () => call("listAppRejectionEvents", { params: { app: appId }, query: { ...params } }),
    placeholderData: (previous) => previous,
  });
}

export function usePrices() {
  return useQuery({
    queryKey: keys.prices,
    queryFn: () => call("listModelPrices"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
