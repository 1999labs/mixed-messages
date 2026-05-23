## Mixed Messages
Mixed Messages is a participatory generative art project

## Code Structure
```
salt-cuts/
├── README.md
├── LICENSE
├── recursivesubdivision.js      # Canonical JS reference — vanilla, zero deps
├── demos/
│   ├── sample_output.html       # Static saved render
│   └── playground.html          # Browser playground for trying inputs
├── solidity/
│   ├── SaltCutsRenderer.sol     # Solidity port (integer math, on-chain SVG)
│   └── test/
│       └── RendererParity.t.sol # Hash-fixture parity tests vs JS reference
└── react/
    └── ContourRenderer.tsx      # React + Canvas wrapper for embedding in apps
```

## License
[MIT](./LICENSE)



