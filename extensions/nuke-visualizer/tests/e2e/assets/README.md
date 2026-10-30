# Analysis E2E Assets

`depletion_results.h5` is a real single-material activation result (material
`Cell 1`, initial state plus one 1-day step). The contact-dose and
decay-spectrum e2e tests read it with `OPENMC_CHAIN_FILE` so they exercise
OpenMC's decay-photon chain data instead of a synthetic fixture.
