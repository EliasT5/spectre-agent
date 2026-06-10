"use client";

import { useState } from "react";
import { Lock, ArrowRight } from "lucide-react";
import { Panel, StatusDot, Button } from "@/components/ui";

export default function PinPage() {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await fetch("/api/auth/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (r.ok) {
        window.location.href = "/";
      } else {
        setErr("Invalid PIN");
        setPin("");
      }
    } catch {
      setErr("Connection failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pin-wrap">
      <h1>SPECTRE</h1>

      <Panel
        hud
        label={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <StatusDot tone="warn" />
            LOCKED
          </span>
        }
        icon={<Lock size={18} strokeWidth={1.6} />}
        title="Secure Access"
        aside={
          <span className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--color-text-muted)" }}>
            PIN
          </span>
        }
        style={{ width: "min(340px, 88vw)" }}
      >
        <p
          style={{
            margin: "2px 0 16px",
            fontSize: 13,
            color: "var(--color-text-muted)",
            textAlign: "center",
          }}
        >
          Enter your PIN to continue
        </p>

        <form
          onSubmit={submit}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}
        >
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            aria-label="PIN"
            style={{ width: "100%" }}
          />

          <Button type="submit" disabled={busy || !pin}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {busy ? "Verifying…" : "Enter"}
              <ArrowRight size={15} strokeWidth={1.6} />
            </span>
          </Button>
        </form>

        <div
          className="mono"
          style={{
            minHeight: 16,
            marginTop: 12,
            fontSize: 12,
            textAlign: "center",
            color: "var(--color-error)",
            letterSpacing: "0.04em",
          }}
        >
          {err}
        </div>
      </Panel>
    </div>
  );
}
