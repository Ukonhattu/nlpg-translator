# Natural Language to Python Translator (TypeScript)

Build a TypeScript library plus simple CLI that translates a beginner-friendly natural language "program" into Python using Aalto AI.

## Goals
- [x] Scaffold a TypeScript project structure (src, bin, tsconfig, package.json).
- [x] Implement minimal program parser: whole file -> single Block[] (for now, Block = whole file).
- [x] Implement rule-based linter for v0 language (vars, print, if/else, repeat N times, while condition).
- [x] Implement Aalto AI translation client and translateProgram() pipeline.
- [x] Implement CLI wrapper (nlp2py) that reads a file and outputs Python or errors.

## Verification
- Example NL file translates to reasonable Python. (Requires valid AALTO_API_KEY in environment.)
- Linter catches undefined variables and ambiguous conditions.
- CLI exits non-zero on lint errors.

## Notes
- v0: single block per file; variables global.
- Use strict, simple patterns for conditions and updates.
