# Three real clients, one fake cloud (needs a browser; not part of the gate)
`cloud.js` is a small in-memory Firestore over HTTP (:8766) that also runs the REAL `api/order.js` for customer orders.
`stub2.js` replaces the Firebase module in a copy of index.html (see tests/ui-harness/build.py → `e2e.html`) so each browser tab runs the real app against that cloud.
1. `node cloud.js`; serve the harness folder on three ports (8765 admin, 8767 owner, 8768 manager — separate origins = separate local storage).
2. Open `e2e.html?role=admin|owner|manager` on each; reset the cloud with `POST /reset {"direct":false|true}` (direct = "יהודה מכניס בעצמו").
3. Drive: POST a customer to `/api/order`; convert as Yehuda; edit as Asher meanwhile; `_mergeOwnerActions()` on Asher's tab; compare states.
Verified 12.10: order reaches all three → Yehuda's queue → Asher's merge → manager/owner converge; concurrent edits (queue mode and direct mode) both survive.
Security rules (firestore.rules) are NOT simulated.
