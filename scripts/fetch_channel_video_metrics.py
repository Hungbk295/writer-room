import json
import subprocess
import statistics
import concurrent.futures
import os

def process_channel(ch):
    cid = ch['id']
    url = f"https://www.youtube.com/channel/{cid}/videos"
    try:
        cmd = ['yt-dlp', '--flat-playlist', '--print', '%(duration)s %(view_count)s', '-I', '1:20', url]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        durations = []
        views = []
        for line in res.stdout.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2:
                d, v = parts[0], parts[1]
                if d.isdigit():
                    durations.append(int(d))
                if v.isdigit():
                    views.append(int(v))

        n_long = len(views)
        if n_long >= 10:
            med = round(float(statistics.median(views)), 1)
            avg_dur = int(statistics.mean(durations)) if durations else ''
        else:
            med = ''
            avg_dur = int(statistics.mean(durations)) if durations else ''

        return cid, {
            'long_count': n_long,
            'median_views': med,
            'long_avg_duration_sec': avg_dur
        }
    except Exception as e:
        return cid, {
            'long_count': 0,
            'median_views': '',
            'long_avg_duration_sec': ''
        }

def main():
    with open('scripts/all_115_channels_meta.json') as f:
        channels = json.load(f)

    print(f"Processing {len(channels)} channels with 16 threads...")
    metrics_cache = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as executor:
        results = executor.map(process_channel, channels)
        for cid, met in results:
            metrics_cache[cid] = met

    print(f"Done! Processed {len(metrics_cache)} channels.")
    with open('scripts/channel_video_metrics.json', 'w') as f:
        json.dump(metrics_cache, f, indent=2)

if __name__ == '__main__':
    main()
