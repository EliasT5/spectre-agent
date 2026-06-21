
/** A void→orb mark sized to `size`px. `safe` insets the orb into the maskable safe zone. */
export function spectreMark({ size, safe = false }: { size: number; safe?: boolean }) {
  const orb = Math.round(size * (safe ? 0.56 : 0.68));
  const glow = Math.round(size * 0.11);
  const spread = Math.round(size * 0.035);
  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(circle at 50% 36%, #15152b 0%, #08080f 58%, #050507 100%)",
      }}
    >
      <div
        style={{
          width: orb,
          height: orb,
          display: "flex",
          borderRadius: orb,
          background:
            "radial-gradient(circle at 38% 30%, #c7d2fe 0%, #818cf8 30%, #6366f1 56%, #4f46e5 80%, #3730a3 100%)",
          boxShadow: `0 0 ${glow}px ${spread}px rgba(99,102,241,0.55)`,
        }}
      />
    </div>
  );
}
