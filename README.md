## Rendering Algorithm

A deterministic recursive-subdivision art algorithm that turns an array of (x, y) coordinates into a four-color mosaic. Same inputs always produce the same output, byte-for-byte, across JavaScript, Solidity, and React/Canvas.

Originally built for [Mixed Messages](https://mixedmessages.fyi), a participatory art project where each day's collective interpretations of a single word are rendered as a 1/1 onchain NFT.

Mixed Messages is a cultura commentary on the internet's divisiveness. Every [algorithmic decision](./MANIFESTO.md) is in service of making that legible as art, not data visualization.

## What it does

You give it:
- An array of points in `[0, 1] × [0, 1]` — interpreted as positions on a 2×2 grid (the project's axes: **Uniting / Dividing** on Y, **Performed / Honest** on X).
- A `prompt` string — used as the PRNG seed.

It returns a fully-colored mosaic of rectangles in one of four pastel colors, one per grid quadrant. The shape of the mosaic encodes the *distribution* of the points: tight clusters refine the canvas into one color family, contradictory inputs fracture it into competing colors.

The output is deterministic: same points + same prompt = identical pixels, every time, in every runtime.

## Color 

| Quadrant | Color |
|---|---|
| Honest + Uniting | `#55FF55` |
| Honest + Dividing | `#5555FF` |
| Performed + Uniting | `#55FFFF` |
| Performed + Dividing | `#FF5555` |

## How it works

Three passes:

1. **Base layer** — Each point cuts one of the existing regions in two. 20% of the time the region is picked area-weighted at random; 80% by Euclidean closeness to the point. The cut direction is biased by which axis the point is more extreme on, and the cut position by how extreme the point is overall. Paint side is a PRNG coin flip. Submissions are shuffled deterministically (Fisher-Yates seeded by the prompt) so first-mover doesn't dominate.

2. **Full-coverage landlock** — Every remaining white region is recolored using a count-weighted distribution across the four quadrant colors, with the *local* matching color discounted to 30% of its weight. Result: dominant-quadrant colors spread across the canvas but get pushed *away* from their own corners. No white survives.

3. **Salt post-pass** — `K = ceil(10 × 120 / (20 + sqrt(N)))` tiny boxes (capped at 300) are scattered at prompt-seeded positions. K peaks at low N (when salt carries the visual interest) and falls off at high N. Each salt op is a double-cut producing a small rect at one corner of a randomly-chosen region. Salt color uses the same count-weighted + locally-discounted picker as landlock.

Painted regions blend toward white at 95% color + 5% white for a printed-paper feel.

## Code Structure
```
salt-cuts/
├── README.md
├── LICENSE
├── recursivesubdivision.js      # Canonical JS reference — vanilla, zero deps
├── demos/
│   └── playground.html          # Browser playground for trying inputs
├── solidity/
│   ├── Renderer.sol     # Solidity port (integer math, on-chain SVG)
│   └── test/
│       └── RendererParity.t.sol # Hash-fixture parity tests vs JS reference
└── react/
    └── ContourRenderer.tsx      # React + Canvas wrapper for embedding in apps
```

## Usage

### Plain JavaScript

```html
<canvas id="art" width="600" height="600"></canvas>
<script src="recursivesubdivision.js"></script>
<script>
  const points = [
    { x: 0.2, y: 0.3 },
    { x: 0.7, y: 0.6 },
    { x: 0.9, y: 0.1 },
    // ... up to ~thousands
  ];
  const ctx = document.getElementById('art').getContext('2d');
  renderSubdivision(ctx, 600, 600, points, 'your prompt here');
</script>
```

Node:

```js
const { renderSubdivision, computeRegions } = require('./recursivesubdivision');
const regions = computeRegions(points, 'enough');
// regions: [{ x, y, w, h, r, g, b }, ...] in [0, 10000] coordinate space
```

### Solidity

```solidity
import { Renderer } from "./Renderer.sol";

Renderer renderer = new Renderer();

// xs, ys are uint16[] in [0, 10000] coordinate space
string memory svg = renderer.renderSVG(xs, ys, "your prompt here");
```

Run the parity tests to verify your build matches the JS reference byte-for-byte:

```bash
forge test --match-contract RendererParityTest
```

### React

```tsx
import { ContourRenderer } from "./ContourRenderer";

<ContourRenderer
  points={[{ x: 0.2, y: 0.3 }, ...]}
  prompt="your prompt here"
/>
```

## Try it

Open [`demos/playground.html`](demos/playground.html) in any browser. Adjust the prompt, swap distributions (Even, Heavy Cluster, Two Clusters, etc.), drag the count slider, and watch the algorithm respond in real time.

## Determinism

The algorithm uses:
- **FNV-1a 32-bit** for hashing the prompt into the PRNG seed.
- **Numerical Recipes LCG** for the PRNG itself (`s = s * 1664525 + 1013904223`).
- **Integer arithmetic** throughout — no floating point in the cuts, no Newton's-method `isqrt` collisions, no library random.

This is what makes the three ports byte-equivalent. The Solidity port mirrors the JS implementation operation-for-operation; the parity tests pin the equivalence with `keccak256(JS_output) == keccak256(Solidity_output)` fixtures.

## License

[MIT](./LICENSE)


