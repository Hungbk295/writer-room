#!/usr/bin/env python3
"""Tính chỉ số VPH / video thắng cho các query đã search qua Spy (đọc cache SQLite, read-only).

  analyze_queries.py <queries.txt> --lang en --region US --out result.json [--recent-days 45] [--top 8]

Định nghĩa (khớp SKILL.md):
  VPH        = view / giờ kể từ lúc đăng (VPH trọn đời)
  hot        = đăng ≤ 14 ngày và VPH ≥ 100      (hot7: ≤ 7 ngày)
  RW (thắng mới) = đăng ≤ 90 ngày và VPH ≥ 100
  OW (thắng cũ)  = đăng > 90 ngày và view ≥ 50.000
  weakRecent = đăng ≤ recent-days và view < 1.000  (dấu hiệu "đông mà ế")
Video thiếu ngày đăng (thường do rơi yt-dlp) bị bỏ khỏi chỉ số, đếm ở `missingDate`.
`nonMarket` = title/kênh có dấu hiệu thị trường khác (sửa regex NONMARKET cho từng market).
Output text in ra stdout; JSON đầy đủ (mọi video) ghi vào --out để leader kiểm lại số.
"""
import argparse, json, os, re, sqlite3, subprocess
from datetime import datetime, timezone

NONMARKET = re.compile(r'\b(UK|Canada|Canadian|India|Indian|Australia|Australian|British|NZ|Nigeria|Pakistan|'
                       r'Philippines|Kenya|South Africa|Hindi|Rs\.?|₹|£)\b|[ऀ-ॿ]', re.I)


def repo_root():
    try:
        return subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
    except Exception:
        return os.getcwd()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file'); ap.add_argument('--lang', required=True); ap.add_argument('--region', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--recent-days', type=int, default=45)
    ap.add_argument('--top', type=int, default=8)
    ap.add_argument('--db', default=os.path.join(repo_root(), 'writer-room-data/spy/spy.sqlite'))
    a = ap.parse_args()
    now = datetime.now(timezone.utc)
    db = sqlite3.connect(f'file:{a.db}?mode=ro', uri=True)
    out = []
    for q in [l.strip() for l in open(a.file) if l.strip() and not l.startswith('#')]:
        row = db.execute("select video_ids_json, provider_used, fetched_at from search_query_cache "
                         "where query_norm=? and language=? and region=? "
                         "order by provider_used='youtube_data_api' desc, fetched_at desc",
                         (q.lower(), a.lang.lower(), a.region.upper())).fetchone()
        if not row:
            row = db.execute("select video_ids_json, provider_used, fetched_at from search_query_cache "
                             "where query_norm=? order by fetched_at desc", (q.lower(),)).fetchone()
        if not row:
            print(f'MISSING (chưa search): {q}'); continue
        vids, missing = [], 0
        for vid in json.loads(row[0]):
            r = db.execute("select title, channel_title, view_count, duration_sec, published_at, published_at_known "
                           "from search_video_cache where source_video_id=?", (vid,)).fetchone()
            if not r or not r[4] or not r[5]:
                missing += 1; continue
            t, c, v, d, p, _ = r
            h = (now - datetime.fromisoformat(p.replace('Z', '+00:00'))).total_seconds() / 3600
            if h <= 0:
                continue
            vids.append(dict(id=vid, url=f'https://www.youtube.com/watch?v={vid}', title=t, channel=(c or '').strip(),
                             views=v, durationSec=d, publishedAt=p[:10], ageDays=round(h / 24, 1),
                             vph=round(v / h, 1), short=bool(d and d <= 60),
                             nonMarket=bool(NONMARKET.search(f'{t} {c}'))))
        V = [v for v in vids if not v['nonMarket']]
        hot7 = [v for v in V if v['ageDays'] <= 7 and v['vph'] >= 100]
        hot14 = [v for v in V if v['ageDays'] <= 14 and v['vph'] >= 100]
        rw = [v for v in V if v['ageDays'] <= 90 and v['vph'] >= 100]
        ow = [v for v in V if v['ageDays'] > 90 and v['views'] >= 50000]
        weak = [v for v in V if v['ageDays'] <= a.recent_days and v['views'] < 1000]
        rec = dict(query=q, provider=row[1], fetchedAt=row[2], n=len(vids), missingDate=missing,
                   hot7=len(hot7), hot7Channels=len({v['channel'] for v in hot7}), hot14=len(hot14),
                   recentWinners=len(rw), oldWinners=len(ow), oldWinnerChannels=len({v['channel'] for v in ow}),
                   weakRecent=len(weak), videos=vids)
        out.append(rec)
        print(f"\n### {q} [{row[1]}] n={len(vids)} missingDate={missing} | hot7={len(hot7)} ch={rec['hot7Channels']} "
              f"| hot14={len(hot14)} | RW90={len(rw)} | OW={len(ow)} ch={rec['oldWinnerChannels']} | weakRecent={len(weak)}")
        for v in sorted(rw, key=lambda v: -v['vph'])[:a.top]:
            print(f"  RW {v['id']} {v['views']:>9} {v['publishedAt']} {v['ageDays']:5.1f}d vph{v['vph']:7.0f} "
                  f"{'S' if v['short'] else 'L'} | {v['channel'][:22]} | {v['title'][:95]}")
        for v in sorted(ow, key=lambda v: -v['views'])[:max(3, a.top // 2)]:
            print(f"  OW {v['id']} {v['views']:>9} {v['publishedAt']} {'S' if v['short'] else 'L'} | "
                  f"{v['channel'][:22]} | {v['title'][:95]}")
    json.dump(out, open(a.out, 'w'), ensure_ascii=False, indent=1)
    print(f'\nJSON: {a.out}')


if __name__ == '__main__':
    main()
