# Security

Please do not post credentials, raw participant material, production addresses, personal plant datasets or exploitable account-isolation details in a public issue. Use GitHub's private vulnerability reporting when available, or contact the maintainer through a private channel before sharing sensitive reproduction details.

The current cloud version requires HTTPS for production, scopes resources by account and stores OSS objects privately. Administrators have global access. A sensor registration secret authenticates a plaintext TCP connection and does not encrypt it; keep the listener on a protected network.

The historical LAN and cloud demonstration tags have no multi-user protection. They are preserved for design history and should remain on trusted isolated networks.

Keep secrets and runtime data outside Git, rotate any exposed secret immediately, maintain supported dependencies and test backups before relying on them.
