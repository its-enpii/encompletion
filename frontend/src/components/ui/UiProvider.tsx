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

type UiContextValue = {
  toast: (message: string, kind?: ToastKind) => void;
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
    () => ({ toast, confirm, prompt }),
    [toast, confirm, prompt]
  );

  return (
    <UiContext.Provider value={value}>
      {children}

      <ToastViewport toasts={toasts} onDismiss={dismissToast} />

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
