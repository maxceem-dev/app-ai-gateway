import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GatewayIcon, ProviderIcon, ProviderName } from "@/components/brand-icon";
import { EmptyState, SectionHeader } from "@/components/field";
import { RangePicker } from "@/components/pickers";
import { EventStatusBadge } from "@/components/status-badge";
import { isGatewayType } from "@/lib/config-types";
import { isProviderType } from "@shared/providers";
import {
  cachedInputRate,
  daysAgo,
  formatCompact,
  formatCost,
  formatCostToCent,
  formatDateTime,
  formatNumber,
  formatPercent,
  inputTokens,
  today,
  totalTokens,
} from "@/lib/format";
import { useBreakdown, useEvents, useTimeseries } from "@/lib/queries";
import type { UsageBreakdownDimension, UsageStatus } from "@contracts/responses";
import { OTHER, pivot, type Metric } from "@/lib/usage-pivot";

/**
 * The categorical slots, in the fixed order they were validated in — see the
 * comment on `--chart-1` in `index.css`. Assigned in sequence and never cycled:
 * a series past the last of them does not get a hue, because `pivot` has
 * already folded it into `OTHER`. There are exactly `MAX_SERIES` of these, and
 * `@/lib/usage-pivot` is where that number is written.
 */
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
];

const BREAKDOWNS = [
  { value: "model", label: "By model" },
  { value: "model_author", label: "By model author" },
  { value: "provider", label: "By provider" },
  // The transport a request took and whose key paid for it are questions the
  // provider alone cannot answer, so each gets its own dimension.
  { value: "provider_gateway", label: "By gateway" },
  { value: "credential_source", label: "By credential source" },
  // Who made the traffic; which of these an app offers is decided below.
  { value: "user", label: "By user" },
  { value: "install", label: "By install" },
  { value: "status", label: "By status" },
  { value: "cost_source", label: "By cost source" },
  { value: "route", label: "By route" },
  { value: "endpoint", label: "By endpoint" },
  { value: "app_version", label: "By app version" },
] as const;

/**
 * The brand a breakdown key names, on the two dimensions whose keys are types
 * rather than free-form strings. The key itself stays exactly as recorded —
 * these are the values the API groups by, and an event from before a type
 * existed simply has no mark.
 */
function BreakdownMark({ dimension, value }: { dimension: string; value: string }) {
  if (dimension === "provider" && isProviderType(value)) return <ProviderIcon type={value} />;
  if (dimension === "provider_gateway" && isGatewayType(value)) return <GatewayIcon type={value} />;
  return null;
}

export function UsageTab({
  appId,
  identity = "user",
  showInstalls = false,
}: {
  appId: string;
  /**
   * Who an app's traffic is broken down by: an App Attest app's install, or
   * its user when its budget is measured per user; a server app's user.
   */
  identity?: "user" | "install";
  /** Whether events name the install that made them: App Attest apps only. */
  showInstalls?: boolean;
}) {
  const breakdowns = BREAKDOWNS.filter((entry) =>
    entry.value === "user" || entry.value === "install" ? entry.value === identity : true);
  const [days, setDays] = useState("30");
  const [metric, setMetric] = useState<Metric>("cost_usd");
  const [dimension, setDimension] = useState<UsageBreakdownDimension>("model");
  const [eventStatus, setEventStatus] = useState<UsageStatus | "all">("all");
  const [cursors, setCursors] = useState<number[]>([]);

  const from = daysAgo(Number(days) - 1);
  const to = today();
  const series = useTimeseries(appId, from, to);
  const breakdown = useBreakdown(appId, dimension, from, to);
  const events = useEvents(appId, {
    limit: 25,
    status: eventStatus === "all" ? undefined : eventStatus,
    before_id: cursors.at(-1),
  });

  const chart = useMemo(
    () => pivot(series.data?.buckets ?? [], from, to, metric),
    [series.data, from, to, metric],
  );

  // The legend and the tooltip both take a node, so a series is named with the
  // provider's mark beside its label — the colour swatch is what ties the entry
  // to its bar, and stays. A series whose key is not a provider type at all is
  // an older event's, and is named as it was recorded.
  const config: ChartConfig = Object.fromEntries(
    chart.providers.map((provider, index) => [
      provider,
      provider === OTHER
        ? {
            label: `Other (${chart.foldedCount})`,
            // Neutral on purpose: the band is a remainder, not a brand, and it
            // must not read as a ninth entry in the categorical order.
            color: "var(--chart-other)",
          }
        : {
            label: isProviderType(provider) ? <ProviderName type={provider} /> : provider,
            // Straight indexing, never `% length`: the seventh series is the
            // last that gets a hue, and `pivot` has already folded the rest.
            color: CHART_COLORS[index],
          },
    ]),
  );

  // The chart plots a day's total for one provider, not one request, so its
  // costs read to the cent — see `formatCostToCent`.
  const formatMetric = (value: number) =>
    metric === "cost_usd" ? formatCostToCent(value) : formatCompact(value);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <SectionHeader
            title="Daily usage by provider"
            description={`${from} to ${to}`}
            action={
              <div className="flex gap-2">
                <Select value={metric} onValueChange={(next) => setMetric(next as Metric)}>
                  <SelectTrigger className="w-[130px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost_usd">Cost</SelectItem>
                    <SelectItem value="requests">Requests</SelectItem>
                    <SelectItem value="tokens">Tokens</SelectItem>
                  </SelectContent>
                </Select>
                <RangePicker value={days} onChange={setDays} />
              </div>
            }
          />
        </CardHeader>
        <CardContent>
          {series.isPending ? (
            <Skeleton className="h-[220px] w-full" />
          ) : chart.providers.length === 0 ? (
            <EmptyState>No requests recorded in this range.</EmptyState>
          ) : (
            <ChartContainer config={config} className="h-[220px] w-full">
              <BarChart data={chart.rows} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(value: string) => value.slice(5)}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(value: number) => formatMetric(value)}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      valueFormatter={(value) => formatMetric(Number(value))}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {chart.providers.map((provider) => (
                  <Bar
                    key={provider}
                    dataKey={provider}
                    stackId="usage"
                    fill={`var(--color-${provider})`}
                    radius={[2, 2, 0, 0]}
                  />
                ))}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Breakdown"
            action={
              <Select
                value={dimension}
                // Only this select's own items can reach it, and each is a dimension.
                onValueChange={(next) => setDimension(next as UsageBreakdownDimension)}
              >
                <SelectTrigger className="w-[170px]" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {breakdowns.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{dimension}</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                {/* Input is every prompt token, cached and cache-written ones
                    included, which is what the two columns after it are a
                    share of. */}
                <TableHead className="text-right">Total input</TableHead>
                <TableHead className="text-right">Cached input</TableHead>
                <TableHead className="text-right">Cache write</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.isPending ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : breakdown.data?.rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    Nothing recorded in this range.
                  </TableCell>
                </TableRow>
              ) : (
                breakdown.data?.rows.map((row) => (
                  <TableRow key={row.key ?? "unknown"}>
                    <TableCell className="font-mono text-xs">
                      {row.key === null ? (
                        <span className="text-muted-foreground">none</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          <BreakdownMark dimension={dimension} value={row.key} />
                          {row.key}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">{formatNumber(row.requests)}</TableCell>
                    <TableCell className="tabular text-right">{formatCompact(inputTokens(row))}</TableCell>
                    <TableCell className="tabular text-right">
                      <span className="block">{formatCompact(row.cached_input_tokens)}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {formatPercent(cachedInputRate(row))} of input
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatCompact(row.cache_write_tokens)}</TableCell>
                    <TableCell className="tabular text-right">{formatCompact(row.output_tokens)}</TableCell>
                    <TableCell className="tabular text-right">{formatCost(row.cost_usd)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-6">
          <SectionHeader
            title="Recent events"
            description="Every proxied request, newest first."
            action={
              <Select
                value={eventStatus}
                onValueChange={(next) => {
                  setEventStatus(next as UsageStatus | "all");
                  setCursors([]);
                }}
              >
                <SelectTrigger className="w-[170px]" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ok">ok</SelectItem>
                  <SelectItem value="provider_error">provider_error</SelectItem>
                  {/*
                    Labelled rather than raw, because the value alone does not
                    say who refused the request, and that is the distinction an
                    operator is filtering for: the app's own limits, or the plan.
                  */}
                </SelectContent>
              </Select>
            }
          />
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>When</TableHead>
                <TableHead>{showInstalls ? "User / install" : "User / key"}</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Latency</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <TableRow>
                  <TableCell colSpan={8}>
                    <Skeleton className="h-8 w-full" />
                  </TableCell>
                </TableRow>
              ) : events.data?.events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                    No events.
                  </TableCell>
                </TableRow>
              ) : (
                events.data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(event.created_at)}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* An application that identifies no end users has none to
                          name here, and an empty cell would read as a lost
                          value rather than an absent one. */}
                      {event.user_id ?? (
                        <span className="font-sans text-muted-foreground">No end user</span>
                      )}
                      {/* Key attribution is absent for attested traffic, so only render it when set. */}
                      {event.api_key_id ? (
                        <span className="block text-muted-foreground">{event.api_key_id}</span>
                      ) : null}
                      {/* Under app_install the install is the user, already named above. */}
                      {showInstalls && event.install_id && event.install_id !== event.user_id ? (
                        <span className="block text-muted-foreground" title="Install (App Attest key id)">
                          {event.install_id}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{event.model}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {event.endpoint_slug ? `${event.endpoint_slug} → ${event.route}` : event.route}
                      {/* The configured route, which is known with certainty;
                          a direct call has no gateway to name. */}
                      {/* The stored type is the one that carried the request,
                          which may be one this console has no mark for: the
                          event records what was true then, not what is
                          configurable now. Named either way; illustrated only
                          when it is a gateway this build knows. */}
                      {event.provider_gateway_type ? (
                        <span className="flex items-center gap-1">
                          via{" "}
                          {isGatewayType(event.provider_gateway_type) ? (
                            <GatewayIcon type={event.provider_gateway_type} />
                          ) : null}
                          {event.provider_gateway_type}
                        </span>
                      ) : null}
                      {/* Observed, not configured: only shown when the upstream
                          named the host that actually served the request. */}
                      {event.served_provider ? (
                        <span className="block">Served by {event.served_provider}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {formatCompact(totalTokens(event))}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {/* An unresolved event was not billed because its usage
                          was unreadable, so showing $0.00 would be a claim the
                          gateway cannot make. */}
                      {event.cost_source === "unresolved" ? (
                        <span
                          className="text-amber-600 dark:text-amber-400"
                          title="The provider answered successfully but reported no usage this gateway could read, so this request consumed no budget."
                        >
                          unresolved
                        </span>
                      ) : (
                        <span
                          // A reported cost is what the provider charged, not
                          // what this deployment's catalog estimates — worth
                          // saying, because the two can differ.
                          title={
                            event.cost_source === "reported"
                              ? "Cost reported by the provider for this request."
                              : undefined
                          }
                        >
                          {formatCost(event.cost_usd)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right text-xs">
                      {event.latency_ms === null ? "—" : `${formatNumber(event.latency_ms)} ms`}
                    </TableCell>
                    <TableCell>
                      <EventStatusBadge status={event.status} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={cursors.length === 0}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!events.data?.next_before_id}
              onClick={() =>
                setCursors((current) => [...current, events.data!.next_before_id as number])
              }
            >
              Older
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
