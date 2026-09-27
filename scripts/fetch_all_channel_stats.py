import json
import subprocess
import time
import os

def call_vidiq(tool, args):
    cmd = ['node', 'scripts/vidiq-mcp-server.cjs', 'call', tool, json.dumps(args)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(res.stdout)
    except Exception as e:
        return {}

def main():
    with open('scripts/all_115_channels_meta.json') as f:
        channels = json.load(f)

    stats_cache = {}
    if os.path.exists('scripts/all_channel_stats.json'):
        try:
            with open('scripts/all_channel_stats.json') as f:
                stats_cache = json.load(f)
        except Exception:
            pass

    print(f"Total channels to process: {len(channels)}, already cached: {len(stats_cache)}")

    for idx, ch in enumerate(channels, 1):
        cid = ch['id']
        if cid in stats_cache:
            continue
            
        print(f"[{idx}/{len(channels)}] Fetching stats for {ch['title']} ({cid})...")
        res = call_vidiq('vidiq_channel_stats', {'channelId': cid})
        if res and 'currentStats' in res:
            stats_cache[cid] = res
        else:
            stats_cache[cid] = {}
        time.sleep(0.2)
        
        if len(stats_cache) % 20 == 0:
            with open('scripts/all_channel_stats.json', 'w') as f:
                json.dump(stats_cache, f, indent=2)

    with open('scripts/all_channel_stats.json', 'w') as f:
        json.dump(stats_cache, f, indent=2)
    print(f"Done! Cached stats for {len(stats_cache)} channels.")

if __name__ == '__main__':
    main()
