/**
 * Input primitive — vendored shadcn/ui pattern. Premium light defaults:
 * slate-50 surface, slate-200 border, monospace-friendly sizing.
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-7 w-full rounded-md border border-slate-200 bg-slate-50 px-2 py-[3px] text-[11px] text-slate-700",
        // Explicit transition properties (no `all`); strong ease-out
        // so the focus ring snaps in fast instead of fading lazily.
        "transition-[border-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "placeholder:text-slate-400",
        "focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-[invalid=true]:border-rose-400",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Input.displayName = "Input";
