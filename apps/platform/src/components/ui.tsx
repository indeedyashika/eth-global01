"use client";

import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-neutral-300 bg-white text-black p-4 sm:p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-black font-mono">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 font-mono">{hint}</span>}
    </label>
  );
}

const inputClass =
  "rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-black font-mono focus:outline-none focus:border-black disabled:cursor-not-allowed disabled:opacity-50";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Checkbox({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 rounded-lg border border-neutral-300 bg-white p-3 cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed" : "hover:border-black"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-black"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-black font-mono">{label}</span>
        {description && <span className="text-xs text-neutral-500 font-mono">{description}</span>}
      </span>
    </label>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const variants: Record<string, string> = {
    primary: "bg-black text-white hover:bg-neutral-800 border border-black font-semibold cursor-pointer",
    secondary: "border border-neutral-300 bg-white text-black hover:bg-neutral-100 font-semibold cursor-pointer",
    danger: "border border-black bg-black text-white hover:bg-neutral-800 font-semibold cursor-pointer",
    ghost: "text-neutral-600 hover:text-black hover:bg-neutral-100 cursor-pointer",
  };
  return (
    <button
      {...props}
      className={`rounded-lg px-3 py-2 text-sm font-mono transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "violet" | "amber" | "red" | "emerald" }) {
  const tones: Record<string, string> = {
    zinc: "bg-neutral-100 text-black border border-neutral-300",
    violet: "bg-neutral-100 text-black border border-neutral-300 font-medium",
    amber: "bg-neutral-100 text-black border border-neutral-300",
    red: "bg-neutral-200 text-black border border-neutral-400 font-bold",
    emerald: "bg-neutral-100 text-black border border-neutral-300 font-medium",
  };
  return <span className={`text-[10px] uppercase font-mono tracking-wide rounded px-2 py-0.5 ${tones[tone]}`}>{children}</span>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="text-sm text-black font-mono border-l-2 border-black pl-2 bg-neutral-50 py-1">{children}</p>;
}
