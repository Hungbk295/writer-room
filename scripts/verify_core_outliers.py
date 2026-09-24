import json
import subprocess
import statistics
import time
import re

def main():
    with open('scripts/raw_new_outliers.json') as f:
        candidates = json.load(f)

    with open('scripts/existing_50_videos_meta.json') as f:
        old_vids = json.load(f)
    old_ids = {v['id'] for v in old_vids}

    # Strict negative keywords for non-US or non-finance
    non_us = [
        'india', 'indian', 'rupee', 'lakh', 'crore', 'nifty', 'australia', 'aussie', 
        'uk ', 'british', 'hdb', 'cpf', 'singapore', 'canada', 'canadian', 'south africa', 
        'rand', 'nigeria', 'kenya', 'philippines', 'thailand', 'naga', 'bengali', 'tamil',
        'nepal', 'germany', 'france', 'spain', 'malaysia', 'indonesia'
    ]
    non_fin = [
        'fire crew', 'caught fire', 'wildfire', 'structure fire', 'rain on window', 
        'ambience', 'jazz', 'calories', 'bible', 'church', 'sermon', 'gospel', 'christ', 
        'pastor', 'allah', 'quran', 'roblox', 'minecraft', 'gta', 'pokemon', 'anime', 
        'kpop', 'asmr', 'comedy pilot', 'flatshare', 'dating', 'makeup', 'outfit',
        'skincare', 'haircut', 'bodybuilding', 'gym workout', 'dieting', 'weight loss'
    ]

    # Positive topic patterns
    fin_patterns = [
        r'\b(retire|retirement|pension|401k|ira|roth|social security)\b',
        r'\b(frugal|frugality|underconsum|underconsumption|cheap|save money|saving money|waste money|wasting money)\b',
        r'\b(money habits|wealth habits|habits of the wealthy|habits of millionaires|middle class|poor)\b',
        r'\b(dividend|dividends|index fund|index funds|etf|invest|investing|portfolio|compound interest|stock market|vanguard|fidelity)\b',
        r'\b(mortgage|debt|pay off|payoff|renting vs buying|house poor|home buying)\b',
        r'\b(net worth|milestone|milestones|fire|financial independence|stealth wealth|quiet luxury|budget|budgeting)\b',
        r'\b(wealth|rich|financial freedom|build wealth|broke|cash flow)\b'
    ]

    scored_candidates = []
    seen_vids = set()

    for c in candidates:
        vid = c.get('videoId')
        if not vid or vid in old_ids or vid in seen_vids:
            continue
        dur = c.get('videoDuration') or 0
        if dur < 300: # < 5 min
            continue
        subs = c.get('subscriberCount') or 0
        if subs > 500000:
            continue
        country = c.get('channelCountry', '')
        if country in ['IN', 'PK', 'BD', 'NG', 'KE', 'PH', 'GH', 'ZA']:
            continue
            
        title = c.get('videoTitle', '')
        ch_title = c.get('channelTitle', '')
        t_lower = title.lower()
        ch_lower = ch_title.lower()
        
        if any(k in t_lower or k in ch_lower for k in non_fin):
            continue
        if any(k in t_lower or k in ch_lower for k in non_us):
            continue
            
        # Must match at least one positive finance topic pattern
        if not any(re.search(pat, t_lower) for pat in fin_patterns):
            continue
            
        seen_vids.add(vid)
        scored_candidates.append(c)

    print(f"Total curated core candidates: {len(scored_candidates)}")
    
    # Sort candidates by breakout score descending
    scored_candidates.sort(key=lambda x: x.get('breakoutScore') or 0, reverse=True)

    verified_core = []
    channel_cache = {}

    print("Verifying channel medians & true outlier ratio...")
    for idx, c in enumerate(scored_candidates):
        if len(verified_core) >= 70:
            print(f"Reached {len(verified_core)} verified core outliers!")
            break

        vid = c['videoId']
        cid = c['channelId']
        views = c.get('viewCount') or 0
        
        if cid in channel_cache:
            ch_data = channel_cache[cid]
        else:
            url = f"https://www.youtube.com/channel/{cid}/videos"
            try:
                cmd = ['yt-dlp', '--flat-playlist', '--print', '%(view_count)s', '-I', '1:20', url]
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
                ch_views = [int(x) for x in res.stdout.splitlines() if x.strip() and x.strip().isdigit()]
                n_long = len(ch_views)
                if n_long >= 10:
                    med = round(float(statistics.median(ch_views)), 1)
                else:
                    med = None
                channel_cache[cid] = {'long_count': n_long, 'median': med}
                ch_data = channel_cache[cid]
            except Exception as e:
                print(f"  [warn] yt-dlp failed for {cid}: {e}")
                channel_cache[cid] = {'long_count': 0, 'median': None}
                ch_data = channel_cache[cid]

        med = ch_data['median']
        if med is None or med <= 0:
            continue # < 10 long videos or median 0
            
        true_ratio = round(views / med, 2)
        if true_ratio >= 3.0:
            c['calculated_channel_median'] = med
            c['calculated_outlier_ratio'] = true_ratio
            c['calculated_long_count'] = ch_data['long_count']
            verified_core.append(c)
            print(f"[{len(verified_core)}/70] {c['channelTitle']} | Ratio: {true_ratio}x (Views: {views}, Med: {med}) | {c['videoTitle'][:60]}")
        else:
            # Not an outlier by true median definition
            pass

    print(f"\nSuccessfully verified {len(verified_core)} core outlier videos with true outlier_ratio >= 3.0!")
    with open('scripts/verified_core_outliers.json', 'w') as f:
        json.dump(verified_core, f, indent=2)

if __name__ == '__main__':
    main()
