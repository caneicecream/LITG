"use client";

import { STATUS_LABEL, type PriceStatus } from "@/domain/provenance";

const STATUS_HELP: Record<PriceStatus, string> = {
  verified: "Obtained from a reliable source with evidence it applies to this configuration.",
  manual: "Entered by you from a real quote or booking page.",
  estimated: "Calculated from a documented estimate or assumption.",
  illustrative: "Demo data used to show how the optimizer works. Not a real price or offer.",
  unavailable: "This price could not be established.",
  stale: "A real observation old enough that it should be re-checked.",
};

export function StatusChip({ status }: { status: PriceStatus }) {
  return (
    <span className={`chip chip-${status}`} title={STATUS_HELP[status]}>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusLegend() {
  return (
    <div className="legend">
      {(Object.keys(STATUS_HELP) as PriceStatus[]).map((s) => (
        <StatusChip key={s} status={s} />
      ))}
    </div>
  );
}

export { STATUS_HELP };

/** Dollar input bound to an integer-cents value. Empty input maps to `undefined` when `optional`. */
export function MoneyInput({
  value,
  onChange,
  optional,
  step = 1,
  placeholder,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (cents: number | undefined) => void;
  optional?: boolean;
  step?: number;
  placeholder?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="money">
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        aria-label={ariaLabel}
        placeholder={placeholder ?? (optional ? "none" : "0")}
        value={value === undefined ? "" : value / 100}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(optional ? undefined : 0);
          else {
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * 100));
          }
        }}
      />
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  ariaLabel,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  max?: number;
  ariaLabel?: string;
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      aria-label={ariaLabel}
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") onChange(undefined);
        else if (Number.isFinite(Number(raw))) onChange(Math.trunc(Number(raw)));
      }}
    />
  );
}
