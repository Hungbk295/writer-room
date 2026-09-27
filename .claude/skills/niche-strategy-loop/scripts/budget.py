#!/usr/bin/env python3
"""Sổ trần của một run: số vòng có triển khai subagent (≤ 13) và số video duy nhất (≤ 1300).

  budget.py <run_dir> [--max-rounds 13] [--max-videos 1300] [--planned N]

Đếm:
  - rounds  = số thư mục round-<n>/ có file `dispatched` (leader tạo file này ngay khi gửi
    subagent của vòng đó).
  - videos  = video ID duy nhất trong mọi JSON của analyze_queries.py (key "videos") dưới
    run_dir, cộng mọi ID trong file videos-*.txt (một ID/dòng — dùng cho video lấy qua
    quét kênh, comment, transcript).
--planned N: số video ước tính vòng sắp tới sẽ thêm (≈ số query × limit + video kênh).
Exit code 0 = còn chỗ; 3 = vượt trần (không được dispatch vòng mới).
"""
import argparse, glob, json, os, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('run_dir'); ap.add_argument('--max-rounds', type=int, default=13)
    ap.add_argument('--max-videos', type=int, default=1300); ap.add_argument('--planned', type=int, default=0)
    a = ap.parse_args()
    rounds = [d for d in glob.glob(os.path.join(a.run_dir, 'round-*')) if os.path.exists(os.path.join(d, 'dispatched'))]
    ids = set()
    for f in glob.glob(os.path.join(a.run_dir, '**', '*.json'), recursive=True):
        try:
            data = json.load(open(f))
        except Exception:
            continue
        if isinstance(data, list):
            for rec in data:
                if isinstance(rec, dict):
                    for v in rec.get('videos', []) or []:
                        if isinstance(v, dict) and v.get('id'):
                            ids.add(v['id'])
    for f in glob.glob(os.path.join(a.run_dir, '**', 'videos-*.txt'), recursive=True):
        ids.update(l.strip() for l in open(f) if l.strip() and not l.startswith('#'))
    r, v = len(rounds), len(ids)
    ok_rounds = r < a.max_rounds
    ok_videos = v + a.planned <= a.max_videos
    print(json.dumps({'roundsDispatched': r, 'maxRounds': a.max_rounds, 'uniqueVideos': v,
                      'plannedVideos': a.planned, 'maxVideos': a.max_videos,
                      'videosRemaining': max(0, a.max_videos - v),
                      'canDispatch': ok_rounds and ok_videos}, ensure_ascii=False))
    sys.exit(0 if ok_rounds and ok_videos else 3)


if __name__ == '__main__':
    main()
