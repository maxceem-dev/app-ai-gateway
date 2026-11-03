import { useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { SUPPORT_TOPICS, type SupportMessageKind } from "@contracts/schemas";
import { Field } from "@/components/field";
import { FormDialog } from "@/components/form-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { entitledPlan } from "@/lib/billing";
import { useConsoleSession } from "@/lib/console-session";
import { useSendSupportMessage } from "@/lib/queries";

/** What each Support menu item opens: its own heading, prompt and examples. */
export const SUPPORT_KINDS: Record<
  SupportMessageKind,
  {
    menuLabel: string;
    title: string;
    lead: string;
    /** Under the sender's address: what happens with it. */
    replyHint: string;
    message: string;
    submit: string;
  }
> = {
  bug: {
    menuLabel: "Report a Bug",
    title: "Report a bug",
    lead: "Tell us what happened and what you expected instead.",
    replyHint: "We'll reply to this address.",
    message: "Steps to reproduce, what you expected, and what happened instead. An app or request id helps.",
    submit: "Send report",
  },
  support: {
    menuLabel: "Contact Support",
    title: "Contact support",
    lead: "Ask anything about your account, apps or providers.",
    replyHint: "We'll reply to this address.",
    message: "How can we help?",
    submit: "Send message",
  },
  feedback: {
    menuLabel: "Send Feedback",
    title: "Send feedback",
    lead: "Ideas, missing features, or anything that could work better.",
    replyHint: "If your feedback needs a reply, we'll send it to this address.",
    message: "What would make the gateway better for you?",
    submit: "Send feedback",
  },
};

/** The message field's id, so the menu that opens the dialog can focus it. */
export const SUPPORT_MESSAGE_ID = "support-message";

/**
 * Whether the Support menu is offered: the deployment names a support inbox,
 * and the organization holds a plan that is not the free default, or billing
 * cannot be reached just now, when the gateway still accepts a message. The
 * gateway refuses everyone else the same way, so this only keeps the menu
 * from offering what would be refused.
 */
export function useSupportAvailable(): boolean {
  const { capabilities, billing } = useConsoleSession();
  if (!capabilities.supportEmail) return false;
  if (billing?.state === "unavailable") return true;
  const plan = entitledPlan(billing);
  return plan !== null && !plan.isDefault;
}

/**
 * The same message as an email the person sends themselves: the topic as its
 * subject, and whatever they have typed so far as its body, so switching to
 * their mail app part-way through loses nothing.
 */
function mailtoHref(inbox: string, topic: string, message: string): string {
  const query = new URLSearchParams({ subject: topic });
  if (message.trim()) query.set("body", message.trim());
  // Mail clients read `+` literally, so spaces have to be `%20`.
  return `mailto:${inbox}?${query.toString().replaceAll("+", "%20")}`;
}

/**
 * A message to support, written without leaving the console.
 *
 * The person gets an email with its reference and their message, copied to
 * the support inbox, so the answer comes back to them by email and the
 * conversation carries on there. The page it was written from goes with it.
 */
export function SupportDialog({
  kind,
  onOpenChange,
}: {
  kind: SupportMessageKind | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, capabilities } = useConsoleSession();
  const location = useLocation();
  const send = useSendSupportMessage();
  const [message, setMessage] = useState("");
  // Kept while the dialog animates closed, so its text does not change under it.
  const [shown, setShown] = useState<SupportMessageKind>(kind ?? "support");
  if (kind !== null && kind !== shown) setShown(kind);
  const copy = SUPPORT_KINDS[shown];
  const email = session.user?.email;

  const submit = async () => {
    try {
      const result = await send.mutateAsync({
        kind: shown,
        message: message.trim(),
        page: location.pathname,
      });
      toast.success(`Message sent (${result.reference})`, { description: "We'll reply to your email." });
      setMessage("");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send your message");
    }
  };

  return (
    <FormDialog
      open={kind !== null}
      onOpenChange={onOpenChange}
      title={copy.title}
      description={copy.lead}
      submitLabel={copy.submit}
      pending={send.isPending}
      disabled={!message.trim()}
      onSubmit={() => void submit()}
      anyRole
      className="sm:max-w-2xl"
    >
      {email ? (
        // Shown as a field, not editable: replies go to the sign-in's own
        // address, which is the one the ticket is opened for. Out of the tab
        // order, so the dialog opens with the message focused instead.
        <Field label="From" htmlFor="support-from" hint={copy.replyHint}>
          <Input
            id="support-from"
            value={email}
            readOnly
            tabIndex={-1}
            className="bg-muted/50 text-muted-foreground"
          />
        </Field>
      ) : null}
      <Field
        label="Message"
        htmlFor={SUPPORT_MESSAGE_ID}
        hint={
          capabilities.supportEmail ? (
            <>
              Prefer your own mail app? Write to{" "}
              <a
                href={mailtoHref(capabilities.supportEmail, SUPPORT_TOPICS[shown], message)}
                className="underline underline-offset-4 hover:text-foreground"
              >
                {capabilities.supportEmail}
              </a>
              .
            </>
          ) : undefined
        }
      >
        <Textarea
          id={SUPPORT_MESSAGE_ID}
          value={message}
          placeholder={copy.message}
          maxLength={10_000}
          autoFocus
          disabled={send.isPending}
          className="min-h-64 resize-y"
          onChange={(event) => setMessage(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
