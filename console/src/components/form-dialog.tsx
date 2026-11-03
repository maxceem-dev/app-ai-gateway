import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
import { GuardedButton } from "@/components/guarded-button";
import { useConsoleSession } from "@/lib/console-session";

/**
 * The shell every "create a thing" modal in the console shares: a titled
 * dialog whose body is a form, so Enter submits, and whose primary action is
 * guarded for read-only members and shows its own pending state.
 *
 * Creation stays in the modal from the first field to the last confirmation —
 * pages keep a single "New …" button rather than an inline form.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  pending,
  disabled,
  onSubmit,
  secondaryAction,
  anyRole,
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  pending?: boolean;
  disabled?: boolean;
  onSubmit: () => void;
  secondaryAction?: ReactNode;
  /**
   * For a form that changes nothing in the account — a message to support —
   * which a read-only member may send as well.
   */
  anyRole?: boolean;
  className?: string;
  children: ReactNode;
}) {
  // Enter submits the form, which would bypass the guarded button that is the
  // only visible control a read-only member sees disabled.
  const { readOnly } = useConsoleSession();
  const blocked = (readOnly && !anyRole) || disabled || pending;
  const Submit = anyRole ? Button : GuardedButton;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={className ?? "sm:max-w-md"}
        // Radix points the content at a description id it renders itself, and
        // warns when no description exists to match it. A title and labelled
        // fields are enough for some forms, so the pointer is dropped instead.
        {...(description ? {} : { "aria-describedby": undefined })}
      >
        <form
          // The form, not the content, is the column the regions lay out in:
          // it is the only child DialogContent has.
          className="flex min-h-0 flex-1 flex-col"
          // Credential fields sit in these forms, and a text input beside a
          // password reads to a browser as a sign-in it should autofill.
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked) return;
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-balance">{title}</DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {description ? (
              <DialogDescription className="text-pretty">{description}</DialogDescription>
            ) : null}
            {children}
          </DialogBody>

          <DialogFooter>
            {/* Anything the form offers besides finishing it — a dry run of the
                credential, say. It opens the footer row, so the caller can hold
                it away from Cancel, and it must never submit. */}
            {secondaryAction}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Submit type="submit" disabled={disabled || pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {submitLabel}
            </Submit>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
