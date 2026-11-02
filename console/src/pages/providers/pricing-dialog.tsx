import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/field";
import { GuardedButton } from "@/components/guarded-button";
import { API_STYLE_LABELS } from "@/lib/capabilities";
import { providerLabel, reportsCost } from "@/lib/config-types";
import { draftsToPricing, toDrafts, type PricingDraft } from "@/lib/pricing-draft";
import { useUpdateProvider } from "@/lib/queries";
import type { ProviderCredential } from "@/lib/types";
import { errorMessage } from "./shared";

/**
 * What a price on this provider is for. A provider that reports its own cost
 * needs none on the APIs it reports for, and a price there is only the fallback
 * for a response that arrives without one; every other API still needs one.
 */
export function pricingNote(
  provider: Pick<ProviderCredential, "type" | "route" | "capability">,
): string {
  const styles = provider.capability.apiStyles;
  const reported = styles.filter((style) => reportsCost(provider.type, provider.route, style));
  if (reported.length === 0) {
    return "Requests for unpriced models are rejected until a price is set here.";
  }
  const label = providerLabel(provider.type);
  const fallback = "a price entered here is only used if a response ever comes back without one";
  if (reported.length === styles.length) {
    return `${label} reports the cost of every request, so its models proxy with no price here; ${fallback}.`;
  }
  // `other` has no label of its own: it is every provider operation no shared
  // API names, such as image generation.
  const names = reported.map((style) => (Object.hasOwn(API_STYLE_LABELS, style)
    ? API_STYLE_LABELS[style as keyof typeof API_STYLE_LABELS]
    : "provider-native"));
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(names);
  return `${label} reports the cost of each ${list} request, so models used that way proxy with no price here; ${fallback}. Its other APIs still need a price.`;
}

/**
 * Pricing is ordinary non-secret data, so it is shown and edited normally —
 * none of the write-only handling the credential needs applies here.
 */
export function PricingDialog({
  provider,
  onClose,
  readOnly,
}: {
  provider: ProviderCredential | null;
  onClose: () => void;
  readOnly: boolean;
}) {
  const updateProvider = useUpdateProvider();
  const [drafts, setDrafts] = useState<PricingDraft[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (provider && loadedFor !== provider.id) {
    setLoadedFor(provider.id);
    setDrafts(toDrafts(provider.pricing));
  }

  const setRow = (index: number, patch: Partial<PricingDraft>) => {
    setDrafts((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = async () => {
    if (!provider) return;
    const result = draftsToPricing(drafts);
    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    try {
      await updateProvider.mutateAsync({
        id: provider.id,
        body: { pricing: Object.keys(result.pricing).length ? result.pricing : null, revision: provider.revision },
      });
      toast.success(`Updated pricing for ${provider.name}`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not save the pricing"));
    }
  };

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) {
          setLoadedFor(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Custom model pricing</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <DialogDescription>
            For models the built-in catalog does not cover, or prices it in a way you disagree with.
            {provider ? ` ${pricingNote(provider)}` : null}{" "}
            Enter $0 for a model that is genuinely free. A cache price left blank bills at the
            input price.
          </DialogDescription>
          {drafts.length === 0 ? (
            <EmptyState>No custom prices for this provider.</EmptyState>
          ) : (
            <>
              {/* One header row instead of a label per input: the rows repeat, so
                  the columns are named once and each field carries its own
                  accessible name. */}
              <div
                aria-hidden
                className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] gap-2 text-xs text-muted-foreground"
              >
                <span>Model</span>
                <span>Input $/1M</span>
                <span>Output $/1M</span>
                <span>Cached $/1M</span>
                <span>Cache write $/1M</span>
                <span className="w-9" />
              </div>
              {drafts.map((row, index) => (
                <div key={index} className="grid grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] items-center gap-2">
                  <Input
                    aria-label={`Model ${index + 1}`}
                    value={row.model}
                    placeholder="gpt-brand-new"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { model: event.target.value })}
                  />
                  <Input
                    aria-label={`Input price ${index + 1}`}
                    inputMode="decimal"
                    value={row.input}
                    placeholder="1.25"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { input: event.target.value })}
                  />
                  <Input
                    aria-label={`Output price ${index + 1}`}
                    inputMode="decimal"
                    value={row.output}
                    placeholder="10"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { output: event.target.value })}
                  />
                  <Input
                    aria-label={`Cached input price ${index + 1}`}
                    inputMode="decimal"
                    value={row.cachedInput ?? ""}
                    placeholder="= input"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { cachedInput: event.target.value })}
                  />
                  <Input
                    aria-label={`Cache write price ${index + 1}`}
                    inputMode="decimal"
                    value={row.cacheWrite ?? ""}
                    placeholder="= input"
                    disabled={readOnly}
                    onChange={(event) => setRow(index, { cacheWrite: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove pricing row ${index + 1}`}
                    disabled={readOnly}
                    onClick={() =>
                      setDrafts((current) => current.filter((_row, position) => position !== index))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            onClick={() => setDrafts((current) => [...current, { model: "", input: "", output: "", cachedInput: "", cacheWrite: "" }])}
          >
            <Plus className="size-4" />
            Add model
          </Button>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GuardedButton disabled={updateProvider.isPending} onClick={() => void submit()}>
            {updateProvider.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Save pricing
          </GuardedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
