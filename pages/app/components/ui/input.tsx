import * as React from "react";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`h-9 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:ring-2 focus:ring-black/20 ${className}`}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export default Input;

