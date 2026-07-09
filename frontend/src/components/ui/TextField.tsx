"use client";

import { forwardRef, useId } from "react";

type CommonProps = {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  /** Hide the visual label (still announced to screen readers). */
  hideLabel?: boolean;
};

type InputProps = CommonProps &
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> & {
    as?: "input";
  };

type TextareaProps = CommonProps &
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    as: "textarea";
  };

type SelectProps = CommonProps &
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    as: "select";
    children: React.ReactNode;
  };

type Props = InputProps | TextareaProps | SelectProps;

export const TextField = forwardRef<HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement, Props>(
  function TextField(props, ref) {
    const id = useId();
    const { label, hint, error, hideLabel = false, ...rest } = props as Props & { as?: "input" | "textarea" | "select" };
    const as = (rest as { as?: string }).as ?? "input";

    const labelledProps = label ? { "aria-labelledby": `${id}-label`, id } : {};

    const controlCls = `input ${error ? "border-[var(--danger)] focus:!border-[var(--danger)]" : ""}`;

    let control: React.ReactNode;
    if (as === "textarea") {
      const { as: _ignored, ...inputRest } = rest as TextareaProps & { as: "textarea" };
      control = <textarea ref={ref as React.Ref<HTMLTextAreaElement>} className={controlCls} {...labelledProps} {...inputRest} />;
    } else if (as === "select") {
      const { as: _ignored, children, ...inputRest } = rest as SelectProps & { as: "select" };
      control = (
        <select ref={ref as React.Ref<HTMLSelectElement>} className={controlCls} {...labelledProps} {...inputRest}>
          {children}
        </select>
      );
    } else {
      const { as: _ignored, ...inputRest } = rest as InputProps & { as?: "input" };
      control = <input ref={ref as React.Ref<HTMLInputElement>} className={controlCls} {...labelledProps} {...inputRest} />;
    }

    return (
      <div className="block">
        {label && (
          <label
            id={`${id}-label`}
            className={`label mb-1.5 block ${hideLabel ? "sr-only" : ""}`}
          >
            {label}
          </label>
        )}
        {control}
        {hint && !error && (
          <p className="mt-1.5 text-xs text-[var(--ink-3)]">{hint}</p>
        )}
        {error && (
          <p className="mt-1.5 text-xs text-[var(--danger)]">{error}</p>
        )}
      </div>
    );
  }
);
