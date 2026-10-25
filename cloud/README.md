# SAMA · cloud gateway demonstration v0.1.0

This preserved prototype moves the collector from a local computer to a server. An FTX-W80 gateway opens an outbound TCP connection and identifies itself with the legacy `LOAM:<id>` registration packet. The browser shows live observations and a small local JSON history, with CSV export.

Use Node.js 20+, run `node server.mjs` from this directory and inspect the source for its web/TCP environment settings. The root `lib/` modules are required.

**Historical demonstration only.** This stage has no multi-user authentication or ownership isolation. The registration packet is not secure device authentication. Keep it on a trusted isolated network; use the current warehouse version for further development.

This source snapshot was recovered from the original project package. Operational addresses, runtime data and credentials are excluded from the public history. This is a reconstruction at publication time, not an assertion of original commit dates.
