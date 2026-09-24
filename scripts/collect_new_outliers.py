import json
import subprocess
import time

KEYWORDS = [
    "retirement",
    "mortgage payoff",
    "FIRE",
    "dividend income",
    "frugal habits",
    "money habits",
    "net worth milestones",
    "stealth wealth",
    "cost of living",
    "401k",
    "index funds",
    "quiet luxury",
    "underconsumption"
]

def call_vidiq(tool, args):
    cmd = ['node', 'scripts/vidiq-mcp-server.cjs', 'call', tool, json.dumps(args)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(res.stdout)
    except Exception as e:
        print(f"Error calling {tool}: {e}, stdout: {res.stdout[:200]}")
        return {}

def main():
    all_videos = {}
    print("Starting outlier search across keywords...")
    for kw in KEYWORDS:
        print(f"Querying keyword: '{kw}'...")
        res = call_vidiq('vidiq_outliers', {
            'keyword': kw,
            'contentType': 'long',
            'minOutlierScore': 3.0,
            'maxSubscribers': 500000,
            'publishedWithin': 'threeMonths',
            'language': 'en',
            'limit': 25,
            'sort': 'breakoutScore'
        })
        vids = res.get('videos', [])
        print(f"  -> Found {len(vids)} videos for '{kw}'")
        for v in vids:
            vid_id = v.get('videoId')
            if not vid_id:
                continue
            if vid_id not in all_videos:
                v['search_keyword'] = kw
                all_videos[vid_id] = v
        time.sleep(0.5)

    print(f"Total unique outlier candidate videos found: {len(all_videos)}")
    with open('scripts/raw_new_outliers.json', 'w') as f:
        json.dump(list(all_videos.values()), f, indent=2)
    print("Saved candidates to scripts/raw_new_outliers.json")

if __name__ == '__main__':
    main()
