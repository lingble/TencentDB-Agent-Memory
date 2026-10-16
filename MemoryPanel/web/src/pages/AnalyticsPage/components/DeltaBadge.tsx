/**
 * DeltaBadge — period-over-period delta badge.
 *
 * Positive ↑ (success color) / negative ↓ (error color) / flat ≈ (secondary color).
 * Threshold 0.005: changes below this are treated as flat, so rounding residue from CH round(…,2) isn't rendered as a "change".
 */

const FLAT_THRESHOLD = 0.005;

export function DeltaBadge({
  value,
  unit,
}: {
  value: number | null | undefined;
  unit: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const up = value > FLAT_THRESHOLD;
  const down = value < -FLAT_THRESHOLD;
  const cls = up ? '_an-delta--up' : down ? '_an-delta--down' : '_an-delta--flat';
  const sign = up ? '↑' : down ? '↓' : '≈';
  const magnitude = up || down ? Math.abs(value).toFixed(2) : '0';

  return (
    <span className={`_an-delta ${cls}`}>
      {`${sign} ${magnitude}${unit}`}
    </span>
  );
}
