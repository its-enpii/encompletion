"use client";

import { forwardRef } from "react";

type Variant = "default" | "primary" | "saffron" | "danger" | "ghost" | "onDark";
type Size = "sm" | "md" | "lg" | "icon";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const variantClass: Record<Variant, string> = {
  default: "btn",
  primary: "btn btn-primary",
  saffron: "btn btn-saffron",
  danger: "btn btn-danger",
  ghost: "btn btn-ghost",
  onDark: "btn btn-on-dark",
};

const sizeClass: Record<Size, string> = {
  sm: "btn-sm",
  md: "",
  lg: "btn-lg",
  icon: "btn-icon",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "default", size = "md", className = "", ...rest },
  ref
) {
  const cls = variantClass[variant] + (size !== "md" ? ` ${sizeClass[size]}` : "") + (className ? ` ${className}` : "");
  return <button ref={ref} className={cls} {...rest} />;
});
