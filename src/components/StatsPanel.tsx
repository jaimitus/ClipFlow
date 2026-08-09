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
  accent = "text-slate-100",
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/5 bg-black/25 px-3 py-2.5">
      <div className="font-mono text-[9px] tracking-[0.18em] text-slate-600">{label}</div>
      <div className={`mt-1 font-mono text-[15px] font-semibold ${accent}`}>{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-slate-500">{sub}</div>}
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
    <section className="panel rounded-2xl p-4">
      <h3 className="font-mono text-[11px] tracking-[0.24em] text-cyan-300">
        CLIP STATS
      </h3>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <StatBox
          label="TOTAL CLIPS"
          value={String(clips.length)}
          sub={formatDuration(stats.totalSeconds)}
        />
        <StatBox
          label="STORAGE USED"
          value={formatBytes(stats.totalBytes)}
          sub="in the output folder"
        />
        <StatBox
          label="THIS WEEK"
          value={String(stats.thisWeek)}
          sub={formatBytes(stats.thisWeekBytes)}
          accent="text-lime-300"
        />
        <StatBox
          label="GAMES TAGGED"
          value={String(stats.rows.filter((r) => r.game !== "General").length)}
          sub="clips organised by game"
          accent="text-fuchsia-300"
        />
      </div>

      <div className="mt-4 border-t border-white/5 pt-3">
        <div className="font-mono text-[10px] tracking-[0.2em] text-slate-500">
          BY GAME
        </div>
        {stats.rows.length === 0 ? (
          <p className="mt-2 text-[12px] text-slate-500">
            No clips yet — the stats populate after your first Alt+C.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {stats.rows.map((r) => (
              <li key={r.game}>
                <div className="flex items-center justify-between font-mono text-[10px]">
                  <span className="truncate uppercase tracking-[0.14em] text-slate-300">
                    {r.game}
                  </span>
                  <span className="shrink-0 text-slate-500">
                    {r.clips} clip{r.clips === 1 ? "" : "s"} · {formatBytes(r.bytes)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/40">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500"
                    style={{ width: `${(r.bytes / stats.maxBytes) * 100}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-[10px] leading-relaxed text-slate-600">
        Clips saved with per-game organisation on are tagged by their folder
        (Videos/ClipFlow/&lt;game&gt;/). Clips at the root count as General.
      </p>
    </section>
  );
}
