/**
 * Badge primitive — vendored shadcn/ui pattern.
 *
 * Variants
 *   default     — solid primary colour, used for emphatic status chips.
 *   secondary   — muted surface colour, used for neutral metadata.
 *   outline     — transparent background with border, used for counts.
 *   destructive — red, used for warnings / denied rows.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-1.5 py-[2px] text-[9px] font-medium tracking-wide transition-colors focus:outline-none focus:ring-1 focus:ring-blue-500",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-blue-100 text-blue-700",
        secondary:
          "border-transparent bg-slate-100 text-slate-600",
        outline:
          "border-slate-200 text-slate-500",
        destructive:
          "border-transparent bg-rose-100 text-rose-600",
        success:
          "border-transparent bg-emerald-100 text-emerald-700",
        warning:
          "border-transparent bg-amber-100 text-amber-700",
        info:
          "border-transparent bg-blue-100 text-blue-700",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { badgeVariants };
