import { useMemo } from "react";
import type { ClipMetadata } from "../lib/types";
import { formatBytes, formatDuration } from "../lib/format";

interface Props {
  clips: ClipMetadata[];
}

function StatBox({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-[#232934] bg-[#14171e] px-3.5 py-3">
      <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-[#7e8b9d]">{label}</div>
      <div className="mt-1 font-mono text-[17px] font-semibold text-[#e6eaf0]">{value}</div>
      {sub && <div className="mt-1 text-[11px] text-[#717d8e]">{sub}</div>}
    </div>
  );
}

export default function StatsPanel({ clips }: Props) {
  const now = Date.now();
  const weekAgo = now - 7 * 86_400_000;

  const stats = useMemo(() => {
    const totalBytes = clips.reduce((a, c) => a + c.size_bytes, 0);
    const totalSeconds = clips.reduce((a, c) => a + c.duration_seconds, 0);
    const thisWeek = clips.filter((c) => c.created_unix_ms >= weekAgo);
    const thisWeekBytes = thisWeek.reduce((a, c) => a + c.size_bytes, 0);

    const byGame = new Map<string, { clips: number; bytes: number }>();
    for (const c of clips) {
      const key = c.game ?? "General";
      const e = byGame.get(key) ?? { clips: 0, bytes: 0 };
      e.clips += 1;
      e.bytes += c.size_bytes;
      byGame.set(key, e);
    }
    const rows = [...byGame.entries()]
      .map(([game, v]) => ({ game, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
    const maxBytes = Math.max(...rows.map((r) => r.bytes), 1);

    return { totalBytes, totalSeconds, thisWeek: thisWeek.length, thisWeekBytes, rows, maxBytes };
  }, [clips, weekAgo]);

  return (
    <section className="panel rounded-xl p-4">
      <h3 className="font-mono text-[11px] font-semibold tracking-wider text-[#9aa5b5]">
        CLIP STATISTICS
      </h3>

      <div className="mt-3.5 grid grid-cols-2 gap-2.5">
        <StatBox
          label="TOTAL CLIPS"
          value={String(clips.length)}
          sub={formatDuration(stats.totalSeconds)}
        />
        <StatBox
          label="STORAGE USED"
          value={formatBytes(stats.totalBytes)}
          sub="output directory"
        />
        <StatBox
          label="THIS WEEK"
          value={String(stats.thisWeek)}
          sub={formatBytes(stats.thisWeekBytes)}
        />
        <StatBox
          label="GAMES TAGGED"
          value={String(stats.rows.filter((r) => r.game !== "General").length)}
          sub="per-game subfolders"
        />
      </div>

      <div className="mt-4 border-t border-[#232934] pt-3.5">
        <div className="font-mono text-[10px] font-medium uppercase tracking-wider text-[#7e8b9d]">
          STORAGE BY GAME
        </div>
        {stats.rows.length === 0 ? (
          <p className="mt-2 text-[12px] text-[#717d8e]">
            No clips recorded yet. Storage breakdown appears after saving your first clip.
          </p>
        ) : (
          <ul className="mt-2.5 space-y-2.5">
            {stats.rows.map((r) => (
              <li key={r.game}>
                <div className="flex items-center justify-between font-mono text-[11px]">
                  <span className="truncate font-medium text-[#d4dae3]">
                    {r.game.toUpperCase()}
                  </span>
                  <span className="shrink-0 text-[#7e8b9d]">
                    {r.clips} clip{r.clips === 1 ? "" : "s"} · {formatBytes(r.bytes)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#11141a]">
                  <div
                    className="h-full rounded-full bg-blue-500"
                    style={{ width: `${(r.bytes / stats.maxBytes) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-[#687383]">
        Clips saved with game organization active are saved into Videos/ClipFlow/&lt;game&gt;/ folders.
      </p>
    </section>
  );
}
