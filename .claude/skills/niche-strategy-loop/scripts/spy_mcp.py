#!/usr/bin/env python3
"""Gọi Writer Room Spy MCP qua endpoint local của daemon (vẫn là Spy MCP — nguồn chính thức).

  spy_mcp.py call <tool> '<json args>'            # 1 lệnh, in JSON kết quả
  spy_mcp.py search <queries.txt> --lang en --region US [--limit 50] [--refresh if_stale|always|never]

`search` gọi spy_global_video_search cho từng dòng, chỉ in 1 dòng tóm tắt/query
(provider, số kết quả, cache, fallbackReason). Kết quả đầy đủ nằm trong SQLite
(search_query_cache / search_video_cache) — đọc bằng analyze_queries.py.
Không in token. Daemon phải đang chạy (mặc định http://127.0.0.1:4187).
"""
import argparse, json, os, sys, urllib.request

BASE = os.environ.get('WRITER_ROOM_URL', 'http://127.0.0.1:4187')


class Mcp:
    def __init__(self):
        info = json.load(urllib.request.urlopen(BASE + '/api/spy/mcp', timeout=10))
        self.url = info.get('ephemeralUrl') or info['url']
        self.h = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                  'Authorization': 'Bearer ' + info['token']}
        self.sid = None
        self.n = 0
        self._post({'jsonrpc': '2.0', 'id': self._id(), 'method': 'initialize',
                    'params': {'protocolVersion': '2025-03-26', 'capabilities': {},
                               'clientInfo': {'name': 'niche-strategy-loop', 'version': '1'}}})
        self._post({'jsonrpc': '2.0', 'method': 'notifications/initialized'})

    def _id(self):
        self.n += 1
        return self.n

    def _post(self, body, timeout=300):
        h = dict(self.h)
        if self.sid:
            h['mcp-session-id'] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(body).encode(), h), timeout=timeout)
        self.sid = r.headers.get('mcp-session-id') or self.sid
        raw = r.read().decode()
        for line in raw.splitlines():
            if line.startswith('data:'):
                raw = line[5:]
        return json.loads(raw) if raw.strip() else None

    def call(self, tool, args):
        res = self._post({'jsonrpc': '2.0', 'id': self._id(), 'method': 'tools/call',
                          'params': {'name': tool, 'arguments': args}})
        if 'error' in res:
            raise RuntimeError(json.dumps(res['error']))
        txt = res['result']['content'][0]['text']
        try:
            return json.loads(txt)
        except ValueError:
            return txt


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('call'); c.add_argument('tool'); c.add_argument('args', nargs='?', default='{}')
    s = sub.add_parser('search'); s.add_argument('file')
    s.add_argument('--lang', required=True); s.add_argument('--region', required=True)
    s.add_argument('--limit', type=int, default=50); s.add_argument('--refresh', default='if_stale')
    a = ap.parse_args()
    m = Mcp()
    if a.cmd == 'call':
        print(json.dumps(m.call(a.tool, json.loads(a.args)), ensure_ascii=False, indent=1))
        return
    qs = [l.strip() for l in open(a.file) if l.strip() and not l.startswith('#')]
    for q in qs:
        try:
            d = m.call('spy_global_video_search', {'query': q, 'limit': a.limit, 'language': a.lang,
                                                   'region': a.region, 'refresh': a.refresh})
            vids = d.get('videos', d.get('results', []))
            print(f"{q} | {d.get('providerUsed')} | n={len(vids)} | cache={(d.get('cache') or {}).get('status')} | fallback={d.get('fallbackReason')}")
        except Exception as e:  # tiếp tục query khác, báo lỗi rõ
            print(f"{q} | ERROR {e}")
        sys.stdout.flush()


if __name__ == '__main__':
    main()
