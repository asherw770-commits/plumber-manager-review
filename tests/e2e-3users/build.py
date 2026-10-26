#!/usr/bin/env python3
"""Builds e2e.html (the real app talking to the fake cloud in cloud.js) into OUT_DIR.
    python3 tests/e2e-3users/build.py /tmp/e2e
Then:  node tests/e2e-3users/cloud.js            (fake Firestore + api/order + api/classify on :8766)
       cd /tmp/e2e && for p in 8765 8767 8768; do python3 -m http.server $p --bind 127.0.0.1 & done
Open  http://127.0.0.1:8765/e2e.html?role=admin   http://127.0.0.1:8767/e2e.html?role=owner   http://127.0.0.1:8768/e2e.html?role=manager
(three ports = three origins = three separate local storages = three phones)."""
import os, re, shutil, sys, time
here = os.path.dirname(os.path.abspath(__file__)); app = os.path.abspath(os.path.join(here, '..', '..'))
out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'e2e-out'); os.makedirs(out, exist_ok=True)
s = open(os.path.join(app, 'index.html'), encoding='utf8').read()
i = s.index('<script type="module">'); j = s.index('</script>', i) + len('</script>')
s = s[:i] + '<script>' + open(os.path.join(here, 'stub2.js'), encoding='utf8').read() + '</script>' + s[j:]
s = re.sub(r'ui2\.css\?v=[0-9a-z]+', 'ui2.css?t=' + str(int(time.time())), s)
open(os.path.join(out, 'e2e.html'), 'w', encoding='utf8').write(s)
for f in os.listdir(app):
    if f.endswith(('.webp', '.png', '.jpg', '.svg', '.json')) or f == 'ui2.css':
        shutil.copy(os.path.join(app, f), os.path.join(out, f))
print('built', out)
