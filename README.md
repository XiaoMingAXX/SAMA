# SAMA · LAN prototype

**Soil Analysis and Monitoring Array** — an Innovation by Design project exploring how soil observations can support plant-care decisions.

This first preserved stage is the **LOAM Soil Studio** LAN prototype: a bilingual browser dashboard, simulated observations, Modbus RTU soil-probe communication through an FTX-W80 Wi-Fi bridge, CSV export and gateway configuration tools.

## Run

Use Node.js 20 or later. No npm dependencies are required.

```sh
npm start
```

Open `http://localhost:3000`. Start in simulation mode. The application has no account authentication and is intended for a trusted local network; do not expose it to the internet. Hardware settings depend on the exact probe and gateway model.

```sh
npm test
```

## About this snapshot

This commit was reconstructed at publication time from the existing packaged LAN prototype. It does not claim to reproduce the original development commit dates. The project was originally named LOAM in the interface; the wider design project is published as SAMA.

The software displays measurements, not validated growing recommendations. Supported registers, calibration, substrate contact and sensor accuracy need verification with the actual hardware.

MIT licensed; see [LICENSE](LICENSE).
