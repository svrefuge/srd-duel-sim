# Manifest

- Release: `v1.0.0`
- Node: v26.10.0
- Creatures: 330; pairings per scenario: 54,285

## Sweeps

| Scenario | Separation cap | Run on | Fights |
|---|---:|---|---:|
| max30 | 30 ft | 2026-10-14 | 7,052,145 |
| max120 | 120 ft | 2026-10-14 | 7,175,749 |
| max600 | 600 ft | 2026-10-14 | 7,180,453 |

```
npm run compile
node src/cli.ts run --scenario max30 --iters 800 --adaptive --pilot 70 --target-se 0.02 --workers 9 --seed 1
node src/cli.ts rank --scenario max30
node src/cli.ts run --scenario max120 --iters 800 --adaptive --pilot 70 --target-se 0.02 --workers 9 --seed 1
node src/cli.ts rank --scenario max120
node src/cli.ts run --scenario max600 --iters 800 --adaptive --pilot 70 --target-se 0.02 --workers 9 --seed 1
node src/cli.ts rank --scenario max600
node tools/make-results.mjs
```

## Files

| File | Bytes | Rows | SHA-256 |
|---|---:|---:|---|
| `RANKINGS.md` | 29,539 |  | `4ca4cfd59d979004f0dc1faaf8370e2857517afa0a3d846556b2b717c9840ae2` |
| `README.md` | 3,392 |  | `ccac61ce89c49765863aa7da31c1cd1412505e57ca6dfe1190a54534b2efd845` |
| `coverage.md` | 22,848 |  | `77efad57c15d218aacaf9606f2b7ac814aea6e49c3775846761c5c6d64027d38` |
| `matrix-max120.csv` | 769,043 | 330 | `05dba94de52b93676df04948632e5aa8bd5be69c945287cba7cc6f0725556a2c` |
| `matrix-max30.csv` | 769,043 | 330 | `139b9a64d1cca4ab298f05c549ba2c481aa4dac106165e5953f6cf8f2dc53789` |
| `matrix-max600.csv` | 769,043 | 330 | `c63ff8d37c2f30e9a5c85b491ca57debbe6fc93ae164161499efa8abe402441d` |
| `pairs-max120.csv` | 3,318,140 | 54285 | `d5247a7e2fbd06cbbc6f1787b7950d516ca8b8c4e7aca7690f46bc21222d7000` |
| `pairs-max30.csv` | 3,316,139 | 54285 | `71796a4fecd9f66ce1eb3dd23f50206bea337b424f8b97d0d7035d6c5c1783d5` |
| `pairs-max600.csv` | 3,318,244 | 54285 | `f86c8eba901f2de86ad5ba2a7609cb71f15e14a15931f8633f8eaf7c54815db5` |
| `plots/cr-vs-rank-max120.svg` | 65,607 |  | `9fd6cdfa895d21b2e2db3d2af13df55bb918935183a0a4dd5891d8e73df52576` |
| `plots/cr-vs-rank-max30.svg` | 65,636 |  | `1f07c0b582e0890d74b04e6e292d2ef7ce2a9e9127acef19ea08b9814d96cb49` |
| `plots/cr-vs-rank-max600.svg` | 65,623 |  | `4affc646c0c16b00af4b3d9924fdb618b806bf1bba9c9443a693f33945f6e0cb` |
| `plots/elo-vs-cr-max120.svg` | 62,125 |  | `2f04c78b87446686cdc79149ea110512c1944248a75c82bdf4f3e457a01da9ef` |
| `plots/elo-vs-cr-max30.svg` | 62,013 |  | `238ce5ed39e4d04381a690bfe6a60503e2ebe1a2e4c2735b25625a5a2eed21dd` |
| `plots/elo-vs-cr-max600.svg` | 62,119 |  | `0e4126f7dc6d708c7c2c2bff93a47304124cf7d5876f60378adde5ab0efb9802` |
| `plots/over-under-cr.svg` | 12,357 |  | `97f00784aaab0471d71f13219b1aceff911492195c8a18df8e515526e7194fd5` |
| `plots/rank-shift.svg` | 63,127 |  | `20f802eaa031a269fc6606ddc770dd30954fbdb4f9611674626dc0f7f0ef2623` |
| `rankings.csv` | 24,357 | 330 | `547df546f702b514f4f7420d1cc77a7943c58fb6cba78e196713117f26305b5c` |
| `statblocks.json` | 1,410,673 |  | `51b1faa855287b08cfc6fbf255fa39bcd9602f528dc7958d50f5934e5899491c` |
