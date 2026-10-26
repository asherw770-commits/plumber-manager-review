# Three real clients, one fake cloud (needs a browser; not part of the gate)
`cloud.js` is a small in-memory Firestore over HTTP (:8766) that also runs the REAL `api/order.js` and `api/classify.js`.
`stub2.js` replaces the Firebase module in a copy of index.html so each browser tab runs the real app against that cloud. Security rules (`firestore.rules`) are NOT simulated — only data flow and merging.

```
python3 tests/e2e-3users/build.py /tmp/e2e                      # builds /tmp/e2e/e2e.html (+ assets)
node tests/e2e-3users/cloud.js &                                 # fictional sample books (SEED=<backup.json> for others)
cd /tmp/e2e && for p in 8765 8767 8768; do python3 -m http.server $p --bind 127.0.0.1 & done
# three tabs = three phones (separate origins → separate local storage):
#   http://127.0.0.1:8765/e2e.html?role=admin   http://127.0.0.1:8767/e2e.html?role=owner   http://127.0.0.1:8768/e2e.html?role=manager
curl -X POST localhost:8766/reset -d '{"direct":false}'          # reset the cloud; direct:true = "יהודה מכניס בעצמו"
```
Clear each origin's localStorage after a reset (a tab keeps its own copy and will push newer local edits back).

## Scenarios run on 26.10 (all converged to the same state in the three tabs)
1. **Queue mode:** Yehuda marks job A paid and B partly paid; Asher meanwhile edits A's notes, C's total, D's notes → after the merge A = paid + Asher's note, B partial, C/D as Asher edited; owner and manager show the identical rows.
2. **Yehuda offline:** his phone loses the network, he marks D paid, the network returns → the payment reaches the queue within ~30 s (retry back-off) and Asher's merge keeps Asher's note on D.
3. **Classification link:** Asher creates the link, Yehuda lists and marks two work names (one with a new category), a stranger's token is refused (403), Asher marks a third name at the same time → the map holds all three (no overwrite), all three tabs show the same categories and report.
4. **Direct mode (yehudaDirect):** Yehuda adds a job and pays job A; Asher at the same second edits A's notes, B's total and adds his own job → 242 rows everywhere, nothing lost, both new jobs present, A = paid by Yehuda + Asher's note, B = Yehuda's note + Asher's total.
Also ran earlier (12.10): customer order → push → Yehuda's queue → Asher's merge → all three converge.
