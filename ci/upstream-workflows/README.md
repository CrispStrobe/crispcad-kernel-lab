# Archived upstream workflows (inactive)

These GitHub Actions workflows came from upstream kernelCAD. They deploy to and
publish under upstream infrastructure (kernelcad.com, npm `kernelcad`, hosted MCP),
so CrispCAD keeps them out of `.github/workflows`, where GitHub would run them.
Run the equivalent checks locally (`npm run typecheck`, `npm test`, `npm run lint`).
Restore a workflow only after re-pointing it at CrispCAD infrastructure.
