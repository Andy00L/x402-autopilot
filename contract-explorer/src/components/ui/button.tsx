/**
 * Button primitive — vendored shadcn/ui pattern with variants the
 * dashboard actually uses (default, ghost, outline, secondary).
 */
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Per emil-design-eng: every pressable element scales slightly on
// :active so the UI feels like it heard the click. The custom
// cubic-bezier is the strong ease-out from the skill's reference
// (avoids the weak built-in `ease-out`). Properties listed
// explicitly so we never animate layout (per Emil + Impeccable).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[11px] font-medium transition-[color,background-color,border-color,transform,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-blue-600 text-white hover:bg-blue-700",
        secondary:
          "bg-slate-100 text-slate-700 hover:bg-slate-200",
        outline:
          "border border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-700",
        ghost:
          "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
        destructive:
          "bg-rose-500 text-white hover:bg-rose-600",
      },
      size: {
        default: "h-7 px-3",
        sm: "h-6 px-2 text-[10px]",
        icon: "h-7 w-7",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render the children as the click target instead of a <button>. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
