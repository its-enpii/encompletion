"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { CenteredDialog } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { ToastViewport, type ToastItem } from "@/components/ui/ToastViewport";

type ToastKind = "info" | "success" | "error";

type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type PromptOptions = {
  title?: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | undefined;
};

type PersistentErrorOptions = {
  message: string;
  // Optional detail line — full error text or stack that didn't fit
  // the headline. Shown in a smaller, dimmer line below the message.
  detail?: string;
  // Optional action label rendered as a button on the right of the
  // banner. Returned via the onAction callback so callers can wire
  // retry, navigate, etc.
  actionLabel?: string;
  onAction?: () => void;
};

type UiContextValue = {
  toast: (message: string, kind?: ToastKind) => void;
  // Show a sticky error banner that survives route changes (UiProvider
  // is mounted in the root layout, so the banner stays visible while
  // the user navigates between pages). Caller dismisses by id, or the
  // user clicks the × button. Multiple errors stack — newest at top.
  // Returns the id so the caller can dismiss it programmatically.
  showError: (opts: PersistentErrorOptions) => number;
  dismissError: (id: number) => void;
  clearErrors: () => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
};

const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi must be used inside <UiProvider>");
  return ctx;
}

export default function UiProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // Persistent error stack. Each entry renders as a sticky banner that
  // stays mounted through route changes (UiProvider lives in the root
  // layout). Newest error on top; dismiss removes a single entry;
  // clearErrors wipes the stack.
  const [errors, setErrors] = useState<{ id: number; opts: PersistentErrorOptions }[]>([]);
  const idRef = useRef(0);

  const [pendingConfirm, setPendingConfirm] = useState<ConfirmOptions | null>(null);
  const confirmResolver = useRef<((v: boolean) => void) | null>(null);

  const [pendingPrompt, setPendingPrompt] = useState<PromptOptions | null>(null);
  const [promptSeq, setPromptSeq] = useState(0);
  const promptResolver = useRef<((v: string | null) => void) | null>(null);

  const toast = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++idRef.current;
    setToasts((cur) => [...cur, { id, kind, message }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const showError = useCallback((opts: PersistentErrorOptions): number => {
    const id = ++idRef.current;
    setErrors((cur) => [{ id, opts }, ...cur]);
    return id;
  }, []);

  const dismissError = useCallback((id: number) => {
    setErrors((cur) => cur.filter((e) => e.id !== id));
  }, []);

  const clearErrors = useCallback(() => {
    setErrors([]);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      confirmResolver.current?.(false);
      confirmResolver.current = resolve;
      setPendingConfirm(opts);
    });
  }, []);

  function resolveConfirm(value: boolean) {
    confirmResolver.current?.(value);
    confirmResolver.current = null;
    setPendingConfirm(null);
  }

  const prompt = useCallback((opts: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      confirmResolver.current?.(false);
      promptResolver.current?.(null);
      promptResolver.current = resolve;
      setPromptSeq((s) => s + 1);
      setPendingPrompt(opts);
    });
  }, []);

  function resolvePrompt(value: string | null) {
    promptResolver.current?.(value);
    promptResolver.current = null;
    setPendingPrompt(null);
  }

  const value = useMemo<UiContextValue>(
    () => ({ toast, showError, dismissError, clearErrors, confirm, prompt }),
    [toast, showError, dismissError, clearErrors, confirm, prompt]
  );

  return (
    <UiContext.Provider value={value}>
      {children}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

      {errors.length > 0 && (
        <ErrorViewport errors={errors} onDismiss={dismissError} onClear={clearErrors} />
      )}

      <ConfirmShell
        opts={pendingConfirm}
        onConfirm={() => resolveConfirm(true)}
        onCancel={() => resolveConfirm(false)}
      />

      {pendingPrompt && (
        <PromptShell
          key={promptSeq}
          opts={pendingPrompt}
          onSubmit={(v) => resolvePrompt(v)}
          onCancel={() => resolvePrompt(null)}
        />
      )}
    </UiContext.Provider>
  );
}

function ConfirmShell({
  opts,
  onConfirm,
  onCancel,
}: {
  opts: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <CenteredDialog
      open={!!opts}
      onClose={onCancel}
      title={opts?.title || "Konfirmasi"}
      description={opts?.message}
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {opts?.cancelLabel || "Batal"}
          </Button>
          <Button variant={opts?.destructive ? "danger" : "primary"} onClick={onConfirm} autoFocus>
            {opts?.confirmLabel || "Lanjut"}
          </Button>
        </>
      }
    />
  );
}

function PromptShell({
  opts,
  onSubmit,
  onCancel,
}: {
  opts: PromptOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(opts.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    const trimmed = value.trim();
    const err = opts.validate?.(trimmed);
    if (err) {
      setError(err);
      return;
    }
    onSubmit(trimmed);
  }

  return (
    <CenteredDialog
      open
      onClose={onCancel}
      title={opts.title || "Input"}
      description={opts.message}
      widthClass="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {opts.cancelLabel || "Batal"}
          </Button>
          <Button variant="primary" onClick={submit}>
            {opts.confirmLabel || "Lanjut"}
          </Button>
        </>
      }
    >
      <TextField
        autoFocus
        value={value}
        placeholder={opts.placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        error={error || undefined}
      />
    </CenteredDialog>
  );
}

function ErrorViewport({
  errors,
  onDismiss,
  onClear,
}: {
  errors: { id: number; opts: PersistentErrorOptions }[];
  onDismiss: (id: number) => void;
  onClear: () => void;
}) {
  // Stack of error banners anchored bottom-center. Unlike toasts
  // (top-right, auto-dismiss), these persist until the user dismisses
  // each one — so a 504 / 502 from the LLM stays visible while the
  // user navigates between chats, projects, or admin pages.
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[220] flex flex-col items-center gap-2 px-4">
      {errors.length > 1 && (
        <button
          type="button"
          onClick={onClear}
          className="pointer-events-auto rounded-full border border-[var(--line)] bg-[var(--paper-3)]/95 px-3 py-1 text-[11px] font-medium text-[var(--ink-3)] shadow-[var(--shadow-2)] backdrop-blur transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
        >
          Tutup semua ({errors.length})
        </button>
      )}
      {errors.map((e) => (
        <div
          key={e.id}
          role="alert"
          className="pointer-events-auto flex w-full max-w-[640px] items-start gap-3 rounded-[var(--r-md)] border border-[#EFB5B5] bg-[var(--danger-50)]/95 px-4 py-3 text-sm text-[var(--danger)] shadow-[var(--shadow-3)] backdrop-blur"
        >
          <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--danger)] text-[11px] font-bold text-white" aria-hidden="true">
            !
          </span>
          <div className="min-w-0 flex-1">
            <div className="break-words font-medium leading-snug">{e.opts.message}</div>
            {e.opts.detail && (
              <div className="mt-0.5 break-words text-[12px] leading-snug text-[var(--danger)]/80">
                {e.opts.detail}
              </div>
            )}
          </div>
          {e.opts.actionLabel && e.opts.onAction && (
            <button
              type="button"
              onClick={() => {
                e.opts.onAction?.();
                onDismiss(e.id);
              }}
              className="shrink-0 rounded-[6px] border border-current/30 bg-white/40 px-2.5 py-1 text-[11px] font-semibold transition-colors hover:bg-white/70"
            >
              {e.opts.actionLabel}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(e.id)}
            aria-label="Dismiss error"
            className="shrink-0 grid h-6 w-6 place-items-center rounded-[6px] text-current/70 transition-colors hover:bg-white/40 hover:text-current"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
