"use client";

/**
 * Per-thread model + reasoning-effort picker, matching the Chats tab's dropdown
 * (reuses the global `.model-dd*` / `.chat-effort*` styles). Self-contained: it
 * loads the model list, reflects the bound thread's `model_hint`/`reasoning_effort`,
 * and PATCHes the thread on select. On a not-yet-created chat it mints the thread
 * via `onEnsureThread` first (same as the Chats tab's selectModel).
 */

import { useEffect, useRef, useState } from "react";
import { Layers, ChevronDown, Check } from "lucide-react";

type ModelOption = {
  id: string;
  label: string;
  available?: boolean;
  unavailableReason?: string;
  reasoning?: boolean;
  effortLevels?: string[];
};

const AUTO_MODEL: ModelOption = { id: "", label: "Auto · default route" };

export function ModelPicker({
  threadId,
  onEnsureThread,
}: {
  threadId: string | null;
  onEnsureThread: () => Promise<string | null>;
}) {
  const [models, setModels] = useState<ModelOption[]>([AUTO_MODEL]);
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("");
  const ddRef = useRef<HTMLDivElement>(null);

  // Available models for the per-thread route override (from enriched /api/models).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/models");
        if (!r.ok) return;
        const d = await r.json();
        const raw: Array<{
          id: string;
          displayName?: string;
          available?: boolean;
          unavailableReason?: string;
          reasoning?: boolean;
          effortLevels?: string[];
        }> = Array.isArray(d?.models) ? d.models : [];
        const options: ModelOption[] = raw
          .filter((m) => m && typeof m.id === "string")
          .map((m) => ({
            id: m.id,
            label: m.displayName ?? m.id,
            available: m.available,
            unavailableReason: m.unavailableReason,
            reasoning: m.reasoning,
            effortLevels: m.effortLevels,
          }));
        if (!cancelled && options.length) setModels([AUTO_MODEL, ...options]);
      } catch {
        /* keep just Auto */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Reflect the bound thread's current model + effort.
  useEffect(() => {
    let cancelled = false;
    if (!threadId) {
      setModelId("");
      setEffort("");
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/threads/${threadId}`);
        if (!r.ok) return;
        const t = await r.json();
        if (!cancelled) {
          setModelId(t?.model_hint ?? "");
          setEffort(t?.reasoning_effort ?? "");
        }
      } catch {
        /* leave as-is */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = models.find((m) => m.id === modelId) ?? AUTO_MODEL;
  const showEffort =
    current.reasoning === true && Array.isArray(current.effortLevels) && current.effortLevels.length > 0;

  async function selectModel(id: string) {
    setOpen(false);
    setModelId(id);
    const tid = threadId ?? (await onEnsureThread());
    if (!tid) return;
    await fetch(`/api/threads/${tid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_hint: id || null }),
    }).catch(() => {});
  }

  async function selectEffort(level: string) {
    setEffort(level);
    const tid = threadId ?? (await onEnsureThread());
    if (!tid) return;
    await fetch(`/api/threads/${tid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning_effort: level || null }),
    }).catch(() => {});
  }

  return (
    <div className="wschat-model">
      <div className="model-dd" ref={ddRef}>
        <button
          className="model-dd-btn"
          onClick={() => setOpen((o) => !o)}
          title="Model for this chat"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Layers size={13} strokeWidth={1.7} />
          <span className="model-dd-label">{current.label}</span>
          <ChevronDown size={13} strokeWidth={1.7} style={{ opacity: 0.7 }} />
        </button>
        {open && (
          <div className="model-dd-menu" role="listbox">
            {models
              .filter((m) => m.available !== false || m.id === modelId)
              .filter((m) => !/embed/i.test(m.id) && !/embed/i.test(m.label))
              .filter((m) => m.id !== "spectre-default")
              .map((m) => {
                const sel = m.id === modelId;
                const unavailable = m.available === false;
                return (
                  <button
                    key={m.id || "__auto"}
                    className={`model-dd-item${sel ? " sel" : ""}${unavailable ? " model-dd-item-unavail" : ""}`}
                    onClick={unavailable ? undefined : () => selectModel(m.id)}
                    disabled={unavailable}
                    role="option"
                    aria-selected={sel}
                    aria-disabled={unavailable}
                    title={unavailable ? (m.unavailableReason ?? "Unavailable") : undefined}
                  >
                    <Check size={15} strokeWidth={2.2} className={`model-dd-check${sel ? "" : " off"}`} />
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {m.label}
                    </span>
                    {unavailable && <span className="model-dd-unavail-badge">unavail</span>}
                  </button>
                );
              })}
          </div>
        )}
      </div>
      {showEffort && (
        <div className="chat-effort-row">
          <button
            type="button"
            className={`chat-effort-pill${effort === "" ? " active" : ""}`}
            onClick={() => selectEffort("")}
            title="Model default effort"
          >
            auto
          </button>
          {current.effortLevels!.map((level) => (
            <button
              key={level}
              type="button"
              className={`chat-effort-pill${effort === level ? " active" : ""}`}
              onClick={() => selectEffort(level)}
              title={`Reasoning effort: ${level}`}
            >
              {level}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
