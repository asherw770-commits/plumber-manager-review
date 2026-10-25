# Offline copy of the app for looking at the screens

Nothing here touches the real database: Firebase is replaced by a local stub (`stub.js`) that serves the books from `data.json` and ignores writes.

```
python3 tests/ui-harness/build.py /tmp/h            # builds /tmp/h/index.html + assets + fictional sample books
cd /tmp/h && python3 -m http.server 8775
```
Open `http://localhost:8775/index.html?role=admin` (also `role=owner` = the business owner's phone view, `role=manager` = the read-only advisor; `&access=dashboard,collection,...` limits the owner's tabs).

* To look at other books: `python3 tests/ui-harness/build.py /tmp/h my-backup.json` (any file in the app's JSON backup format).
* `node tests/sample-data.js file.json 500 3` writes bigger / different fictional books (rows, seed).
* `dump.js` + `saver.py` + `compare.py` were used once to prove that the 12.10 redesign shows every number the old look showed (`?dump=1`); they are not needed for review.
