/** A full-bleed hairline that separates page bands, with an optional label. */
export function Rule({ label }: { label?: string }) {
  if (!label) return <hr className="wh-rule border-t" />;
  return (
    <div className="flex items-center gap-4">
      <hr className="wh-rule w-8 border-t" />
      <span className="wh-mono-label">{label}</span>
      <hr className="wh-rule flex-1 border-t" />
    </div>
  );
}
