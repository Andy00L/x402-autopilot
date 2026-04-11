/**
 * Top bar of the dashboard.
 *
 * Contents
 * --------
 *   - Title + testnet badge
 *   - Wallet input (add a G... address to track)
 *   - Extra-wallet chips with keyboard-accessible remove buttons
 *   - LIVE indicator reflecting the actual EventSource readyState
 *
 * LIVE indicator colours
 *   green + pulsing "LIVE"         every stream is open
 *   amber "Reconnecting…"          at least one stream is establishing
 *   red "OFFLINE"                  every stream is closed (or none to track)
 */
import { useEffect, useRef, useState } from "react";
import {
  useDashboardStore,
  validateStellarAddress,
} from "@/stores/dashboard-store";
import type { ConnectionStatus } from "@/stores/horizon-payment-store";
import { nodePositionsStore } from "@/stores/node-positions-store";
import { useNodePositions } from "@/hooks/use-node-positions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface HeaderProps {
  connectionStatus: ConnectionStatus;
}

type InputFeedback =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "warning"; message: string };

const FEEDBACK_CLEAR_MS = 3_000;

export function Header({ connectionStatus }: HeaderProps) {
  const [value, setValue] = useState("");
  const [feedback, setFeedback] = useState<InputFeedback>({ kind: "none" });
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addWallet = useDashboardStore((s) => s.addWallet);
  const wallets = useDashboardStore((s) => s.wallets);
  const removeWallet = useDashboardStore((s) => s.removeWallet);
  const savedPositions = useNodePositions();
  const hasCustomLayout = Object.keys(savedPositions).length > 0;

  // Clean up any outstanding auto-clear timer if the component unmounts
  // mid-countdown. Not stricly necessary for a top-level component but
  // keeps the ref lifecycle honest.
  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current);
      }
    };
  }, []);

  function showFeedback(next: InputFeedback): void {
    setFeedback(next);
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    if (next.kind !== "none") {
      feedbackTimerRef.current = setTimeout(() => {
        setFeedback({ kind: "none" });
        feedbackTimerRef.current = null;
      }, FEEDBACK_CLEAR_MS);
    }
  }

  function submit(ev: React.FormEvent): void {
    ev.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    const v = validateStellarAddress(trimmed);
    if (!v.ok) {
      showFeedback({
        kind: "error",
        message: v.reason
          ? `Invalid Stellar address · ${v.reason}`
          : "Invalid Stellar address",
      });
      return;
    }
    const result = addWallet(trimmed);
    if (!result.ok) {
      // "already tracked" is a soft warning — the user asked for something
      // that's already visible, not something broken. Everything else is
      // treated as an error.
      if (result.reason === "already tracked") {
        showFeedback({
          kind: "warning",
          message: "This wallet is already tracked",
        });
      } else {
        showFeedback({
          kind: "error",
          message: result.reason ?? "Failed to add wallet",
        });
      }
      return;
    }
    showFeedback({ kind: "none" });
    setValue("");
  }

  const statusDotClass =
    connectionStatus === "open"
      ? "bg-emerald-500 streaming-dot"
      : connectionStatus === "connecting"
      ? "bg-amber-500 streaming-dot"
      : "bg-rose-500";

  const statusLabel =
    connectionStatus === "open"
      ? "LIVE"
      : connectionStatus === "connecting"
      ? "Reconnecting…"
      : "OFFLINE";

  const inputBorderClass =
    feedback.kind === "error"
      ? "border-rose-400"
      : feedback.kind === "warning"
      ? "border-amber-400"
      : "border-slate-200";

  return (
    <header className="flex h-[40px] flex-shrink-0 items-center gap-2.5 border-b border-slate-200 bg-white px-4">
      <div className="text-[14px] font-semibold tracking-tight text-slate-900">
        x402 autopilot
      </div>
      <div className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
        testnet
      </div>

      <div className="ml-auto flex items-center gap-2">
        {hasCustomLayout ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => nodePositionsStore.reset()}
            title="Reset node positions to their default layout"
          >
            Reset layout
          </Button>
        ) : null}

        {wallets.length > 2 ? (
          <div className="hidden gap-1 md:flex">
            {wallets.slice(2).map((w) => (
              <Button
                key={w.address}
                variant="ghost"
                size="sm"
                onClick={() => removeWallet(w.address)}
                title={`${w.label} · click to remove`}
                aria-label={`Remove wallet ${w.label}`}
                className="num gap-1 font-mono text-[9px] hover:text-rose-500"
              >
                {w.label}
                <span aria-hidden="true" className="text-[10px]">
                  ×
                </span>
              </Button>
            ))}
          </div>
        ) : null}

        <form onSubmit={submit} className="relative flex items-center">
          <label htmlFor="add-wallet" className="sr-only">
            Add Stellar wallet address
          </label>
          <Input
            id="add-wallet"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (feedback.kind !== "none") {
                showFeedback({ kind: "none" });
              }
            }}
            placeholder="+ add wallet G..."
            autoComplete="off"
            spellCheck={false}
            aria-invalid={feedback.kind === "error"}
            aria-describedby={
              feedback.kind === "none" ? undefined : "add-wallet-feedback"
            }
            className={`num w-[210px] font-mono ${inputBorderClass}`}
          />
          {feedback.kind !== "none" ? (
            <Badge
              id="add-wallet-feedback"
              role="status"
              variant={feedback.kind === "warning" ? "warning" : "destructive"}
              className="absolute left-0 top-full mt-1 whitespace-nowrap shadow-sm"
            >
              {feedback.message}
            </Badge>
          ) : null}
        </form>

        <Badge
          variant={
            connectionStatus === "open"
              ? "success"
              : connectionStatus === "connecting"
              ? "warning"
              : "destructive"
          }
          role="status"
          aria-live="polite"
          className="gap-1"
        >
          <span
            className={`h-[6px] w-[6px] rounded-full ${statusDotClass}`}
            aria-hidden="true"
          />
          {statusLabel}
        </Badge>
      </div>
    </header>
  );
}
