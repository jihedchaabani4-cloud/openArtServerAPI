# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`docs/agents/GLOSSARY.md`**: canonical single-context domain and architectural vocabulary for all 8 Business Systems.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

## File structure

Single-context repo:

```
/
├── docs/
│   ├── agents/
│   │   └── GLOSSARY.md
│   └── adr/
│       ├── 0001-folder-deletion-trashes-workflows.md
│       └── ...
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/agents/GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0005 (pure black-box workflow engine), but worth reopening because…_
