# bettercf

A self-contained Codeforces contest cockpit for VS Code.

See [`cf-vscode/README.md`](cf-vscode/README.md) for installation, configuration and usage.

```bash
cd cf-vscode
npm install
npm test        # typecheck + bundle + headless checks (real g++ compile/run included)
```

Press **F5** in VS Code with `cf-vscode/` open to launch the Extension Development Host, or
`npm run package` to build an installable `.vsix`.
