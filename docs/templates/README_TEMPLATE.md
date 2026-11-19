# <Project Display Name> (`<package-name>` `v<MAJOR.MINOR.PATCH>`)

**Languages:** **English ([README.md](./README.md))** | **[한국어 (README.ko.md)](./README.ko.md)**

<One-paragraph formal summary of the official Antigravity Native Plugin + Sidecar architecture, supported runtime environments, and core capabilities.>

---

## Table of Contents

1. [Overview & Key Features](#overview--key-features)
2. [System Requirements & Compatibility](#system-requirements--compatibility)
3. [Native Plugin Installation](#native-plugin-installation)
4. [Configuration & Ports & Adapters Architecture](#configuration--ports--adapters-architecture)
5. [Repository Structure](#repository-structure)
6. [Verification & Testing](#verification--testing)
7. [License](#license)

---

## Overview & Key Features

- **<Feature 1 Title>**: <Formal technical description.>
- **<Feature 2 Title>**: <Formal technical description.>

---

## System Requirements & Compatibility

- **Node.js**: `>= 20.0.0`
- **Supported Host Versions**: `<Supported Antigravity Native Plugin Host Version Range>`

---

## Native Plugin Installation

```bash
git clone https://github.com/<owner>/<repo>.git
cd <repo>
npm ci --omit=dev
npm run install-plugin
```

---

## Configuration & Ports & Adapters Architecture

<Description of vendor-neutral `src/core/` and `src/ui/` boundaries and isolated host adapters under `src/adapters/`.>

---

## Repository Structure

```text
<repo>/
├── plugin.json
├── sidecars/
├── src/
│   ├── core/
│   ├── adapters/
│   └── ui/
├── scripts/
│   └── install-plugin.mjs
├── docs/
│   ├── ARCHITECTURE_V3.md
│   ├── TEST_CASES.md
│   └── templates/
│       ├── README_TEMPLATE.md
│       └── RELEASE_NOTES_TEMPLATE.md
├── test/
├── README.md
├── README.ko.md
├── RELEASE_NOTES.md
├── LICENSE
└── package.json
```

---

## Verification & Testing

```bash
npm ci
npm test
```

## License

MIT
