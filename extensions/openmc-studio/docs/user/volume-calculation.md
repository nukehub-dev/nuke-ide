# Volume Calculation

The Volume Calculation window runs OpenMC's stochastic volume estimation over the current model — useful for normalizing reaction rates, checking CAD-derived volumes, and feeding material volumes into depletion.

---

## Opening

- **Command Palette:** `Ctrl+Shift+P` → **"OpenMC Studio: Volume Calculation"**
- **Menu:** `Tools → OpenMC Studio → Advanced → Volume Calculation`

---

## Configuration

| Setting                 | Description                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| **Domain Type**         | Estimate volumes of **Cells**, **Materials**, or **Universes**                                   |
| **Domains**             | Checklist of domains from the current model to include                                           |
| **Samples**             | Number of stochastic samples (default 1,000,000 — more samples, tighter uncertainties)           |
| **Bounding Box**        | Sampling region. Let OpenMC auto-detect bounds, or set explicit lower-left / upper-right corners |
| **Convergence Trigger** | Optional early stop: standard deviation, variance, or relative error below a threshold           |

Click **Run** to generate the XML inputs and execute the volume calculation.

---

## Results

The results table shows, per domain: the estimated volume (cm³) with its standard deviation and an atom-count estimate. For material domains, **Adopt Volumes into Materials** writes the computed volumes back into the material definitions — the volumes depletion uses for burnup normalization.

> **Tip:** If a domain's uncertainty stays large, raise the sample count or add a convergence trigger and let the run stop itself.
